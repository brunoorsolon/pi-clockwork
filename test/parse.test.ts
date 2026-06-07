import assert from "node:assert/strict";
import test from "node:test";
import { formatDate, parseAddArgs, parseIntervalMs, renderTemplate } from "../src/parse";
import type { ClockworkJob } from "../src/types";

test("parseIntervalMs supports exact seconds, minutes, and hours", () => {
	assert.equal(parseIntervalMs("1s"), 1_000);
	assert.equal(parseIntervalMs("30 sec"), 30_000);
	assert.equal(parseIntervalMs("every 10 minutes"), 600_000);
	assert.equal(parseIntervalMs("2h"), 7_200_000);
});

test("parseIntervalMs rejects sub-second and unknown units", () => {
	assert.throws(() => parseIntervalMs("0.5s"), /Minimum interval/);
	assert.throws(() => parseIntervalMs("3 fortnights"), /Unknown interval unit/);
});

test("parseAddArgs builds prompt compact new action chain", () => {
	const parsed = parseAddArgs('--name gh-issues --every 10m --times 5 --prompt "check issues" --then compact --then new', 1_000);
	assert.equal(parsed.name, "gh-issues");
	assert.equal(parsed.intervalMs, 600_000);
	assert.equal(parsed.maxRuns, 5);
	assert.equal(parsed.nextAt, 601_000);
	assert.deepEqual(parsed.actions.map((action) => action.type), ["prompt", "compact", "newSession"]);
});

test("parseAddArgs supports shell command tail", () => {
	const parsed = parseAddArgs('--every 5s --shell -- echo "hello world"');
	assert.equal(parsed.actions[0]?.type, "shell");
	assert.equal(parsed.actions[0]?.type === "shell" ? parsed.actions[0].command : "", "echo hello world");
});

test("renderTemplate supports job, schedule aliases, run, and local date variables", () => {
	const job = { id: "7", name: "demo", fireCount: 3 } as ClockworkJob;
	const date = new Date(2026, 5, 7, 12, 34, 56);
	assert.equal(formatDate(date, "yyyy-mm-dd_HH-MM-ss"), "2026-06-07_12-34-56");
	assert.equal(
		renderTemplate("{{job.name}} {{job.id}} {{schedule.name}} {{schedule.id}} {{run.id}} {{date:yyyy-mm-dd_HH-MM-ss}}", {
			job,
			runId: "abc",
			now: date,
		}),
		"demo 7 demo 7 abc 2026-06-07_12-34-56",
	);
});
