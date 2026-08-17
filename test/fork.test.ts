import assert from "node:assert/strict"; // pi-lens-ignore: find-import-file-without-extension
import test from "node:test";

import {
	type ForkLedgerEntry,
	InMemoryForkHandoffs,
	isolatedRemoteSessionId,
	latestRemoteMessageAtFork,
	resolveForkRemoteSession,
} from "../src/remote/fork.js";

const entry = (id: string, parentId: string | null = null) => ({
	id,
	parentId,
});

const acknowledgement = (
	operationId: string,
	messageIds: string[],
): ForkLedgerEntry => ({ kind: "acknowledged", operationId, messageIds });

test("uses the cloned remote session selected for the child fork point", () => {
	const sourceLedger: ForkLedgerEntry[] = [
		{
			kind: "fork",
			targetEntryId: "assistant-1",
			remoteSessionId: "cloned-session",
		},
	];

	assert.equal(
		resolveForkRemoteSession(sourceLedger, "assistant-1"),
		"cloned-session",
	);
});

test("keeps a clone-failure child isolated from later parent history", () => {
	const handoffs = new InMemoryForkHandoffs();
	handoffs.record("assistant-1", undefined);
	assert.equal(handoffs.consume("assistant-1"), undefined);
	assert.equal(handoffs.consume("assistant-1"), undefined);

	const sourceLedger: ForkLedgerEntry[] = [
		{ kind: "fork", targetEntryId: "assistant-1" },
	];

	assert.equal(
		resolveForkRemoteSession(sourceLedger, "assistant-1"),
		undefined,
	);
	assert.equal(
		isolatedRemoteSessionId("repo-abc", "child-session"),
		"repo-abc-fork-child-session",
	);
});

test("hands an in-memory child its successful clone ID once", () => {
	const handoffs = new InMemoryForkHandoffs();
	handoffs.record("assistant-1", "cloned-session");

	assert.equal(handoffs.consume("assistant-1"), "cloned-session");
	assert.equal(handoffs.consume("assistant-1"), undefined);
});

test("clones at the last acknowledged exchange before the Pi fork point", () => {
	const branch = [
		entry("user-1"),
		entry("assistant-1", "user-1"),
		entry("user-2", "assistant-1"),
		entry("assistant-2", "user-2"),
	];
	const ledger: ForkLedgerEntry[] = [
		acknowledgement("pi-assistant-1", ["remote-1"]),
		acknowledgement("pi-assistant-2", ["remote-2"]),
	];

	assert.equal(
		latestRemoteMessageAtFork(branch, ledger, "user-2", "before"),
		"remote-1",
	);
	assert.equal(
		latestRemoteMessageAtFork(branch, ledger, "assistant-2", "at"),
		"remote-2",
	);
});
