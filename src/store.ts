import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
	DEFAULT_LEASE_MS,
	DEFAULT_LOCK_STALE_MS,
	STORE_VERSION,
	type CreateJobInput,
	type OwnerLease,
	type ClockworkAction,
	type ClockworkJob,
	type ClockworkStoreData,
	type RunRecord,
} from "./types";

export interface ClockworkStoreOptions {
	path?: string;
	cwd?: string;
	ownerId: string;
	leaseMs?: number;
	lockStaleMs?: number;
	maxRunRecords?: number;
}

export function defaultStorePath(cwd = process.cwd()): string {
	const env = process.env.PI_CLOCKWORK_STORE;
	if (env) return isAbsolute(env) ? env : resolve(cwd, env);
	return join(cwd, ".pi", "clockwork", "jobs.json");
}

function emptyData(): ClockworkStoreData {
	return { version: STORE_VERSION, nextId: 1, jobs: [], runs: [] };
}

function isAction(value: unknown): value is ClockworkAction {
	if (!value || typeof value !== "object") return false;
	const action = value as Record<string, unknown>;
	return typeof action.type === "string";
}

function normalizeJob(raw: unknown): ClockworkJob | null {
	if (!raw || typeof raw !== "object") return null;
	const obj = raw as Record<string, unknown>;
	if (typeof obj.id !== "string") return null;
	if (typeof obj.intervalMs !== "number" || obj.intervalMs < 1_000) return null;
	if (!Array.isArray(obj.actions) || !obj.actions.every(isAction)) return null;
	const now = Date.now();
	return {
		id: obj.id,
		name: typeof obj.name === "string" && obj.name ? obj.name : `clockwork-${obj.id}`,
		scope: obj.scope === "session" || obj.scope === "global" ? obj.scope : "workspace",
		target: typeof obj.target === "string" ? obj.target : "current-session",
		intervalMs: obj.intervalMs,
		nextAt: typeof obj.nextAt === "number" ? obj.nextAt : now + obj.intervalMs,
		maxRuns: typeof obj.maxRuns === "number" ? obj.maxRuns : undefined,
		fireCount: typeof obj.fireCount === "number" ? obj.fireCount : 0,
		skipCount: typeof obj.skipCount === "number" ? obj.skipCount : 0,
		coalescedCount: typeof obj.coalescedCount === "number" ? obj.coalescedCount : 0,
		queuedRun: obj.queuedRun === true,
		status:
			obj.status === "active" || obj.status === "paused" || obj.status === "stopped" || obj.status === "expired" || obj.status === "error"
				? obj.status
				: "active",
		overlapPolicy: obj.overlapPolicy === "coalesce" || obj.overlapPolicy === "queueOne" ? obj.overlapPolicy : "drop",
		actions: obj.actions,
		createdAt: typeof obj.createdAt === "number" ? obj.createdAt : now,
		updatedAt: typeof obj.updatedAt === "number" ? obj.updatedAt : now,
		lastRunAt: typeof obj.lastRunAt === "number" ? obj.lastRunAt : undefined,
		lastResult: typeof obj.lastResult === "string" ? obj.lastResult : undefined,
		lastError: typeof obj.lastError === "string" ? obj.lastError : undefined,
		runLock: obj.runLock && typeof obj.runLock === "object" ? (obj.runLock as ClockworkJob["runLock"]) : undefined,
	};
}

export class ClockworkStore {
	readonly path: string;
	readonly ownerId: string;
	private data: ClockworkStoreData = emptyData();
	private readonly leaseMs: number;
	private readonly lockStaleMs: number;
	private readonly maxRunRecords: number;

	constructor(options: ClockworkStoreOptions) {
		this.path = options.path ?? defaultStorePath(options.cwd);
		this.ownerId = options.ownerId;
		this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
		this.lockStaleMs = options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS;
		this.maxRunRecords = options.maxRunRecords ?? 100;
		this.load();
	}

	load(): void {
		if (!existsSync(this.path)) {
			this.data = emptyData();
			return;
		}
		try {
			const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<ClockworkStoreData> & { schedules?: unknown[] };
			const rawJobs = Array.isArray(parsed.jobs) ? parsed.jobs : Array.isArray(parsed.schedules) ? parsed.schedules : [];
			const jobs = rawJobs.map(normalizeJob).filter((job): job is ClockworkJob => Boolean(job));
			const runs = Array.isArray(parsed.runs) ? (parsed.runs.filter((r) => r && typeof r === "object") as RunRecord[]) : [];
			this.data = {
				version: STORE_VERSION,
				nextId: typeof parsed.nextId === "number" && parsed.nextId > 0 ? parsed.nextId : this.inferNextId(jobs),
				ownerLease: parsed.ownerLease,
				jobs,
				runs: runs.slice(-this.maxRunRecords),
			};
		} catch {
			this.data = emptyData();
		}
	}

	save(): void {
		mkdirSync(dirname(this.path), { recursive: true });
		const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
		writeFileSync(tmp, JSON.stringify(this.data, null, 2));
		renameSync(tmp, this.path);
	}

	claimLease(now = Date.now()): boolean {
		this.load();
		const current = this.data.ownerLease;
		if (current && current.ownerId !== this.ownerId && current.expiresAt > now) return false;
		this.data.ownerLease = this.makeLease(now);
		this.save();
		return true;
	}

	refreshLease(now = Date.now()): boolean {
		this.load();
		const current = this.data.ownerLease;
		if (current && current.ownerId !== this.ownerId && current.expiresAt > now) return false;
		this.data.ownerLease = this.makeLease(now);
		this.save();
		return true;
	}

	releaseLease(): void {
		this.load();
		if (this.data.ownerLease?.ownerId === this.ownerId) {
			delete this.data.ownerLease;
			this.save();
		}
	}

	getLease(): OwnerLease | undefined {
		return this.data.ownerLease;
	}

	clearStaleLocks(now = Date.now()): string[] {
		const cleared: string[] = [];
		for (const job of this.data.jobs) {
			if (job.runLock && now - job.runLock.startedAt > this.lockStaleMs) {
				cleared.push(job.id);
				delete job.runLock;
				job.queuedRun = false;
				job.lastError = "Cleared stale run lock on startup.";
				job.updatedAt = now;
			}
		}
		if (cleared.length > 0) this.save();
		return cleared;
	}

	create(input: CreateJobInput, now = Date.now()): ClockworkJob {
		const id = String(this.data.nextId++);
		const job: ClockworkJob = {
			id,
			name: input.name?.trim() || `clockwork-${id}`,
			scope: "workspace",
			target: "current-session",
			intervalMs: input.intervalMs,
			nextAt: input.nextAt ?? now + input.intervalMs,
			maxRuns: input.maxRuns,
			fireCount: 0,
			skipCount: 0,
			coalescedCount: 0,
			queuedRun: false,
			status: "active",
			overlapPolicy: input.overlapPolicy ?? "drop",
			actions: input.actions,
			createdAt: now,
			updatedAt: now,
		};
		this.data.jobs.push(job);
		this.save();
		return job;
	}

	list(): ClockworkJob[] {
		return [...this.data.jobs].sort((a, b) => Number(a.id) - Number(b.id));
	}

	listActive(): ClockworkJob[] {
		return this.list().filter((job) => job.status === "active");
	}

	get(id: string): ClockworkJob | undefined {
		return this.data.jobs.find((job) => job.id === id);
	}

	getByRunId(runId: string): ClockworkJob | undefined {
		return this.data.jobs.find((job) => job.runLock?.runId === runId);
	}

	update(id: string, patch: Partial<ClockworkJob>, now = Date.now()): ClockworkJob | undefined {
		const job = this.get(id);
		if (!job) return undefined;
		Object.assign(job, patch, { updatedAt: now });
		this.save();
		return job;
	}

	mutate(id: string, fn: (job: ClockworkJob) => void, now = Date.now()): ClockworkJob | undefined {
		const job = this.get(id);
		if (!job) return undefined;
		fn(job);
		job.updatedAt = now;
		this.save();
		return job;
	}

	delete(id: string): boolean {
		const before = this.data.jobs.length;
		this.data.jobs = this.data.jobs.filter((job) => job.id !== id);
		const changed = this.data.jobs.length !== before;
		if (changed) this.save();
		return changed;
	}

	recordRun(record: RunRecord): void {
		this.data.runs.push(record);
		if (this.data.runs.length > this.maxRunRecords) this.data.runs = this.data.runs.slice(-this.maxRunRecords);
		this.save();
	}

	listRuns(jobId?: string): RunRecord[] {
		const runs = jobId ? this.data.runs.filter((run) => run.jobId === jobId) : this.data.runs;
		return [...runs];
	}

	private makeLease(now: number): OwnerLease {
		return { ownerId: this.ownerId, pid: process.pid, hostname: hostname(), startedAt: now, expiresAt: now + this.leaseMs };
	}

	private inferNextId(jobs: ClockworkJob[]): number {
		const max = jobs.reduce((highest, job) => Math.max(highest, Number.parseInt(job.id, 10) || 0), 0);
		return max + 1;
	}
}
