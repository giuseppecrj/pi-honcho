import assert from "node:assert/strict"; // pi-lens-ignore: find-import-file-without-extension
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { debugEnabled, debugLog, debugTimer } from "../src/debug.js";

const LINE =
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[[^\]]+\] \S+( \S+=\S+)*$/;

async function withEnv(
	env: Record<string, string | undefined>,
	run: () => Promise<void> | void,
): Promise<void> {
	const saved = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		await run();
	} finally {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

test("logging is disabled by default and creates no file", async () => {
	const dir = await mkdtemp(join(tmpdir(), "honcho-debug-"));
	const path = join(dir, "debug.log");
	try {
		await withEnv({ HONCHO_DEBUG: undefined, HONCHO_DEBUG_FILE: path }, () => {
			assert.equal(debugEnabled(), false);
			debugLog("honcho:test", "event", { count: 1 });
			debugTimer("honcho:test", "timed")({ ok: true });
			assert.equal(existsSync(path), false);
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("enabled logging appends parseable lines to HONCHO_DEBUG_FILE", async () => {
	const dir = await mkdtemp(join(tmpdir(), "honcho-debug-"));
	const path = join(dir, "nested", "debug.log");
	try {
		await withEnv({ HONCHO_DEBUG: "1", HONCHO_DEBUG_FILE: path }, () => {
			assert.equal(debugEnabled(), true);
			debugLog("honcho:remote", "session_start.done", {
				ms: 142,
				sessionsScanned: 1155,
				skipped: undefined,
			});
			debugTimer("honcho:local", "skills.load_index")({ count: 3 });
		});
		const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
		assert.equal(lines.length, 3);
		for (const line of lines) assert.match(line, LINE);
		assert.match(
			lines[0],
			/\[honcho:remote\] session_start\.done ms=142 sessionsScanned=1155$/,
		);
		assert.match(lines[1], /\[honcho:local\] skills\.load_index\.begin$/);
		assert.match(
			lines[2],
			/\[honcho:local\] skills\.load_index\.done ms=\d+ count=3$/,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('"true" also enables logging', async () => {
	const dir = await mkdtemp(join(tmpdir(), "honcho-debug-"));
	const path = join(dir, "debug.log");
	try {
		await withEnv({ HONCHO_DEBUG: "true", HONCHO_DEBUG_FILE: path }, () => {
			debugLog("honcho:test", "enabled_via_true");
		});
		assert.match(await readFile(path, "utf8"), /enabled_via_true/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("logger never throws on an unwritable path", async () => {
	const dir = await mkdtemp(join(tmpdir(), "honcho-debug-"));
	const blocker = join(dir, "not-a-directory");
	await writeFile(blocker, "plain file");
	const path = join(blocker, "nested", "debug.log");
	try {
		await withEnv({ HONCHO_DEBUG: "1", HONCHO_DEBUG_FILE: path }, () => {
			assert.doesNotThrow(() => debugLog("honcho:test", "event", { n: 1 }));
			assert.doesNotThrow(() => debugTimer("honcho:test", "timed")());
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
