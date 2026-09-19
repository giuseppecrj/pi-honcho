import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerStandingInstructions } from "../src/local/standing-instructions.js";

type RegisteredCommand = {
	handler: (
		args: string,
		ctx: { ui: { notify: (message: string, type?: string) => void } },
	) => Promise<void>;
};
type BeforeAgentStart = (event: {
	prompt?: string;
	systemPrompt?: string;
}) => Promise<{ systemPrompt?: string } | undefined>;

class FakePi {
	commands = new Map<string, RegisteredCommand>();
	handlers = new Map<string, (...args: unknown[]) => unknown>();

	registerCommand(name: string, command: RegisteredCommand): void {
		this.commands.set(name, command);
	}

	on(name: string, handler: (...args: unknown[]) => unknown): void {
		this.handlers.set(name, handler);
	}
}

async function setup(seed?: string): Promise<{
	filePath: string;
	pin: RegisteredCommand;
	inject: (systemPrompt?: string) => Promise<string>;
	cleanup: () => Promise<void>;
}> {
	const root = await mkdtemp(join(tmpdir(), "pi-honcho-standing-cache-"));
	const filePath = join(root, "STANDING.md");
	if (seed !== undefined) await writeFile(filePath, seed, "utf8");
	const pi = new FakePi();
	registerStandingInstructions(pi as unknown as ExtensionAPI, {
		filePath,
		enabled: true,
	});
	const pin = pi.commands.get("memory-pin");
	const beforeStart = pi.handlers.get("before_agent_start") as
		| BeforeAgentStart
		| undefined;
	assert.ok(pin);
	assert.ok(beforeStart);
	return {
		filePath,
		pin,
		inject: async (systemPrompt = "base") => {
			const result = await beforeStart({ prompt: "hello", systemPrompt });
			return result?.systemPrompt ?? systemPrompt;
		},
		cleanup: () => rm(root, { recursive: true, force: true }),
	};
}

test("stat-gated cache still surfaces external edits, same-length rewrites, and deletions", async () => {
	const fixture = await setup("Rule aaa\n");
	try {
		assert.match(await fixture.inject(), /1\. Rule aaa/);
		// Unchanged file across turns keeps serving the same instructions.
		assert.match(await fixture.inject(), /1\. Rule aaa/);

		// Same byte length, different content: must be re-read.
		await writeFile(fixture.filePath, "Rule bbb\n", "utf8");
		const rewritten = await fixture.inject();
		assert.match(rewritten, /1\. Rule bbb/);
		assert.doesNotMatch(rewritten, /Rule aaa/);

		await rm(fixture.filePath);
		assert.equal(await fixture.inject("base-only"), "base-only");

		// A recreated file after a cached miss is picked up again.
		await writeFile(fixture.filePath, "Rule ccc\n", "utf8");
		assert.match(await fixture.inject(), /1\. Rule ccc/);
	} finally {
		await fixture.cleanup();
	}
});

test("/memory-pin writes invalidate the cached standing instructions", async () => {
	const fixture = await setup("First rule\n");
	try {
		assert.match(await fixture.inject(), /1\. First rule/);

		const notifies: string[] = [];
		const ctx = {
			ui: { notify: (message: string) => notifies.push(message) },
		};
		await fixture.pin.handler("Second pinned rule", ctx);
		assert.match(notifies.at(-1) ?? "", /Pinned standing instruction 2/);
		const afterAdd = await fixture.inject();
		assert.match(afterAdd, /1\. First rule/);
		assert.match(afterAdd, /2\. Second pinned rule/);

		await fixture.pin.handler("clear", ctx);
		assert.equal(await fixture.inject("base-only"), "base-only");
	} finally {
		await fixture.cleanup();
	}
});
