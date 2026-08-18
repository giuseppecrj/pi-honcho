import assert from "node:assert/strict"; // pi-lens-ignore: find-import-file-without-extension
import test from "node:test";

import { formatStatusDetails } from "../src/remote/status-details.js";

test("formats the effective repository boundary", () => {
	assert.equal(
		formatStatusDetails({
			state: "disabled — Disabled for this repository",
			workspaceId: "retained",
			workspaceSource: "registry",
			repositoryMemory: "disabled",
		}),
		"Honcho: disabled — Disabled for this repository\nWorkspace: retained\nWorkspace source: registry\nRepository memory: disabled",
	);
});

test("formats non-secret memory identity details", () => {
	assert.equal(
		formatStatusDetails({
			state: "connected",
			workspaceId: "pi",
			userPeer: "g",
			aiPeer: "pi",
			sessionId: "repo-123",
			credentialSource: "Honcho config",
			repositoryMemory: "enabled",
		}),
		"Honcho: connected\nWorkspace: pi\nUser peer: g\nPi peer: pi\nSession: repo-123\nCredentials: Honcho config\nRepository memory: enabled",
	);
});
