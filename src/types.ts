export const STORE_VERSION = 1;
export const DEFAULT_INTERVAL_MS = 60_000;
export const DEFAULT_LOCK_STALE_MS = 30 * 60_000;
export const DEFAULT_LEASE_MS = 30_000;
export const DEFAULT_SHELL_TIMEOUT_MS = 60_000;
export const DEFAULT_SHELL_MAX_OUTPUT_BYTES = 64_000;

export type JobStatus = "active" | "paused" | "stopped" | "expired" | "error";
export type OverlapPolicy = "drop" | "coalesce" | "queueOne";
export type RunState =
	| "running"
	| "waiting-agent-start"
	| "waiting-agent-end"
	| "waiting-compact"
	| "waiting-new-session"
	| "running-shell";

export interface PromptAction {
	type: "prompt";
	text: string;
	waitForAgent?: boolean;
}

export interface SlashAction {
	type: "slash";
	command: string;
	waitForAgent?: boolean;
}

export interface CompactAction {
	type: "compact";
	instructions?: string;
}

export interface NewSessionAction {
	type: "newSession";
	kickoff?: string;
}

export interface ShellAction {
	type: "shell";
	command: string;
	cwd?: string;
	timeoutMs?: number;
	maxOutputBytes?: number;
	attachOutput?: boolean;
	allowFailure?: boolean;
	env?: Record<string, string>;
}

export type ClockworkAction = PromptAction | SlashAction | CompactAction | NewSessionAction | ShellAction;

export interface RunLock {
	runId: string;
	startedAt: number;
	actionIndex: number;
	state: RunState;
	missedCount?: number;
	promptStarted?: boolean;
}

export interface ClockworkJob {
	id: string;
	name: string;
	scope: "workspace" | "session" | "global";
	target: "current-session" | string;
	intervalMs: number;
	nextAt: number;
	maxRuns?: number;
	fireCount: number;
	skipCount: number;
	coalescedCount: number;
	queuedRun: boolean;
	status: JobStatus;
	overlapPolicy: OverlapPolicy;
	actions: ClockworkAction[];
	createdAt: number;
	updatedAt: number;
	lastRunAt?: number;
	lastResult?: string;
	lastError?: string;
	runLock?: RunLock;
}

export interface OwnerLease {
	ownerId: string;
	pid: number;
	hostname: string;
	startedAt: number;
	expiresAt: number;
}

export interface RunRecord {
	runId: string;
	jobId: string;
	startedAt: number;
	endedAt?: number;
	status: "success" | "error" | "skipped" | "started";
	message: string;
}

export interface ClockworkStoreData {
	version: number;
	nextId: number;
	ownerLease?: OwnerLease;
	jobs: ClockworkJob[];
	runs: RunRecord[];
}

export interface CreateJobInput {
	name?: string;
	intervalMs: number;
	maxRuns?: number;
	overlapPolicy?: OverlapPolicy;
	actions: ClockworkAction[];
	nextAt?: number;
}

export type ControlAction = "pause" | "resume" | "stop" | "delete" | "run-now" | "inspect";

export interface ClockworkRuntimeHooks {
	requestRender(): void;
	onJobChanged(jobId?: string): void;
}
