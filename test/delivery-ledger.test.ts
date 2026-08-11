import assert from "node:assert/strict"; // pi-lens-ignore: find-import-file-without-extension
import test from "node:test";

import { deliveryLedger } from "../src/delivery-ledger.js";

const exchange = (operationId: string) => ({
	operationId,
	userText: "Prompt",
	assistantText: "Response",
});

const pending = (operationId: string, timestamp: string) => ({
	type: "custom",
	customType: "pi-honcho-memory.delivery",
	timestamp,
	data: { kind: "pending", exchange: exchange(operationId) },
});

const acknowledged = (operationId: string, timestamp: string) => ({
	type: "custom",
	customType: "pi-honcho-memory.delivery",
	timestamp,
	data: {
		kind: "acknowledged",
		operationId,
		messageIds: [`remote-${operationId}`],
	},
});

test("plans replay from raw entries after validation, acknowledgement partitioning, and reset filtering", () => {
	const ledger = deliveryLedger(
		[
			pending("before-reset", "2026-07-10T13:59:59.000Z"),
			acknowledged("already-delivered", "2026-07-10T14:03:00.000Z"),
			pending("already-delivered", "2026-07-10T14:02:00.000Z"),
			pending("replay", "2026-07-10T14:01:00.000Z"),
		],
		{ completedAt: "2026-07-10T14:00:00.000Z" },
	);

	assert.deepEqual([...ledger.acknowledgedOperationIds], ["already-delivered"]);
	assert.deepEqual(ledger.replayableExchanges, [exchange("replay")]);
});

test("ignores malformed pending exchanges without making them replayable", () => {
	const timestamp = "2026-07-10T14:00:00.000Z";
	const ledger = deliveryLedger([
		pending("valid", timestamp),
		{
			type: "custom",
			customType: "pi-honcho-memory.delivery",
			timestamp,
			data: {
				kind: "pending",
				exchange: {
					operationId: 1,
					userText: "Prompt",
					assistantText: "Response",
				},
			},
		},
		{
			type: "custom",
			customType: "pi-honcho-memory.delivery",
			timestamp,
			data: {
				kind: "pending",
				exchange: { operationId: "missing-user", assistantText: "Response" },
			},
		},
		{
			type: "custom",
			customType: "pi-honcho-memory.delivery",
			timestamp,
			data: {
				kind: "pending",
				exchange: {
					operationId: "empty-assistant",
					userText: "Prompt",
					assistantText: "",
				},
			},
		},
	]);

	assert.deepEqual(ledger.replayableExchanges, [exchange("valid")]);
});

test("handles duplicate and out-of-order entries deterministically", () => {
	const ledger = deliveryLedger([
		acknowledged("out-of-order", "2026-07-10T14:00:00.000Z"),
		pending("out-of-order", "2026-07-10T14:01:00.000Z"),
		pending("duplicate", "2026-07-10T14:02:00.000Z"),
		pending("duplicate", "2026-07-10T14:03:00.000Z"),
		{
			type: "custom",
			customType: "pi-honcho-memory.delivery",
			timestamp: "not-a-timestamp",
			data: { kind: "pending", exchange: exchange("invalid-time") },
		},
		{
			type: "custom",
			customType: "pi-honcho-memory.delivery",
			timestamp: "2026-07-10T14:04:00.000Z",
			data: { kind: "acknowledged", operationId: 1, messageIds: [] },
		},
	]);

	assert.deepEqual(ledger.replayableExchanges, [exchange("duplicate")]);
});
