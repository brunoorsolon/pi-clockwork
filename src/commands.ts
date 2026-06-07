import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { parseAddArgs } from "./parse";
import type { ClockworkRunner } from "./runner";
import type { ClockworkScheduler } from "./scheduler";
import type { ClockworkStore } from "./store";
import { describeJob } from "./ui/status";
import { openManager, type ManagerController } from "./ui/manager";

export interface CommandDeps {
	pi: ExtensionAPI;
	store: ClockworkStore;
	scheduler: ClockworkScheduler;
	runner: ClockworkRunner;
	onChanged: (jobId?: string) => void;
}

function firstWord(input: string): { command: string; rest: string } {
	const trimmed = input.trim();
	const match = trimmed.match(/^(\S+)\s*(.*)$/s);
	return { command: match?.[1]?.toLowerCase() ?? "", rest: match?.[2] ?? "" };
}

function completions(prefix: string): AutocompleteItem[] | null {
	if (/\s/.test(prefix)) return null;
	const items = ["add", "list", "status", "pause", "resume", "stop", "delete", "run-now", "inspect"];
	const matches = items.filter((item) => item.startsWith(prefix)).map((item) => ({ value: item, label: item }));
	return matches.length ? matches : null;
}

export function buildManagerController(deps: CommandDeps): ManagerController {
	return {
		store: deps.store,
		scheduler: deps.scheduler,
		runNow: (id) => deps.scheduler.runNow(id),
		pause: (id) => deps.scheduler.pause(id),
		resume: (id) => deps.scheduler.resume(id),
		stop: (id) => deps.scheduler.stopJob(id),
		delete: (id) => deps.scheduler.deleteJob(id),
		inspect: (id) => inspectJob(deps, id),
	};
}

export function registerCommands(deps: CommandDeps): void {
	const commandOptions = {
		description: "Manage recurring pi-clockwork jobs. Use /clockwork add --every 10m --prompt '...' or /clockwork for manager.",
		getArgumentCompletions: completions,
		handler: async (args: string, ctx: ExtensionCommandContext) => handleClockworkCommand(deps, args, ctx),
	};
	deps.pi.registerCommand("clockwork", commandOptions);
	deps.pi.registerCommand("cw", { ...commandOptions, description: "Alias for /clockwork." });

	deps.pi.registerCommand("clockwork-internal-new", {
		description: "Internal pi-clockwork command for scheduled new-session actions.",
		handler: async (args, ctx) => {
			const runId = args.trim();
			if (!runId) {
				ctx.ui.notify("Missing pi-clockwork run id.", "warning");
				return;
			}
			await deps.runner.handleInternalNew(runId, ctx);
		},
	});

	deps.pi.registerCommand("clockwork-internal-resume", {
		description: "Internal pi-clockwork command for resuming runs after session replacement.",
		handler: async (args, ctx) => {
			const runId = args.trim();
			if (!runId) {
				ctx.ui.notify("Missing pi-clockwork run id.", "warning");
				return;
			}
			deps.runner.handleInternalResume(runId, ctx);
		},
	});
}

async function handleClockworkCommand(deps: CommandDeps, args: string, ctx: ExtensionCommandContext): Promise<void> {
	const { command, rest } = firstWord(args);
	const controller = buildManagerController(deps);
	if (!command) {
		await openManager(ctx, controller);
		return;
	}

	if (command === "add" || command === "create") {
		try {
			const parsed = parseAddArgs(rest);
			const job = deps.store.create(parsed);
			deps.scheduler.arm(job.id);
			deps.onChanged(job.id);
			ctx.ui.notify(`pi-clockwork job #${job.id} (${job.name}) created.`, "info");
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
		return;
	}

	if (command === "list") {
		await openManager(ctx, controller);
		return;
	}

	if (command === "status") {
		showStatus(deps);
		return;
	}

	if (command === "pause" || command === "resume" || command === "stop" || command === "delete" || command === "run-now") {
		const id = rest.trim();
		if (!id) {
			ctx.ui.notify(`Usage: /clockwork ${command} <id|all>`, "warning");
			return;
		}
		const ok = controlJob(deps, command, id);
		ctx.ui.notify(ok ? `pi-clockwork ${command} ${id}.` : `No matching job for ${id}.`, ok ? "info" : "warning");
		return;
	}

	if (command === "inspect") {
		const id = rest.trim();
		if (!id) {
			ctx.ui.notify("Usage: /clockwork inspect <id>", "warning");
			return;
		}
		showInspect(deps, id);
		return;
	}

	ctx.ui.notify("Usage: /clockwork add|list|status|pause|resume|stop|delete|run-now|inspect", "warning");
}

function controlJob(deps: CommandDeps, command: string, id: string): boolean {
	const ids = id === "all" ? deps.store.list().map((job) => job.id) : [id];
	let changed = false;
	for (const jobId of ids) {
		if (command === "pause") changed = deps.scheduler.pause(jobId) || changed;
		if (command === "resume") changed = deps.scheduler.resume(jobId) || changed;
		if (command === "stop") changed = deps.scheduler.stopJob(jobId) || changed;
		if (command === "delete") changed = deps.scheduler.deleteJob(jobId) || changed;
		if (command === "run-now") changed = deps.scheduler.runNow(jobId) || changed;
	}
	deps.onChanged(id === "all" ? undefined : id);
	return changed;
}

function showStatus(deps: CommandDeps): void {
	const jobs = deps.store.list();
	const content = jobs.length
		? jobs.map((job) => describeJob(job, deps.scheduler)).join("\n")
		: "No pi-clockwork jobs configured.";
	deps.pi.sendMessage({ customType: "pi-clockwork", content, display: true, details: { count: jobs.length } }, { deliverAs: "nextTurn" });
}

function showInspect(deps: CommandDeps, id: string): void {
	deps.pi.sendMessage({ customType: "pi-clockwork", content: inspectJob(deps, id), display: true, details: { id } }, { deliverAs: "nextTurn" });
}

function inspectJob(deps: CommandDeps, id: string): string {
	const job = deps.store.get(id);
	if (!job) return `Job #${id} not found.`;
	const runs = deps.store
		.listRuns(id)
		.slice(-10)
		.map((run) => `- ${new Date(run.startedAt).toISOString()} [${run.status}] ${run.message}`)
		.join("\n");
	return [
		`# pi-clockwork job #${job.id}: ${job.name}`,
		"",
		describeJob(job, deps.scheduler),
		`actions: ${job.actions.map((action) => action.type).join(" → ")}`,
		`lastResult: ${job.lastResult ?? "none"}`,
		`lastError: ${job.lastError ?? "none"}`,
		"",
		"## Recent runs",
		runs || "No runs yet.",
	].join("\n");
}
