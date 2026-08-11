import assert from "node:assert/strict"; // pi-lens-ignore: find-import-file-without-extension
import test from "node:test";

import {
	ExchangeDeliveryQueue,
	type HonchoExchangeClient,
	type HonchoRecoveryClient,
	type RemoteAcknowledgement,
} from "../src/delivery.js";

function exchange(operationId: string, assistantText = "Completed response") {
	return { operationId, userText: "Submitted prompt", assistantText };
}

test("delivers safe finalized exchanges in order and records remote acknowledgements", async () => {
	const delivered: string[] = [];
	const reconciled: string[] = [];
	const acknowledgements: Array<{ operationId: string; messageIds: string[] }> =
		[];
	const client: HonchoExchangeClient & HonchoRecoveryClient = {
		deliverExchange: async (_sessionId, item) => {
			delivered.push(item.operationId);
			return [`remote-${item.operationId}`];
		},
		reconcileOperationId: async (_sessionId, operationId) => {
			reconciled.push(operationId);
			return [];
		},
	};
	const queue = new ExchangeDeliveryQueue(
		client,
		"session-1",
		(acknowledgement) => {
			acknowledgements.push(acknowledgement);
		},
		client,
	);

	queue.enqueue(exchange("turn-1"));
	queue.enqueue(exchange("turn-2"));
	await queue.flush();

	assert.deepEqual(reconciled, []);
	assert.deepEqual(delivered, ["turn-1", "turn-2"]);
	assert.deepEqual(acknowledgements, [
		{ operationId: "turn-1", messageIds: ["remote-turn-1"] },
		{ operationId: "turn-2", messageIds: ["remote-turn-2"] },
	]);
});

test("reconciles recovery exchanges before delivering them", async () => {
	const reconciled: string[] = [];
	const delivered: string[] = [];
	const acknowledgements: RemoteAcknowledgement[] = [];
	const client: HonchoExchangeClient & HonchoRecoveryClient = {
		deliverExchange: async (_sessionId, item) => {
			delivered.push(item.operationId);
			return [`remote-${item.operationId}`];
		},
		reconcileOperationId: async (_sessionId, operationId) => {
			reconciled.push(operationId);
			return operationId === "already-remote" ? ["remote-existing"] : [];
		},
	};
	const queue = new ExchangeDeliveryQueue(
		client,
		"session-1",
		(acknowledgement) => {
			acknowledgements.push(acknowledgement);
		},
		client,
	);

	queue.enqueueRecovery(exchange("already-remote"));
	queue.enqueueRecovery(exchange("missing-remote"));
	await queue.flush();

	assert.deepEqual(reconciled, ["already-remote", "missing-remote"]);
	assert.deepEqual(delivered, ["missing-remote"]);
	assert.deepEqual(acknowledgements, [
		{ operationId: "already-remote", messageIds: ["remote-existing"] },
		{ operationId: "missing-remote", messageIds: ["remote-missing-remote"] },
	]);
});

test("keeps recovery exchanges pending after reconciliation or delivery failures", async () => {
	let reconciliationAttempts = 0;
	let deliveryAttempts = 0;
	const acknowledgements: RemoteAcknowledgement[] = [];
	const recoveryClient: HonchoRecoveryClient = {
		reconcileOperationId: async () => {
			reconciliationAttempts += 1;
			if (reconciliationAttempts === 1) throw new Error("offline");
			return [];
		},
	};
	const queue = new ExchangeDeliveryQueue(
		{
			deliverExchange: async () => {
				deliveryAttempts += 1;
				if (deliveryAttempts === 1) throw new Error("offline");
				return ["remote-1"];
			},
		},
		"session-1",
		(acknowledgement) => {
			acknowledgements.push(acknowledgement);
		},
		recoveryClient,
	);
	queue.enqueueRecovery(exchange("pi-entry-1"));

	await queue.flush();
	await queue.flush();
	await queue.flush();

	assert.equal(reconciliationAttempts, 3);
	assert.equal(deliveryAttempts, 2);
	assert.deepEqual(acknowledgements, [
		{ operationId: "pi-entry-1", messageIds: ["remote-1"] },
	]);
});

test("keeps a failed exchange queued for retry with its stable operation ID", async () => {
	let attempts = 0;
	let reconciliationAttempts = 0;
	const delivered: string[] = [];
	const client: HonchoExchangeClient & HonchoRecoveryClient = {
		deliverExchange: async (_sessionId, item) => {
			attempts += 1;
			if (attempts === 1) throw new Error("offline");
			delivered.push(item.operationId);
			return ["remote-1"];
		},
		reconcileOperationId: async () => {
			reconciliationAttempts += 1;
			return [];
		},
	};
	const queue = new ExchangeDeliveryQueue(
		client,
		"session-1",
		() => undefined,
		client,
	);

	queue.enqueue(exchange("pi-entry-1"));
	await queue.flush();
	await queue.flush();

	assert.equal(reconciliationAttempts, 1);
	assert.equal(attempts, 2);
	assert.deepEqual(delivered, ["pi-entry-1"]);
});

test("reconciles a rejected delivery before retrying it", async () => {
	let deliveryAttempts = 0;
	let reconciliationAttempts = 0;
	const acknowledgements: RemoteAcknowledgement[] = [];
	const client: HonchoExchangeClient & HonchoRecoveryClient = {
		deliverExchange: async () => {
			deliveryAttempts += 1;
			throw new Error("response lost");
		},
		reconcileOperationId: async () => {
			reconciliationAttempts += 1;
			return ["remote-1"];
		},
	};
	const queue = new ExchangeDeliveryQueue(
		client,
		"session-1",
		(acknowledgement) => {
			acknowledgements.push(acknowledgement);
		},
		client,
	);

	queue.enqueue(exchange("pi-entry-1"));
	await queue.flush();
	await queue.flush();

	assert.equal(deliveryAttempts, 1);
	assert.equal(reconciliationAttempts, 1);
	assert.deepEqual(acknowledgements, [
		{ operationId: "pi-entry-1", messageIds: ["remote-1"] },
	]);
});

test("reconciles after acknowledgement failure without redelivering", async () => {
	let deliveryAttempts = 0;
	let reconciliationAttempts = 0;
	let acknowledgementAttempts = 0;
	const acknowledgements: RemoteAcknowledgement[] = [];
	const client: HonchoExchangeClient & HonchoRecoveryClient = {
		deliverExchange: async () => {
			deliveryAttempts += 1;
			return ["remote-1"];
		},
		reconcileOperationId: async () => {
			reconciliationAttempts += 1;
			return ["remote-1"];
		},
	};
	const queue = new ExchangeDeliveryQueue(
		client,
		"session-1",
		(acknowledgement) => {
			acknowledgementAttempts += 1;
			if (acknowledgementAttempts === 1) throw new Error("ledger unavailable");
			acknowledgements.push(acknowledgement);
		},
		client,
	);

	queue.enqueue(exchange("pi-entry-1"));
	await queue.flush();
	await queue.flush();

	assert.equal(deliveryAttempts, 1);
	assert.equal(reconciliationAttempts, 1);
	assert.deepEqual(acknowledgements, [
		{ operationId: "pi-entry-1", messageIds: ["remote-1"] },
	]);
});

test("returns after its lifecycle flush budget while retaining an unacknowledged exchange", async () => {
	let releaseDelivery: (() => void) | undefined;
	const acknowledgements: RemoteAcknowledgement[] = [];
	const client: HonchoExchangeClient = {
		deliverExchange: async () =>
			new Promise<string[]>((resolve) => {
				releaseDelivery = () => resolve(["remote-1"]);
			}),
	};
	const queue = new ExchangeDeliveryQueue(
		client,
		"session-1",
		(acknowledgement) => {
			acknowledgements.push(acknowledgement);
		},
	);
	queue.enqueue(exchange("pi-entry-1"));

	assert.equal(await queue.flushWithin(1), false);
	assert.equal(await queue.flushWithin(1), false);
	assert.ok(releaseDelivery);
	releaseDelivery();
	await queue.flush();
	assert.deepEqual(acknowledgements, [
		{ operationId: "pi-entry-1", messageIds: ["remote-1"] },
	]);
});

test("applies a fresh lifecycle timeout while an earlier flush is in flight", async () => {
	let releaseDelivery: (() => void) | undefined;
	const queue = new ExchangeDeliveryQueue(
		{
			deliverExchange: async () =>
				new Promise<string[]>((resolve) => {
					releaseDelivery = () => resolve(["remote-1"]);
				}),
		},
		"session-1",
		() => undefined,
	);
	queue.enqueue(exchange("pi-entry-1"));

	assert.equal(await queue.flushWithin(1), false);
	assert.ok(releaseDelivery);
	const secondFlush = queue.flushWithin(50);
	releaseDelivery();
	assert.equal(await secondFlush, true);
});

test("discarding pending delivery prevents future exchanges after a privacy disable", async () => {
	const delivered: string[] = [];
	const client: HonchoExchangeClient = {
		deliverExchange: async (_sessionId, item) => {
			delivered.push(item.operationId);
			return [];
		},
	};
	const queue = new ExchangeDeliveryQueue(client, "session-1", () => undefined);
	queue.enqueue(exchange("turn-1"));
	queue.enqueue(exchange("turn-2"));

	queue.discardPending();
	await queue.flush();

	assert.deepEqual(delivered, []);
});

test("discarding pending delivery allows only an already in-flight exchange to finish", async () => {
	let releaseDelivery: (() => void) | undefined;
	const delivered: string[] = [];
	const client: HonchoExchangeClient = {
		deliverExchange: async (_sessionId, item) => {
			delivered.push(item.operationId);
			return new Promise<string[]>((resolve) => {
				releaseDelivery = () => resolve([]);
			});
		},
	};
	const queue = new ExchangeDeliveryQueue(client, "session-1", () => undefined);
	queue.enqueue(exchange("in-flight"));
	queue.enqueue(exchange("pending"));

	const flush = queue.flush();
	queue.discardPending();
	assert.ok(releaseDelivery);
	releaseDelivery();
	await flush;

	assert.deepEqual(delivered, ["in-flight"]);
});

test("never queues incomplete or secret-bearing exchanges", async () => {
	const delivered: string[] = [];
	const client: HonchoExchangeClient = {
		deliverExchange: async (_sessionId, item) => {
			delivered.push(item.operationId);
			return [];
		},
	};
	const queue = new ExchangeDeliveryQueue(client, "session-1", () => undefined);

	assert.equal(queue.enqueue(exchange("incomplete", "")), false);
	assert.equal(
		queue.enqueue({
			operationId: "secret",
			userText: "Authorization: Bearer ghp_0123456789abcdefghijklmnop",
			assistantText: "Never send this",
		}),
		false,
	);
	await queue.flush();

	assert.deepEqual(delivered, []);
});
