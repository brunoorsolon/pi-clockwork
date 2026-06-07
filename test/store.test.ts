import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ClockworkStore } from "../src/store";

function tempStore(ownerId = "owner") {
	const dir = mkdtempSync(join(tmpdir(), "pi-clockwork-store-"));
	const path = join(dir, "jobs.json");
	return { path, store: new ClockworkStore({ path, ownerId, leaseMs: 1_000, lockStaleMs: 1_000 }) };
}

test("ClockworkStore creates and reloads jobs", () => {
	const { path, store } = tempStore();
	const job = store.create({ intervalMs: 1_000, name: "demo", actions: [{ type: "prompt", text: "hi" }] }, 10);
	assert.equal(job.id, "1");
	assert.equal(JSON.parse(readFileSync(path, "utf8")).jobs.length, 1);

	const reloaded = new ClockworkStore({ path, ownerId: "owner" });
	assert.equal(reloaded.get("1")?.name, "demo");
});

test("ClockworkStore ignores malformed JSON without crashing", () => {
	const { path } = tempStore();
	writeFileSync(path, "{not-json");
	const reloaded = new ClockworkStore({ path, ownerId: "owner" });
	assert.deepEqual(reloaded.list(), []);
});

test("ClockworkStore clears stale locks", () => {
	const { store } = tempStore();
	store.create({ intervalMs: 1_000, actions: [{ type: "prompt", text: "hi" }] }, 0);
	store.mutate("1", (job) => {
		job.runLock = { runId: "run", startedAt: 0, actionIndex: 0, state: "running" };
	});
	assert.deepEqual(store.clearStaleLocks(2_000), ["1"]);
	assert.equal(store.get("1")?.runLock, undefined);
});

test("ClockworkStore owner lease prevents duplicate owners", () => {
	const { path, store } = tempStore("owner-a");
	assert.equal(store.claimLease(0), true);
	const second = new ClockworkStore({ path, ownerId: "owner-b", leaseMs: 1_000 });
	assert.equal(second.claimLease(500), false);
	assert.equal(second.claimLease(2_000), true);
});
