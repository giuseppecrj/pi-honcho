import assert from "node:assert/strict"; // pi-lens-ignore: find-import-file-without-extension
import test from "node:test";

import { deletionTarget } from "../src/remote/config.js";

test("accepts only explicit remote deletion targets", () => {
	assert.deepEqual(deletionTarget("session"), { kind: "session" });
	assert.deepEqual(deletionTarget("conclusion conclusion-1"), {
		kind: "conclusion",
		id: "conclusion-1",
	});
	assert.equal(deletionTarget("conclusion"), undefined);
	assert.equal(deletionTarget("everything"), undefined);
});
