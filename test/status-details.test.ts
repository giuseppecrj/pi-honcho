import assert from "node:assert/strict"; // pi-lens-ignore: find-import-file-without-extension
import test from "node:test";

import { formatStatusDetails } from "../src/remote/status-details.js";

test("guides an uninitialized repository to initialization", () => {
	assert.equal(
		formatStatusDetails({
			state:
				"unconfigured — This repository is not initialized. Use /honcho init.",
			repositoryMemory: "uninitialized",
		}),
		"Honcho: unconfigured — This repository is not initialized. Use /honcho init.\nRepository memory: uninitialized\nRun /honcho init in a trusted repository to select a workspace.",
	);
});

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
		"Honcho: connected\nWorkspace: pi\nUser peer: g\nPi peer: pi\nRepository session: repo-123\nCredentials: Honcho config\nRepository memory: enabled",
	);
});

test("formats the configured context injection cadence", () => {
	assert.equal(
		formatStatusDetails({ state: "connected", contextCadenceTurns: 1 }),
		"Honcho: connected\nContext cadence: every 1 turn",
	);
	assert.equal(
		formatStatusDetails({ state: "connected", contextCadenceTurns: 4 }),
		"Honcho: connected\nContext cadence: every 4 turns",
	);
});

test("formats the configured reasoning level", () => {
	assert.equal(
		formatStatusDetails({ state: "connected", reasoningLevel: "minimal" }),
		"Honcho: connected\nReasoning level: minimal",
	);
});

test("formats the configured request timeout", () => {
	assert.equal(
		formatStatusDetails({ state: "connected", timeoutMs: 20_000 }),
		"Honcho: connected\nQuery timeout: 20000ms",
	);
});
