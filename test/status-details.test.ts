import assert from "node:assert/strict"; // pi-lens-ignore: find-import-file-without-extension
import test from "node:test";

import { formatStatusDetails } from "../src/remote/status-details.js";

test("formats the effective workspace boundary and policy failure", () => {
	assert.equal(
		formatStatusDetails({
			state: "disabled — Project policy must be a JSON object",
			workspaceId: "retained",
			workspaceSource: "project policy",
			projectPolicy: "disabled",
			projectPolicyPath: "/repo/.pi/honcho-memory.json",
			projectPolicyReason: "Project policy must be a JSON object",
		}),
		"Honcho: disabled — Project policy must be a JSON object\nWorkspace: retained\nWorkspace source: project policy\nProject policy: disabled\nPolicy path: /repo/.pi/honcho-memory.json\nPolicy reason: Project policy must be a JSON object",
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
			projectPolicy: "enabled",
		}),
		"Honcho: connected\nWorkspace: pi\nUser peer: g\nPi peer: pi\nSession: repo-123\nCredentials: Honcho config\nProject policy: enabled",
	);
});
