import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ClockworkRunner } from "../src/runner";
import { ClockworkStore } from "../src/store";

function makeContext(): ExtensionContext {
	return {
		isIdle: () => true,
		cwd: process.cwd(),
		hasPendingMessages: () => false,
		ui: { notify: () => undefined },
	} as unknown as ExtensionContext;
}

function makeStore() {
	const dir = mkdtempSync(join(tmpdir(), "pi-clockwork-runner-"));
	return new ClockworkStore({ path: join(dir, "jobs.json"), ownerId: "owner" });
}

test("ClockworkRunner prompt action waits for matching agent start and end", () => {
	const store = makeStore();
	store.create({ intervalMs: 1_000, actions: [{ type: "prompt", text: "hello {{job.name}}" }], name: "demo" }, 0);
	const sent: string[] = [];
	let finished = 0;
	const pi = {
		sendUserMessage: (content: string) => sent.push(content),
		sendMessage: () => undefined,
	} as unknown as ExtensionAPI;
	const runner = new ClockworkRunner({ pi, store, getContext: makeContext, onRunFinished: () => finished++ });

	assert.equal(runner.tryStartRun("1", 1_000, "timer"), true);
	assert.equal(sent.length, 1);
	assert.match(sent[0]!, /hello demo/);
	assert.equal(store.get("1")?.runLock?.state, "waiting-agent-start");

	runner.onAgentEnd();
	assert.equal(store.get("1")?.runLock?.state, "waiting-agent-start");

	runner.onBeforeAgentStart(sent[0]!);
	assert.equal(store.get("1")?.runLock?.state, "waiting-agent-end");

	runner.onAgentEnd();
	assert.equal(store.get("1")?.runLock, undefined);
	assert.equal(store.get("1")?.fireCount, 1);
	assert.equal(finished, 1);
});

test("ClockworkRunner drops overlapping timer ticks by default", () => {
	const store = makeStore();
	store.create({ intervalMs: 1_000, actions: [{ type: "prompt", text: "hello" }] }, 0);
	const pi = { sendUserMessage: () => undefined, sendMessage: () => undefined } as unknown as ExtensionAPI;
	const runner = new ClockworkRunner({ pi, store, getContext: makeContext, onRunFinished: () => undefined });

	assert.equal(runner.tryStartRun("1", 1_000, "timer"), true);
	assert.equal(runner.tryStartRun("1", 2_000, "timer"), false);
	assert.equal(store.get("1")?.skipCount, 1);
});
