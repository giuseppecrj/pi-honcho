import assert from "node:assert/strict"; // pi-lens-ignore: find-import-file-without-extension
import test from "node:test";

import {
	deletionOutcomeIsUncertain,
	resetConfirmation,
	resetRecovery,
} from "../src/remote/workspace-reset.js";

test("requires an exact workspace-specific reset confirmation", () => {
	assert.equal(resetConfirmation("pi-manual-test"), "DELETE pi-manual-test");
});

test("blocks delivery after an uncertain workspace reset", () => {
	assert.deepEqual(
		resetRecovery("pi", [
			{
				data: { kind: "uncertain", workspaceId: "pi" },
				timestamp: "2026-07-10T14:00:00.000Z",
			},
		]),
		{ blocked: true },
	);
});

test("blocks delivery after an unfinished workspace reset", () => {
	assert.deepEqual(
		resetRecovery("pi", [
			{
				data: { kind: "intent", workspaceId: "pi" },
				timestamp: "2026-07-10T14:00:00.000Z",
			},
		]),
		{ blocked: true },
	);
});

test("allows delivery after a confirmed remote deletion failure", () => {
	assert.deepEqual(
		resetRecovery("pi", [
			{
				data: { kind: "failed", workspaceId: "pi" },
				timestamp: "2026-07-10T14:00:00.000Z",
			},
		]),
		{ blocked: false },
	);
	assert.equal(deletionOutcomeIsUncertain({ status: 404 }), false);
	assert.equal(deletionOutcomeIsUncertain({ status: 429 }), true);
	assert.equal(deletionOutcomeIsUncertain(new Error("timeout")), true);
});

test("a later completed reset resolves an earlier uncertain outcome", () => {
	assert.deepEqual(
		resetRecovery("pi", [
			{
				data: { kind: "uncertain", workspaceId: "pi" },
				timestamp: "2026-07-10T14:00:00.000Z",
			},
			{
				data: { kind: "complete", workspaceId: "pi" },
				timestamp: "2026-07-10T14:01:00.000Z",
			},
		]),
		{ blocked: false, completedAt: "2026-07-10T14:01:00.000Z" },
	);
});
