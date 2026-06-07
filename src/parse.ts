import type { CreateJobInput, OverlapPolicy, ClockworkAction, ClockworkJob } from "./types";

const UNIT_MS: Record<string, number> = {
	s: 1_000,
	sec: 1_000,
	secs: 1_000,
	second: 1_000,
	seconds: 1_000,
	m: 60_000,
	min: 60_000,
	mins: 60_000,
	minute: 60_000,
	minutes: 60_000,
	h: 3_600_000,
	hr: 3_600_000,
	hrs: 3_600_000,
	hour: 3_600_000,
	hours: 3_600_000,
	d: 86_400_000,
	day: 86_400_000,
	days: 86_400_000,
};

export interface ParsedAddCommand extends CreateJobInput {}

export interface TemplateContext {
	job: ClockworkJob;
	runId: string;
	missedCount?: number;
	now?: Date;
	extra?: Record<string, string | number | undefined>;
}

export function tokenize(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | null = null;
	let escaping = false;

	for (const ch of input) {
		if (escaping) {
			current += ch;
			escaping = false;
			continue;
		}
		if (ch === "\\") {
			escaping = true;
			continue;
		}
		if (quote) {
			if (ch === quote) quote = null;
			else current += ch;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (/\s/.test(ch)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += ch;
	}
	if (escaping) current += "\\";
	if (quote) throw new Error(`Unclosed ${quote} quote.`);
	if (current) tokens.push(current);
	return tokens;
}

export function parseIntervalMs(input: string): number {
	const trimmed = input.trim().toLowerCase().replace(/^every\s+/, "");
	const compact = trimmed.match(/^(\d+(?:\.\d+)?)\s*([a-z]+)$/i);
	if (compact) {
		const value = Number(compact[1]);
		const unit = compact[2].toLowerCase();
		const unitMs = UNIT_MS[unit];
		if (!unitMs) throw new Error(`Unknown interval unit "${unit}".`);
		const ms = Math.round(value * unitMs);
		if (ms < 1_000) throw new Error("Minimum interval is 1s.");
		return ms;
	}

	const words = trimmed.match(/^(\d+(?:\.\d+)?)\s+([a-z]+)$/i);
	if (words) return parseIntervalMs(`${words[1]}${words[2]}`);

	throw new Error(`Cannot parse interval "${input}". Use formats like 1s, 30 sec, 10m, 2h, or every 10 minutes.`);
}

export function formatInterval(ms: number): string {
	if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
	if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
	if (ms % 60_000 === 0) return `${ms / 60_000}m`;
	if (ms % 1_000 === 0) return `${ms / 1_000}s`;
	return `${ms}ms`;
}

function readInterval(tokens: string[], index: number): { intervalMs: number; consumed: number } {
	const first = tokens[index];
	const second = tokens[index + 1];
	if (!first) throw new Error("Missing interval after --every.");
	if (/^\d+(?:\.\d+)?$/.test(first) && second && /^[a-z]+$/i.test(second)) {
		return { intervalMs: parseIntervalMs(`${first} ${second}`), consumed: 2 };
	}
	return { intervalMs: parseIntervalMs(first), consumed: 1 };
}

function parseOverlapPolicy(value: string): OverlapPolicy {
	if (value === "drop" || value === "coalesce" || value === "queueOne") return value;
	if (value === "queue-one" || value === "queue_one") return "queueOne";
	throw new Error(`Invalid overlap policy "${value}". Use drop, coalesce, or queueOne.`);
}

function pushThenAction(actions: ClockworkAction[], keyword: string, tokens: string[], index: number): number {
	const normalized = keyword.toLowerCase();
	if (normalized === "compact" || normalized === "/compact") {
		actions.push({ type: "compact" });
		return index;
	}
	if (normalized === "new" || normalized === "/new" || normalized === "newsession" || normalized === "new-session") {
		actions.push({ type: "newSession" });
		return index;
	}
	if (normalized === "slash") {
		const command = tokens[index];
		if (!command) throw new Error("Missing slash command after --then slash.");
		if (!command.startsWith("/")) throw new Error("Slash action must start with /.");
		actions.push({ type: "slash", command });
		return index + 1;
	}
	if (normalized === "shell") {
		let start = index;
		if (tokens[start] === "--") start++;
		const command = tokens.slice(start).join(" ").trim();
		if (!command) throw new Error("Missing shell command after --then shell --.");
		actions.push({ type: "shell", command });
		return tokens.length;
	}
	if (keyword.startsWith("/")) {
		actions.push({ type: "slash", command: keyword });
		return index;
	}
	throw new Error(`Unknown --then action "${keyword}". Use compact, new, slash, or shell.`);
}

export function parseAddArgs(args: string, now = Date.now()): ParsedAddCommand {
	const tokens = tokenize(args);
	let name: string | undefined;
	let intervalMs: number | undefined;
	let maxRuns: number | undefined;
	let overlapPolicy: OverlapPolicy | undefined;
	const actions: ClockworkAction[] = [];
	const freePrompt: string[] = [];

	for (let i = 0; i < tokens.length; ) {
		const token = tokens[i]!;
		switch (token) {
			case "--name":
			case "-n":
				name = tokens[i + 1];
				if (!name) throw new Error(`Missing value after ${token}.`);
				i += 2;
				break;
			case "--every":
			case "--interval": {
				const parsed = readInterval(tokens, i + 1);
				intervalMs = parsed.intervalMs;
				i += 1 + parsed.consumed;
				break;
			}
			case "--times":
			case "--max-runs":
			case "--maxRuns": {
				const raw = tokens[i + 1];
				if (!raw) throw new Error(`Missing value after ${token}.`);
				maxRuns = Number.parseInt(raw, 10);
				if (!Number.isFinite(maxRuns) || maxRuns <= 0) throw new Error("Run count must be a positive integer.");
				i += 2;
				break;
			}
			case "--policy":
			case "--overlap": {
				const raw = tokens[i + 1];
				if (!raw) throw new Error(`Missing value after ${token}.`);
				overlapPolicy = parseOverlapPolicy(raw);
				i += 2;
				break;
			}
			case "--prompt": {
				const text = tokens[i + 1];
				if (!text) throw new Error("Missing prompt after --prompt.");
				actions.push({ type: "prompt", text });
				i += 2;
				break;
			}
			case "--compact":
				actions.push({ type: "compact" });
				i += 1;
				break;
			case "--new":
			case "--new-session":
				actions.push({ type: "newSession" });
				i += 1;
				break;
			case "--slash": {
				const command = tokens[i + 1];
				if (!command?.startsWith("/")) throw new Error("Missing slash command after --slash.");
				actions.push({ type: "slash", command });
				i += 2;
				break;
			}
			case "--shell": {
				let start = i + 1;
				if (tokens[start] === "--") start++;
				const command = tokens.slice(start).join(" ").trim();
				if (!command) throw new Error("Missing shell command after --shell --.");
				actions.push({ type: "shell", command });
				i = tokens.length;
				break;
			}
			case "--then": {
				const keyword = tokens[i + 1];
				if (!keyword) throw new Error("Missing action after --then.");
				i = pushThenAction(actions, keyword, tokens, i + 2);
				break;
			}
			default:
				freePrompt.push(token);
				i += 1;
				break;
		}
	}

	if (!intervalMs) throw new Error("Missing interval. Use --every 10m or --every 30 seconds.");
	if (actions.length === 0 && freePrompt.length > 0) actions.push({ type: "prompt", text: freePrompt.join(" ") });
	if (actions.length === 0) throw new Error("Missing action. Add --prompt, --shell, --slash, or free-form prompt text.");

	return {
		name,
		intervalMs,
		maxRuns,
		overlapPolicy,
		actions,
		nextAt: now + intervalMs,
	};
}

function pad(n: number): string {
	return String(n).padStart(2, "0");
}

export function formatDate(date: Date, pattern = "yyyy-mm-dd_HH-MM-ss"): string {
	return pattern
		.replace(/yyyy/g, String(date.getFullYear()))
		.replace(/yy/g, String(date.getFullYear()).slice(-2))
		.replace(/mm/g, pad(date.getMonth() + 1))
		.replace(/dd/g, pad(date.getDate()))
		.replace(/HH/g, pad(date.getHours()))
		.replace(/MM/g, pad(date.getMinutes()))
		.replace(/ss/g, pad(date.getSeconds()));
}

export function renderTemplate(input: string, context: TemplateContext): string {
	const now = context.now ?? new Date();
	const values: Record<string, string | number | undefined> = {
		"job.id": context.job.id,
		"job.name": context.job.name,
		"schedule.id": context.job.id,
		"schedule.name": context.job.name,
		"run.id": context.runId,
		fireCount: context.job.fireCount,
		missedCount: context.missedCount ?? context.job.runLock?.missedCount ?? 0,
		timestamp: now.toISOString(),
		date: formatDate(now),
		...context.extra,
	};

	return input.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, rawKey: string) => {
		const [key, arg] = rawKey.split(":", 2).map((part) => part.trim());
		if (key === "date") return formatDate(now, arg || undefined);
		const value = values[key];
		return value === undefined ? `{{${rawKey}}}` : String(value);
	});
}
