import assert from "node:assert/strict"; // pi-lens-ignore: find-import-file-without-extension
import test from "node:test";

import { disableProjectMemoryNow } from "../src/remote/privacy-barrier.js";

test("an immediate project privacy disable clears recall, delivery, remote clients, connection, and tools", () => {
	const effects: string[] = [];

	disableProjectMemoryNow({
		clearRecall: () => effects.push("recall"),
		discardPendingDelivery: () => effects.push("delivery"),
		clearRemoteClients: () => effects.push("clients"),
		stopConnection: () => effects.push("connection"),
		hideTools: () => effects.push("tools"),
	});

	assert.deepEqual(effects, [
		"recall",
		"delivery",
		"clients",
		"connection",
		"tools",
	]);
});
