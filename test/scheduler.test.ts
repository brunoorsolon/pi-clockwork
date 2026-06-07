import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ClockworkScheduler, type SchedulerClock, type TimerHandle } from "../src/scheduler";
import { ClockworkStore } from "../src/store";

interface FakeTimer extends TimerHandle {
	id: number;
	at: number;
	callback: () => void;
}

class FakeClock implements SchedulerClock {
	private nextId = 1;
	private timers = new Map<number, FakeTimer>();
	nowMs = 0;

	now(): number {
		return this.nowMs;
	}

	setTimeout(callback: () => void, delayMs: number): TimerHandle {
		const timer: FakeTimer = { id: this.nextId++, at: this.nowMs + delayMs, callback };
		this.timers.set(timer.id, timer);
		return timer;
	}

	clearTimeout(handle: TimerHandle): void {
		this.timers.delete((handle as FakeTimer).id);
	}

	tick(ms: number): void {
		const target = this.nowMs + ms;
		while (true) {
			const due = [...this.timers.values()].filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at)[0];
			if (!due) break;
			this.timers.delete(due.id);
			this.nowMs = due.at;
			due.callback();
		}
		this.nowMs = target;
	}
}

function makeStore() {
	const dir = mkdtempSync(join(tmpdir(), "pi-clockwork-scheduler-"));
	return new ClockworkStore({ path: join(dir, "jobs.json"), ownerId: "owner" });
}

test("ClockworkScheduler fires exact second intervals", () => {
	const clock = new FakeClock();
	const store = makeStore();
	store.create({ intervalMs: 1_000, actions: [{ type: "prompt", text: "hi" }] }, 0);
	let fires = 0;
	const scheduler = new ClockworkScheduler({
		store,
		clock,
		fire: (id) => {
			fires += 1;
			store.mutate(id, (job) => {
				job.fireCount += 1;
			});
			return true;
		},
	});
	scheduler.start();
	clock.tick(3_500);
	assert.equal(fires, 3);
	assert.equal(store.get("1")?.nextAt, 4_000);
});

test("ClockworkScheduler expires jobs at maxRuns", () => {
	const clock = new FakeClock();
	const store = makeStore();
	store.create({ intervalMs: 1_000, maxRuns: 2, actions: [{ type: "prompt", text: "hi" }] }, 0);
	const scheduler = new ClockworkScheduler({
		store,
		clock,
		fire: (id) => {
			store.mutate(id, (job) => {
				job.fireCount += 1;
			});
			return true;
		},
	});
	scheduler.start();
	clock.tick(3_000);
	assert.equal(store.get("1")?.fireCount, 2);
	assert.equal(store.get("1")?.status, "expired");
});

test("ClockworkScheduler pause and resume controls timers", () => {
	const clock = new FakeClock();
	const store = makeStore();
	store.create({ intervalMs: 1_000, actions: [{ type: "prompt", text: "hi" }] }, 0);
	let fires = 0;
	const scheduler = new ClockworkScheduler({
		store,
		clock,
		fire: () => {
			fires += 1;
			return true;
		},
	});
	scheduler.start();
	assert.equal(scheduler.pause("1"), true);
	clock.tick(2_000);
	assert.equal(fires, 0);
	assert.equal(scheduler.resume("1"), true);
	clock.tick(1_000);
	assert.equal(fires, 1);
});
