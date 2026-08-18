import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	loadHonchoRegistry,
	saveHonchoRegistry,
} from "../src/remote/config-file.js";

import {
	canonicalRepositoryKey,
	initialRegistry,
	resolveRepositoryEntry,
	updateRepositoryEntry,
} from "../src/remote/registry.js";

test("uses a canonical origin when Git provides one", () => {
	assert.equal(
		canonicalRepositoryKey("/work/app", "git@github.com:Org/App.git"),
		"origin:github.com/Org/App",
	);
	assert.equal(
		canonicalRepositoryKey("/work/app", "https://github.com/Org/App"),
		"origin:github.com/Org/App",
	);
	assert.equal(
		canonicalRepositoryKey("/work/app", "ssh://git@github.com/Org/App.git"),
		"origin:github.com/Org/App",
	);
});

test("falls back to the resolved directory outside Git", () => {
	assert.equal(
		canonicalRepositoryKey("/work/app/../app"),
		"directory:/work/app",
	);
});

test("persists registry identity separately from Honcho credentials", async () => {
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = await mkdtemp(
		join(tmpdir(), "pi-honcho-agent-"),
	);
	try {
		const registry = updateRepositoryEntry(
			initialRegistry(),
			"directory:/work/app",
			{
				workspaceId: "project-memory",
				enabled: true,
			},
		);
		registry.identity = { userPeer: "person", aiPeer: "agent" };
		assert.equal(await saveHonchoRegistry(registry), true);
		assert.deepEqual(await loadHonchoRegistry(), registry);
		assert.match(
			await readFile(
				join(process.env.PI_CODING_AGENT_DIR, "honcho-memory.json"),
				"utf8",
			),
			/"identity"/,
		);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
});

test("fails closed when the local registry is malformed", async () => {
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = await mkdtemp(
		join(tmpdir(), "pi-honcho-agent-"),
	);
	try {
		await writeFile(
			join(process.env.PI_CODING_AGENT_DIR, "honcho-memory.json"),
			"{",
		);
		assert.equal(await loadHonchoRegistry(), undefined);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
});

test("keeps a disabled repository workspace while blocking activation", () => {
	const initialized = updateRepositoryEntry(
		initialRegistry(),
		"origin:github.com/org/app",
		{
			workspaceId: "project-memory",
			enabled: true,
		},
	);
	const disabled = updateRepositoryEntry(
		initialized,
		"origin:github.com/org/app",
		{
			workspaceId: "project-memory",
			enabled: false,
		},
	);

	assert.deepEqual(
		resolveRepositoryEntry(disabled, "origin:github.com/org/app"),
		{
			workspaceId: "project-memory",
			enabled: false,
		},
	);
});
