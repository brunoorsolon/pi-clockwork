import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatInterval } from "../parse";
import type { ClockworkScheduler } from "../scheduler";
import type { ClockworkStore } from "../store";
import type { ClockworkJob } from "../types";

const STATUS_KEY = "pi-clockwork";

export function formatRemaining(ms: number): string {
	const total = Math.max(0, Math.ceil(ms / 1000));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = total % 60;
	if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`;
	if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
	return `${seconds}s`;
}

export function describeJob(job: ClockworkJob, scheduler?: ClockworkScheduler): string {
	const next = scheduler?.nextFire(job.id) ?? job.nextAt;
	const nextText = job.status === "active" ? `next ${formatRemaining(next - Date.now())}` : job.status;
	const runs = job.maxRuns ? `${job.fireCount}/${job.maxRuns}` : `${job.fireCount}`;
	const lock = job.runLock ? ` · ${job.runLock.state}` : "";
	const skipped = job.skipCount ? ` · skipped ${job.skipCount}` : "";
	return `#${job.id} ${job.name} · ${formatInterval(job.intervalMs)} · ${nextText} · runs ${runs}${lock}${skipped}`;
}

export class ClockworkStatus {
	private ticker: ReturnType<typeof setInterval> | undefined;
	private ctx: ExtensionContext | undefined;

	constructor(
		private readonly store: ClockworkStore,
		private readonly getScheduler: () => ClockworkScheduler | undefined,
	) {}

	setContext(ctx: ExtensionContext): void {
		this.ctx = ctx;
		this.render();
	}

	render(): void {
		const ctx = this.ctx;
		if (!ctx?.hasUI) return;
		const active = this.store.listActive();
		if (active.length === 0) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			ctx.ui.setWidget(STATUS_KEY, undefined);
			this.stopTicker();
			return;
		}
		const scheduler = this.getScheduler();
		const nearest = Math.min(...active.map((job) => scheduler?.nextFire(job.id) ?? job.nextAt));
		ctx.ui.setStatus(STATUS_KEY, `♥ clockwork · ${active.length} active · ${formatRemaining(nearest - Date.now())}`);
		ctx.ui.setWidget(
			STATUS_KEY,
			active.slice(0, 8).map((job) => `♥ ${describeJob(job, scheduler)}`),
			{ placement: "aboveEditor" },
		);
		this.startTicker();
	}

	clear(): void {
		this.ctx?.ui.setStatus(STATUS_KEY, undefined);
		this.ctx?.ui.setWidget(STATUS_KEY, undefined);
		this.stopTicker();
	}

	stopTicker(): void {
		if (this.ticker) clearInterval(this.ticker);
		this.ticker = undefined;
	}

	private startTicker(): void {
		if (this.ticker) return;
		this.ticker = setInterval(() => this.render(), 1_000);
		(this.ticker as { unref?: () => void }).unref?.();
	}
}
