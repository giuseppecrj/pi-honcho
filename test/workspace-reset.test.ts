import assert from "node:assert/strict"; // pi-lens-ignore: find-import-file-without-extension
import test from "node:test";

import {
	deletionOutcomeIsUncertain,
	resetConfirmation,
	resetRecovery,
	type TimedResetEntry,
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

function permutations<T>(items: readonly T[]): T[][] {
	if (items.length <= 1) return [[...items]];
	return items.flatMap((item, index) =>
		permutations([...items.slice(0, index), ...items.slice(index + 1)]).map(
			(rest) => [item, ...rest],
		),
	);
}

function timedReset(
	kind: "intent" | "complete" | "uncertain" | "failed",
	timestamp: string,
	workspaceId = "pi",
): TimedResetEntry {
	return { data: { kind, workspaceId }, timestamp };
}

const TIE = "2026-07-10T14:00:00.000Z";
const EARLIER = "2026-07-10T13:59:59.999Z";
const LATER = "2026-07-10T14:00:00.001Z";

for (const [name, entries, expected] of [
	[
		"an unresolved reset outranks a tied failure",
		[timedReset("intent", TIE), timedReset("failed", TIE)],
		{ blocked: true },
	],
	[
		"an uncertain reset outranks a tied completion",
		[timedReset("uncertain", TIE), timedReset("complete", TIE)],
		{ blocked: true },
	],
	[
		"a completion outranks a tied failure",
		[timedReset("complete", TIE), timedReset("failed", TIE)],
		{ blocked: false, completedAt: TIE },
	],
	[
		"every tied kind resolves to a blocker",
		[
			timedReset("failed", TIE),
			timedReset("complete", TIE),
			timedReset("intent", TIE),
			timedReset("uncertain", TIE),
		],
		{ blocked: true },
	],
	[
		"a newer completion beats older blockers whatever the tie rank",
		[
			timedReset("intent", EARLIER),
			timedReset("uncertain", EARLIER),
			timedReset("complete", TIE),
			timedReset("failed", EARLIER),
		],
		{ blocked: false, completedAt: TIE },
	],
	[
		"a newer failure beats older blockers and completions",
		[
			timedReset("intent", EARLIER),
			timedReset("uncertain", EARLIER),
			timedReset("complete", EARLIER),
			timedReset("failed", TIE),
		],
		{ blocked: false },
	],
	[
		"tie ranking applies only among the latest timestamp",
		[
			timedReset("intent", EARLIER),
			timedReset("complete", TIE),
			timedReset("failed", TIE),
			timedReset("uncertain", "2026-07-10T13:00:00.000Z"),
		],
		{ blocked: false, completedAt: TIE },
	],
	[
		"a newer blocker beats tied lower-ranked entries",
		[
			timedReset("complete", TIE),
			timedReset("failed", TIE),
			timedReset("intent", LATER),
		],
		{ blocked: true },
	],
	[
		"tied entries for another workspace never decide recovery",
		[
			timedReset("failed", TIE),
			timedReset("intent", TIE, "other"),
			timedReset("uncertain", LATER, "other"),
		],
		{ blocked: false },
	],
] as const) {
	test(`reset recovery is order-independent: ${name}`, () => {
		for (const order of permutations(entries)) {
			assert.deepEqual(
				resetRecovery("pi", order),
				expected,
				order.map((entry) => `${entry.data.kind}@${entry.timestamp}`).join(),
			);
		}
	});
}
