import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { describeJob } from "./status";
import type { ClockworkScheduler } from "../scheduler";
import type { ClockworkStore } from "../store";
import type { ClockworkJob } from "../types";

export interface ManagerController {
	store: ClockworkStore;
	scheduler: ClockworkScheduler;
	runNow(id: string): boolean;
	pause(id: string): boolean;
	resume(id: string): boolean;
	stop(id: string): boolean;
	delete(id: string): boolean;
	inspect(id: string): string;
}

function truncate(value: string, width: number): string {
	if (value.length <= width) return value;
	return `${value.slice(0, Math.max(0, width - 1))}…`;
}

function keyName(data: string): string {
	if (data === "\x1b[A") return "up";
	if (data === "\x1b[B") return "down";
	if (data === "\r" || data === "\n") return "enter";
	if (data === "\x1b") return "escape";
	return data;
}

class ClockworkManagerComponent {
	private selected = 0;

	constructor(
		private readonly tui: TUI,
		private readonly controller: ManagerController,
		private readonly done: () => void,
		private readonly notify: (message: string, type?: "info" | "warning" | "error") => void,
	) {}

	render(width: number): string[] {
		const jobs = this.controller.store.list();
		const innerWidth = Math.max(20, width - 4);
		const lines: string[] = [];
		lines.push(`┌${"─".repeat(Math.min(innerWidth, 100))}┐`);
		lines.push(`│ ${truncate("pi-clockwork manager — ↑/↓ select · r run · p pause/resume · s stop · d delete · i inspect · q close", innerWidth - 1).padEnd(innerWidth - 1)}│`);
		lines.push(`├${"─".repeat(Math.min(innerWidth, 100))}┤`);
		if (jobs.length === 0) {
			lines.push(`│ ${"No jobs configured.".padEnd(innerWidth - 1)}│`);
		} else {
			this.selected = Math.min(this.selected, jobs.length - 1);
			for (let index = 0; index < Math.min(12, jobs.length); index++) {
				const job = jobs[index]!;
				const prefix = index === this.selected ? "›" : " ";
				lines.push(`│${prefix} ${truncate(describeJob(job, this.controller.scheduler), innerWidth - 2).padEnd(innerWidth - 2)}│`);
			}
			const job = jobs[this.selected];
			if (job) {
				lines.push(`├${"─".repeat(Math.min(innerWidth, 100))}┤`);
				for (const detail of this.details(job)) {
					lines.push(`│ ${truncate(detail, innerWidth - 1).padEnd(innerWidth - 1)}│`);
				}
			}
		}
		lines.push(`└${"─".repeat(Math.min(innerWidth, 100))}┘`);
		return lines.map((line) => truncate(line, width));
	}

	handleInput(data: string): void {
		const jobs = this.controller.store.list();
		const key = keyName(data);
		if (key === "escape" || key === "q") {
			this.done();
			return;
		}
		if (key === "up" || key === "k") this.selected = Math.max(0, this.selected - 1);
		else if (key === "down" || key === "j") this.selected = Math.min(Math.max(0, jobs.length - 1), this.selected + 1);
		else this.handleAction(key, jobs[this.selected]);
		this.tui.requestRender();
	}

	invalidate(): void {}

	private handleAction(key: string, job: ClockworkJob | undefined): void {
		if (!job) return;
		if (key === "r") this.notify(this.controller.runNow(job.id) ? `Ran #${job.id}.` : `Could not run #${job.id}.`, "info");
		if (key === "p") {
			if (job.status === "paused") this.notify(this.controller.resume(job.id) ? `Resumed #${job.id}.` : `Could not resume #${job.id}.`, "info");
			else this.notify(this.controller.pause(job.id) ? `Paused #${job.id}.` : `Could not pause #${job.id}.`, "info");
		}
		if (key === "s") this.notify(this.controller.stop(job.id) ? `Stopped #${job.id}.` : `Could not stop #${job.id}.`, "info");
		if (key === "d") this.notify(this.controller.delete(job.id) ? `Deleted #${job.id}.` : `Could not delete #${job.id}.`, "info");
		if (key === "i") this.notify(this.controller.inspect(job.id), "info");
	}

	private details(job: ClockworkJob): string[] {
		const actions = job.actions.map((action) => action.type).join(" → ");
		return [
			`actions: ${actions}`,
			`policy: ${job.overlapPolicy} · skipped: ${job.skipCount} · coalesced: ${job.coalescedCount}`,
			`last: ${job.lastError ?? job.lastResult ?? "none"}`,
		];
	}
}

export async function openManager(ctx: ExtensionCommandContext, controller: ManagerController): Promise<void> {
	if (ctx.mode === "tui") {
		await ctx.ui.custom<void>(
			(tui, _theme, _keybindings, done) => new ClockworkManagerComponent(tui, controller, () => done(), (message, type) => ctx.ui.notify(message, type)),
			{
				overlay: true,
				overlayOptions: { width: "90%", maxHeight: "80%", anchor: "center", margin: 1 },
			},
		);
		return;
	}

	const jobs = controller.store.list();
	if (jobs.length === 0) {
		ctx.ui.notify("No pi-clockwork jobs configured.", "info");
		return;
	}
	const choice = await ctx.ui.select("pi-clockwork jobs", [
		...jobs.map((job) => `#${job.id} ${job.name} (${job.status})`),
		"Close",
	]);
	if (!choice || choice === "Close") return;
	const id = choice.slice(1).split(/\s+/)[0];
	const action = await ctx.ui.select(`Job #${id}`, ["run-now", "pause/resume", "stop", "delete", "inspect", "Close"]);
	if (action === "run-now") controller.runNow(id);
	if (action === "pause/resume") {
		const job = controller.store.get(id);
		if (job?.status === "paused") controller.resume(id);
		else controller.pause(id);
	}
	if (action === "stop") controller.stop(id);
	if (action === "delete") controller.delete(id);
	if (action === "inspect") ctx.ui.notify(controller.inspect(id), "info");
}
