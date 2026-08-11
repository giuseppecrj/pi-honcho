import assert from "node:assert/strict"; // pi-lens-ignore: find-import-file-without-extension
import test from "node:test";

import { Message, Session } from "@honcho-ai/sdk"; // pi-lens-ignore: find-import-file-without-extension

test("the pinned SDK exposes reconciliation and fork capabilities", () => {
	assert.equal(typeof Session.prototype.addMessages, "function");
	assert.equal(typeof Session.prototype.updateMessage, "function");
	assert.equal(typeof Session.prototype.clone, "function");

	const message = Message.fromApiResponse({
		id: "message-1",
		content: "safe test message",
		peer_id: "user",
		session_id: "session-1",
		workspace_id: "pi",
		metadata: { operationId: "pi-entry-1" },
		created_at: "2026-07-09T00:00:00Z",
		token_count: 3,
	});

	assert.equal(message.id, "message-1");
	assert.deepEqual(message.metadata, { operationId: "pi-entry-1" });
});
