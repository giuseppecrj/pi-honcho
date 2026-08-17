import assert from "node:assert/strict"; // pi-lens-ignore: find-import-file-without-extension
import test from "node:test";

import { chunkText, safeExchange } from "../src/remote/exchange.js";

test("rejects the complete exchange when either side contains a secret", () => {
	assert.equal(
		safeExchange({
			operationId: "turn-1",
			userText: "normal prompt",
			assistantText: "-----BEGIN PRIVATE KEY-----\nprivate material",
		}),
		undefined,
	);
	assert.equal(
		safeExchange({
			operationId: "turn-2",
			userText: "token=abcdefghijk",
			assistantText: "normal response",
		}),
		undefined,
	);
	assert.equal(
		safeExchange({
			operationId: "turn-3",
			userText: "Authorization: Bearer abcdefghijklmnop",
			assistantText: "normal response",
		}),
		undefined,
	);
	assert.equal(
		safeExchange({
			operationId: "turn-4",
			userText: "sk-proj-abcdefghijklmnopqrstuvwxyz012345",
			assistantText: "normal response",
		}),
		undefined,
	);
	assert.equal(
		safeExchange({
			operationId: "turn-5",
			userText: "AWS_SECRET_ACCESS_KEY=abcdefghijklmnopqrstuvwxyz",
			assistantText: "normal response",
		}),
		undefined,
	);
});

test("chunks a safe long message without changing its content", () => {
	const text = "abcdefghij";
	assert.deepEqual(chunkText(text, 4), ["abcd", "efgh", "ij"]);
	assert.equal(chunkText(text, 4).join(""), text);
	assert.deepEqual(chunkText("a😀b", 2), ["a😀", "b"]);
});

test("does not treat a textless side as a finalized exchange", () => {
	assert.equal(
		safeExchange({
			operationId: "turn-3",
			userText: "prompt",
			assistantText: "  ",
		}),
		undefined,
	);
});
