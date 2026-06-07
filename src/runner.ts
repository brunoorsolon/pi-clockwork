import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { renderTemplate } from "./parse";
import { runShellAction, summarizeShellResult } from "./actions/shell";
import type { ClockworkStore } from "./store";
import type { CompactAction, NewSessionAction, PromptAction, ClockworkJob, ShellAction, SlashAction } from "./types";

const PROMPT_PREFIX_RE = /^\[pi-clockwork run:([^\s\]]+) job:([^\s\]]+) name:([^\]]*)\]/;

export interface ClockworkRunnerOptions {
	pi: ExtensionAPI;
	store: ClockworkStore;
	getContext: () => ExtensionContext | undefined;
	onRunFinished: (jobId: string) => void;
	onChanged?: (jobId?: string) => void;
}

export class ClockworkRunner {
	private readonly pi: ExtensionAPI;
	private readonly store: ClockworkStore;
	private readonly getContext: () => ExtensionContext | undefined;
	private readonly onRunFinished: (jobId: string) => void;
	private readonly onChanged?: (jobId?: string) => void;
	private readonly extras = new Map<string, Record<string, string | number | undefined>>();

	constructor(options: ClockworkRunnerOptions) {
		this.pi = options.pi;
		this.store = options.store;
		this.getContext = options.getContext;
		this.onRunFinished = options.onRunFinished;
		this.onChanged = options.onChanged;
	}

	tryStartRun(jobId: string, scheduledAt: number, reason: "timer" | "manual" | "queued"): boolean {
		const job = this.store.get(jobId);
		if (!job || job.status !== "active") return false;
		if (job.runLock) return this.applyOverlap(job, reason);
		if (job.maxRuns && job.fireCount >= job.maxRuns) {
			this.store.update(job.id, { status: "expired", lastResult: "Reached maxRuns." });
			this.onChanged?.(job.id);
			return false;
		}

		const runId = randomUUID();
		this.store.mutate(job.id, (current) => {
			current.runLock = { runId, startedAt: Date.now(), actionIndex: 0, state: "running" };
			current.fireCount += 1;
			current.lastRunAt = scheduledAt;
			current.lastError = undefined;
			current.lastResult = `Run ${runId} started (${reason}).`;
		});
		this.store.recordRun({ runId, jobId: job.id, startedAt: Date.now(), status: "started", message: `Started by ${reason}.` });
		void this.executeNext(job.id, runId);
		this.onChanged?.(job.id);
		return true;
	}

	onBeforeAgentStart(prompt: string): void {
		const match = prompt.match(PROMPT_PREFIX_RE);
		if (!match) return;
		const [, runId, jobId] = match;
		const job = this.store.get(jobId);
		if (!job?.runLock || job.runLock.runId !== runId) return;
		if (job.runLock.state !== "waiting-agent-start") return;
		this.store.mutate(job.id, (current) => {
			if (!current.runLock) return;
			current.runLock.state = "waiting-agent-end";
			current.runLock.promptStarted = true;
		});
		this.onChanged?.(job.id);
	}

	onAgentEnd(): void {
		for (const job of this.store.list()) {
			const lock = job.runLock;
			if (!lock || lock.state !== "waiting-agent-end" || !lock.promptStarted) continue;
			this.advance(job.id, lock.runId);
		}
	}

	async handleInternalNew(runId: string, ctx: ExtensionCommandContext): Promise<void> {
		const job = this.store.getByRunId(runId);
		if (!job?.runLock) {
			ctx.ui.notify(`pi-clockwork run ${runId} not found.`, "warning");
			return;
		}
		const action = job.actions[job.runLock.actionIndex];
		if (!action || action.type !== "newSession") {
			ctx.ui.notify(`pi-clockwork run ${runId} is not waiting for newSession.`, "warning");
			return;
		}

		await ctx.waitForIdle();
		const renderedKickoff = action.kickoff ? this.render(action.kickoff, job, runId) : undefined;
		const parentSession = ctx.sessionManager.getSessionFile();
		const result = await ctx.newSession({
			parentSession,
			setup: async (sessionManager) => {
				sessionManager.appendCustomEntry("pi-clockwork:new-session", { runId, jobId: job.id, name: job.name, timestamp: Date.now() });
			},
			withSession: async (newCtx) => {
				await newCtx.sendMessage(
					{
						customType: "pi-clockwork",
						content: `pi-clockwork moved run ${runId} for job #${job.id} (${job.name}) into this new session.`,
						display: true,
						details: { runId, jobId: job.id },
					},
					{ deliverAs: "nextTurn" },
				);
				await newCtx.sendUserMessage(`/clockwork-internal-resume ${runId}`);
				if (renderedKickoff) await newCtx.sendUserMessage(renderedKickoff, { deliverAs: "followUp" });
			},
		});

		if (result.cancelled) this.failRun(job.id, runId, "New session was cancelled.");
	}

	handleInternalResume(runId: string, ctx: ExtensionCommandContext): void {
		const job = this.store.getByRunId(runId);
		if (!job?.runLock) {
			ctx.ui.notify(`pi-clockwork run ${runId} not found.`, "warning");
			return;
		}
		const action = job.actions[job.runLock.actionIndex];
		if (action?.type !== "newSession") {
			ctx.ui.notify(`pi-clockwork run ${runId} cannot resume from ${action?.type ?? "unknown"}.`, "warning");
			return;
		}
		this.advance(job.id, runId);
	}

	private applyOverlap(job: ClockworkJob, reason: "timer" | "manual" | "queued"): boolean {
		if (reason === "manual") return false;
		if (job.overlapPolicy === "drop") {
			this.store.mutate(job.id, (current) => {
				current.skipCount += 1;
				current.lastResult = "Tick skipped because the previous run is still active.";
			});
			this.onChanged?.(job.id);
			return false;
		}
		this.store.mutate(job.id, (current) => {
			current.queuedRun = true;
			if (current.overlapPolicy === "coalesce") current.coalescedCount += 1;
			if (current.runLock) current.runLock.missedCount = (current.runLock.missedCount ?? 0) + 1;
			current.lastResult = `Tick ${current.overlapPolicy === "coalesce" ? "coalesced" : "queued"} while run was active.`;
		});
		this.onChanged?.(job.id);
		return false;
	}

	private async executeNext(jobId: string, runId: string): Promise<void> {
		const job = this.store.get(jobId);
		const lock = job?.runLock;
		if (!job || !lock || lock.runId !== runId) return;
		const action = job.actions[lock.actionIndex];
		if (!action) {
			this.finishRun(job.id, runId, "Run completed.");
			return;
		}

		try {
			switch (action.type) {
				case "prompt":
					this.executePrompt(job, runId, action);
					return;
				case "slash":
					this.executeSlash(job, runId, action);
					return;
				case "compact":
					this.executeCompact(job, runId, action);
					return;
				case "newSession":
					this.executeNewSession(job, runId, action);
					return;
				case "shell":
					await this.executeShell(job, runId, action);
					return;
			}
		} catch (error) {
			this.failRun(job.id, runId, error instanceof Error ? error.message : String(error));
		}
	}

	private executePrompt(job: ClockworkJob, runId: string, action: PromptAction): void {
		const message = `[pi-clockwork run:${runId} job:${job.id} name:${job.name}]\n${this.render(action.text, job, runId)}`;
		this.store.mutate(job.id, (current) => {
			if (current.runLock) current.runLock.state = action.waitForAgent === false ? "running" : "waiting-agent-start";
		});
		this.sendUserMessage(message);
		if (action.waitForAgent === false) this.advance(job.id, runId);
		this.onChanged?.(job.id);
	}

	private executeSlash(job: ClockworkJob, runId: string, action: SlashAction): void {
		if (!action.command.startsWith("/")) throw new Error("Slash action must start with /.");
		const command = this.render(action.command, job, runId);
		if (action.waitForAgent) {
			this.store.mutate(job.id, (current) => {
				if (current.runLock) current.runLock.state = "waiting-agent-start";
			});
			this.sendUserMessage(`[pi-clockwork run:${runId} job:${job.id} name:${job.name}]\n${command}`);
			return;
		}
		this.sendUserMessage(command);
		this.advance(job.id, runId);
	}

	private executeCompact(job: ClockworkJob, runId: string, action: CompactAction): void {
		const ctx = this.getContext();
		if (!ctx) throw new Error("No Pi context available for compact action.");
		this.store.mutate(job.id, (current) => {
			if (current.runLock) current.runLock.state = "waiting-compact";
		});
		ctx.compact({
			customInstructions: action.instructions ? this.render(action.instructions, job, runId) : undefined,
			onComplete: () => this.advance(job.id, runId),
			onError: (error) => this.failRun(job.id, runId, error.message),
		});
		ctx.ui.notify(`pi-clockwork compact action started for #${job.id}.`, "info");
		this.onChanged?.(job.id);
	}

	private executeNewSession(job: ClockworkJob, runId: string, _action: NewSessionAction): void {
		this.store.mutate(job.id, (current) => {
			if (current.runLock) current.runLock.state = "waiting-new-session";
		});
		this.sendUserMessage(`/clockwork-internal-new ${runId}`);
		this.onChanged?.(job.id);
	}

	private async executeShell(job: ClockworkJob, runId: string, action: ShellAction): Promise<void> {
		const ctx = this.getContext();
		if (!ctx) throw new Error("No Pi context available for shell action.");
		this.store.mutate(job.id, (current) => {
			if (current.runLock) current.runLock.state = "running-shell";
		});
		const result = await runShellAction(
			{ ...action, command: this.render(action.command, job, runId) },
			ctx.cwd,
		);
		const summary = summarizeShellResult(result);
		this.pi.sendMessage(
			{
				customType: "pi-clockwork:shell",
				content: `# pi-clockwork shell action\n\nJob #${job.id} (${job.name})\n\n${summary}`,
				display: true,
				details: { runId, jobId: job.id, result },
			},
			{ deliverAs: "nextTurn" },
		);
		if (action.attachOutput) this.extras.set(runId, { ...(this.extras.get(runId) ?? {}), shellOutput: `${result.stdout}\n${result.stderr}`.trim() });
		if (!action.allowFailure && (result.timedOut || result.exitCode !== 0)) {
			this.failRun(job.id, runId, summary);
			return;
		}
		this.advance(job.id, runId, summary);
	}

	private advance(jobId: string, runId: string, lastResult?: string): void {
		const job = this.store.get(jobId);
		if (!job?.runLock || job.runLock.runId !== runId) return;
		this.store.mutate(job.id, (current) => {
			if (!current.runLock) return;
			current.runLock.actionIndex += 1;
			current.runLock.state = "running";
			current.runLock.promptStarted = false;
			if (lastResult) current.lastResult = lastResult;
		});
		void this.executeNext(job.id, runId);
	}

	private finishRun(jobId: string, runId: string, message: string): void {
		this.store.mutate(jobId, (current) => {
			delete current.runLock;
			current.lastResult = message;
			current.lastError = undefined;
		});
		this.store.recordRun({ runId, jobId, startedAt: Date.now(), endedAt: Date.now(), status: "success", message });
		this.extras.delete(runId);
		this.onChanged?.(jobId);
		this.onRunFinished(jobId);
	}

	private failRun(jobId: string, runId: string, message: string): void {
		this.store.mutate(jobId, (current) => {
			delete current.runLock;
			current.lastError = message;
			current.lastResult = `Run failed: ${message}`;
			current.status = "error";
		});
		this.store.recordRun({ runId, jobId, startedAt: Date.now(), endedAt: Date.now(), status: "error", message });
		this.extras.delete(runId);
		this.onChanged?.(jobId);
		this.onRunFinished(jobId);
	}

	private sendUserMessage(message: string): void {
		const ctx = this.getContext();
		const options = ctx && !ctx.isIdle() ? { deliverAs: "followUp" as const } : undefined;
		this.pi.sendUserMessage(message, options);
	}

	private render(input: string, job: ClockworkJob, runId: string): string {
		return renderTemplate(input, { job, runId, extra: this.extras.get(runId) });
	}
}
