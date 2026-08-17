import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { repositorySessionKey } from "../src/remote/session-key.js";

const execFileAsync = promisify(execFile);

async function git(...args: string[]): Promise<void> {
	await execFileAsync("git", args);
}

test("repository session keys isolate peers while sharing a Git origin", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-honcho-session-key-"));
	const origin = join(root, "origin.git");
	const firstCheckout = join(root, "first checkout");
	const secondCheckout = join(root, "second checkout");
	const peer = "person with spaces";
	try {
		await git("init", "--bare", origin);
		for (const checkout of [firstCheckout, secondCheckout]) {
			await mkdir(checkout);
			await git("-C", checkout, "init");
			await git("-C", checkout, "remote", "add", "origin", origin);
		}

		const first = await repositorySessionKey(firstCheckout, peer);
		assert.equal(await repositorySessionKey(firstCheckout, peer), first);
		assert.match(first, /^repo-v2-[a-f0-9]{24}$/);
		assert.equal(await repositorySessionKey(secondCheckout, peer), first);

		const otherPeer = "another person";
		const isolated = await repositorySessionKey(firstCheckout, otherPeer);
		assert.notEqual(isolated, first);
		for (const value of [first, isolated]) {
			assert.ok(!value.includes(peer));
			assert.ok(!value.includes(otherPeer));
			assert.ok(!value.includes(origin));
			assert.ok(!value.includes(firstCheckout));
			assert.ok(!value.includes(secondCheckout));
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("non-Git repository session keys remain path and peer isolated", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-honcho-session-key-"));
	const firstDirectory = join(root, "first");
	const secondDirectory = join(root, "second");
	const peer = "non-git peer";
	try {
		await Promise.all([mkdir(firstDirectory), mkdir(secondDirectory)]);
		const first = await repositorySessionKey(firstDirectory, peer);
		assert.equal(await repositorySessionKey(firstDirectory, peer), first);
		assert.match(first, /^repo-v2-[a-f0-9]{24}$/);
		const otherPeer = await repositorySessionKey(firstDirectory, "other peer");
		const otherDirectory = await repositorySessionKey(secondDirectory, peer);
		assert.notEqual(otherPeer, first);
		assert.notEqual(otherDirectory, first);
		for (const value of [first, otherPeer, otherDirectory]) {
			assert.ok(!value.includes(peer));
			assert.ok(!value.includes("other peer"));
			assert.ok(!value.includes(firstDirectory));
			assert.ok(!value.includes(secondDirectory));
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
