import type { ClockworkJob } from "./types";
import type { ClockworkStore } from "./store";

export interface TimerHandle {}

export interface SchedulerClock {
	now(): number;
	setTimeout(callback: () => void, delayMs: number): TimerHandle;
	clearTimeout(handle: TimerHandle): void;
}

export interface SchedulerOptions {
	store: ClockworkStore;
	fire: (jobId: string, scheduledAt: number, reason: "timer" | "manual" | "queued") => boolean;
	clock?: SchedulerClock;
	onChanged?: (jobId?: string) => void;
}

const realClock: SchedulerClock = {
	now: () => Date.now(),
	setTimeout(callback, delayMs) {
		const timer = setTimeout(callback, delayMs);
		(timer as { unref?: () => void }).unref?.();
		return timer;
	},
	clearTimeout(handle) {
		clearTimeout(handle as ReturnType<typeof setTimeout>);
	},
};

export class ClockworkScheduler {
	private readonly store: ClockworkStore;
	private readonly fireRun: SchedulerOptions["fire"];
	private readonly clock: SchedulerClock;
	private readonly onChanged?: (jobId?: string) => void;
	private timers = new Map<string, TimerHandle>();

	constructor(options: SchedulerOptions) {
		this.store = options.store;
		this.fireRun = options.fire;
		this.clock = options.clock ?? realClock;
		this.onChanged = options.onChanged;
	}

	start(): void {
		this.stop();
		for (const job of this.store.listActive()) this.arm(job.id);
		this.onChanged?.();
	}

	stop(): void {
		for (const timer of this.timers.values()) this.clock.clearTimeout(timer);
		this.timers.clear();
	}

	arm(jobId: string): void {
		this.disarm(jobId);
		const job = this.store.get(jobId);
		if (!job || job.status !== "active") return;
		if (this.hasReachedMax(job)) {
			this.store.update(job.id, { status: "expired", lastResult: "Reached maxRuns." }, this.clock.now());
			this.onChanged?.(job.id);
			return;
		}
		const delayMs = Math.max(0, job.nextAt - this.clock.now());
		const timer = this.clock.setTimeout(() => this.onTimer(job.id), delayMs);
		this.timers.set(job.id, timer);
	}

	disarm(jobId: string): void {
		const timer = this.timers.get(jobId);
		if (timer) this.clock.clearTimeout(timer);
		this.timers.delete(jobId);
	}

	runNow(jobId: string): boolean {
		const job = this.store.get(jobId);
		if (!job || job.status !== "active") return false;
		return this.fireRun(job.id, this.clock.now(), "manual");
	}

	pause(jobId: string): boolean {
		this.disarm(jobId);
		const updated = this.store.update(jobId, { status: "paused" }, this.clock.now());
		this.onChanged?.(jobId);
		return Boolean(updated);
	}

	resume(jobId: string): boolean {
		const job = this.store.get(jobId);
		if (!job) return false;
		const now = this.clock.now();
		const nextAt = job.nextAt <= now ? now + job.intervalMs : job.nextAt;
		this.store.update(jobId, { status: "active", nextAt, lastError: undefined }, now);
		this.arm(jobId);
		this.onChanged?.(jobId);
		return true;
	}

	stopJob(jobId: string): boolean {
		this.disarm(jobId);
		const updated = this.store.update(jobId, { status: "stopped" }, this.clock.now());
		this.onChanged?.(jobId);
		return Boolean(updated);
	}

	deleteJob(jobId: string): boolean {
		this.disarm(jobId);
		const removed = this.store.delete(jobId);
		this.onChanged?.(jobId);
		return removed;
	}

	onRunFinished(jobId: string): void {
		const job = this.store.get(jobId);
		if (!job || job.status !== "active") {
			this.disarm(jobId);
			this.onChanged?.(jobId);
			return;
		}
		if (this.hasReachedMax(job)) {
			this.disarm(jobId);
			this.store.update(job.id, { status: "expired", lastResult: "Reached maxRuns." }, this.clock.now());
			this.onChanged?.(jobId);
			return;
		}
		if (job.queuedRun) {
			this.store.update(job.id, { queuedRun: false }, this.clock.now());
			this.fireRun(job.id, this.clock.now(), "queued");
			this.onChanged?.(jobId);
			return;
		}
		this.arm(job.id);
		this.onChanged?.(jobId);
	}

	nextFire(jobId: string): number | undefined {
		const job = this.store.get(jobId);
		return job?.status === "active" ? job.nextAt : undefined;
	}

	private onTimer(jobId: string): void {
		this.timers.delete(jobId);
		const job = this.store.get(jobId);
		if (!job || job.status !== "active") return;
		if (this.hasReachedMax(job)) {
			this.store.update(job.id, { status: "expired", lastResult: "Reached maxRuns." }, this.clock.now());
			this.onChanged?.(jobId);
			return;
		}

		const scheduledAt = job.nextAt;
		const nextAt = computeNextAt(job.nextAt, job.intervalMs, this.clock.now());
		this.store.update(job.id, { nextAt }, this.clock.now());
		this.arm(job.id);
		this.fireRun(job.id, scheduledAt, "timer");
		this.onChanged?.(jobId);
	}

	private hasReachedMax(job: ClockworkJob): boolean {
		return typeof job.maxRuns === "number" && job.fireCount >= job.maxRuns;
	}
}

export function computeNextAt(previousNextAt: number, intervalMs: number, now = Date.now()): number {
	let next = previousNextAt + intervalMs;
	while (next <= now) next += intervalMs;
	return next;
}
