import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatInterval, parseIntervalMs } from "./parse";
import type { CommandDeps } from "./commands";
import type { OverlapPolicy, ClockworkAction } from "./types";

function textResult(message: string, details?: unknown): AgentToolResult<unknown> {
	return { content: [{ type: "text", text: message }], details };
}

function parsePolicy(value: unknown): OverlapPolicy | undefined {
	if (value === undefined) return undefined;
	if (value === "drop" || value === "coalesce" || value === "queueOne") return value;
	return undefined;
}

function normalizeAction(input: Record<string, unknown>): ClockworkAction {
	const type = input.type;
	if (type === "prompt") {
		if (typeof input.text !== "string") throw new Error("prompt action requires text.");
		return { type: "prompt", text: input.text };
	}
	if (type === "compact") return { type: "compact", instructions: typeof input.instructions === "string" ? input.instructions : undefined };
	if (type === "newSession") return { type: "newSession", kickoff: typeof input.kickoff === "string" ? input.kickoff : undefined };
	if (type === "slash") {
		if (typeof input.command !== "string" || !input.command.startsWith("/")) throw new Error("slash action requires command starting with /.");
		return { type: "slash", command: input.command };
	}
	if (type === "shell") {
		if (typeof input.command !== "string") throw new Error("shell action requires command.");
		return {
			type: "shell",
			command: input.command,
			cwd: typeof input.cwd === "string" ? input.cwd : undefined,
			timeoutMs: typeof input.timeoutMs === "number" ? input.timeoutMs : undefined,
			maxOutputBytes: typeof input.maxOutputBytes === "number" ? input.maxOutputBytes : undefined,
			attachOutput: input.attachOutput === true,
			allowFailure: input.allowFailure === true,
		};
	}
	throw new Error(`Unknown action type "${String(type)}".`);
}

export function registerTools(deps: CommandDeps): void {
	const actionSchema = Type.Object({
		type: Type.String({ enum: ["prompt", "compact", "newSession", "slash", "shell"] }),
		text: Type.Optional(Type.String()),
		instructions: Type.Optional(Type.String()),
		kickoff: Type.Optional(Type.String()),
		command: Type.Optional(Type.String()),
		cwd: Type.Optional(Type.String()),
		timeoutMs: Type.Optional(Type.Number()),
		maxOutputBytes: Type.Optional(Type.Number()),
		attachOutput: Type.Optional(Type.Boolean()),
		allowFailure: Type.Optional(Type.Boolean()),
	});

	deps.pi.registerTool({
		name: "ClockworkCreate",
		label: "ClockworkCreate",
		description: "Create a durable recurring pi-clockwork job with exact second/minute/hour intervals and ordered actions.",
		promptSnippet: "Create recurring prompt/compact/new-session/shell jobs without raw sleep loops.",
		promptGuidelines: [
			"Use ClockworkCreate for repeated or scheduled work instead of Bash sleep/while loops.",
			"ClockworkCreate should set maxRuns for polling tasks unless the user explicitly wants an open-ended job.",
			"ClockworkCreate should prefer typed compact and newSession actions over synthetic /compact or /new slash commands.",
		],
		parameters: Type.Object({
			name: Type.Optional(Type.String({ description: "Human-readable job name." })),
			interval: Type.String({ description: "Interval such as 1s, 30 seconds, 10m, or 2h." }),
			maxRuns: Type.Optional(Type.Number({ description: "Stop after this many actual runs." })),
			overlapPolicy: Type.Optional(Type.String({ enum: ["drop", "coalesce", "queueOne"] })),
			prompt: Type.Optional(Type.String({ description: "Shortcut for a single prompt action." })),
			actions: Type.Optional(Type.Array(actionSchema)),
		}),
		async execute(_toolCallId, params) {
			try {
				const actions = params.actions?.length
					? params.actions.map((action) => normalizeAction(action as Record<string, unknown>))
					: params.prompt
						? ([{ type: "prompt", text: params.prompt }] as ClockworkAction[])
						: [];
				if (actions.length === 0) throw new Error("Provide prompt or actions.");
				const job = deps.store.create({
					name: params.name,
					intervalMs: parseIntervalMs(params.interval),
					maxRuns: params.maxRuns,
					overlapPolicy: parsePolicy(params.overlapPolicy),
					actions,
				});
				deps.scheduler.arm(job.id);
				deps.onChanged(job.id);
				return textResult(`Clockwork job #${job.id} created (${job.name}) every ${formatInterval(job.intervalMs)}.`, { job });
			} catch (error) {
				return textResult(error instanceof Error ? error.message : String(error));
			}
		},
	});

	deps.pi.registerTool({
		name: "ClockworkList",
		label: "ClockworkList",
		description: "List pi-clockwork jobs with status, next fire, run counts, and last result.",
		parameters: Type.Object({}),
		async execute() {
			const jobs = deps.store.list();
			if (jobs.length === 0) return textResult("No pi-clockwork jobs configured.", { jobs: [] });
			const lines = jobs.map((job) => {
				const next = deps.scheduler.nextFire(job.id) ?? job.nextAt;
				const runs = job.maxRuns ? `${job.fireCount}/${job.maxRuns}` : `${job.fireCount}`;
				return `#${job.id} [${job.status}] ${job.name} every ${formatInterval(job.intervalMs)} next ${new Date(next).toISOString()} runs ${runs}`;
			});
			return textResult(lines.join("\n"), { jobs });
		},
	});

	deps.pi.registerTool({
		name: "ClockworkControl",
		label: "ClockworkControl",
		description: "Pause, resume, stop, delete, or run a pi-clockwork job now.",
		parameters: Type.Object({
			id: Type.String({ description: "Job id, or all for stop/delete/pause/resume." }),
			action: Type.String({ enum: ["pause", "resume", "stop", "delete", "run-now"] }),
		}),
		async execute(_toolCallId, params) {
			const ids = params.id === "all" ? deps.store.list().map((job) => job.id) : [params.id];
			let changed = false;
			for (const id of ids) {
				if (params.action === "pause") changed = deps.scheduler.pause(id) || changed;
				if (params.action === "resume") changed = deps.scheduler.resume(id) || changed;
				if (params.action === "stop") changed = deps.scheduler.stopJob(id) || changed;
				if (params.action === "delete") changed = deps.scheduler.deleteJob(id) || changed;
				if (params.action === "run-now") changed = deps.scheduler.runNow(id) || changed;
			}
			deps.onChanged(params.id === "all" ? undefined : params.id);
			return textResult(changed ? `Clockwork ${params.action} applied to ${params.id}.` : `No matching active job for ${params.id}.`);
		},
	});
}

export type ToolRegistrationTarget = ExtensionAPI;
