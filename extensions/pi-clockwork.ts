import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerCommands, type CommandDeps } from "../src/commands";
import { ClockworkRunner } from "../src/runner";
import { ClockworkScheduler } from "../src/scheduler";
import { ClockworkStore, defaultStorePath } from "../src/store";
import { registerTools } from "../src/tools";
import { ClockworkStatus } from "../src/ui/status";

export default function piClockwork(pi: ExtensionAPI) {
	const ownerId = `${process.pid}:${randomUUID()}`;
	let latestCtx: ExtensionContext | undefined;
	let started = false;
	let ownsLease = false;
	let leaseTicker: ReturnType<typeof setInterval> | undefined;

	const store = new ClockworkStore({ ownerId, path: defaultStorePath(process.cwd()) });
	let scheduler!: ClockworkScheduler;
	let runner!: ClockworkRunner;
	const status = new ClockworkStatus(store, () => scheduler);

	const onChanged = () => status.render();

	runner = new ClockworkRunner({
		pi,
		store,
		getContext: () => latestCtx,
		onRunFinished: (jobId) => scheduler.onRunFinished(jobId),
		onChanged,
	});

	scheduler = new ClockworkScheduler({
		store,
		fire: (jobId, scheduledAt, reason) => runner.tryStartRun(jobId, scheduledAt, reason),
		onChanged,
	});

	const deps: CommandDeps = { pi, store, scheduler, runner, onChanged };
	registerCommands(deps);
	registerTools(deps);

	function capture(ctx: ExtensionContext): void {
		latestCtx = ctx;
		status.setContext(ctx);
		ensureStarted(ctx);
	}

	function ensureStarted(ctx: ExtensionContext): void {
		if (started) return;
		started = true;
		store.load();
		ownsLease = store.claimLease();
		if (!ownsLease) {
			const lease = store.getLease();
			if (ctx.hasUI) ctx.ui.notify(`pi-clockwork jobs are owned by another Pi process (${lease?.pid ?? "unknown"}). Management works, timers are paused here.`, "warning");
			status.render();
			return;
		}
		store.clearStaleLocks();
		scheduler.start();
		startLeaseTicker(ctx);
		status.render();
	}

	function startLeaseTicker(ctx: ExtensionContext): void {
		if (leaseTicker) return;
		leaseTicker = setInterval(() => {
			ownsLease = store.refreshLease();
			if (!ownsLease) {
				scheduler.stop();
				ctx.ui.notify("pi-clockwork lost its owner lease; timers stopped in this session.", "warning");
			}
		}, 10_000);
		(leaseTicker as { unref?: () => void }).unref?.();
	}

	pi.on("session_start", async (_event, ctx) => capture(ctx));
	pi.on("turn_start", async (_event, ctx) => capture(ctx));
	pi.on("before_agent_start", async (event, ctx) => {
		capture(ctx);
		runner.onBeforeAgentStart(event.prompt);
	});
	pi.on("agent_end", async (_event, ctx) => {
		capture(ctx);
		runner.onAgentEnd();
	});
	pi.on("input", (event, ctx) => {
		capture(ctx);
		if (event.source === "interactive") status.render();
		return { action: "continue" };
	});
	pi.on("session_shutdown", async () => {
		scheduler.stop();
		status.clear();
		if (leaseTicker) clearInterval(leaseTicker);
		leaseTicker = undefined;
		if (ownsLease) store.releaseLease();
	});
}
