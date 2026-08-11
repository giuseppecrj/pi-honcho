import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	unlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import localKnowledgeTools from "../src/local-tools.js";

type RegisteredTool = {
	name: string;
	label: string;
	description: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	parameters: unknown;
	execute: (
		id: string,
		args: {
			query: string;
			project?: string;
			role?: string;
			limit?: number;
			snippetChars?: number;
		},
	) => Promise<{
		content: Array<{ type: string; text: string }>;
		details: {
			count?: number;
			message?: string;
			snippetChars?: number;
			truncatedCount?: number;
		};
	}>;
};

class FakePi {
	readonly tools = new Map<string, RegisteredTool>();

	registerTool(tool: RegisteredTool): void {
		this.tools.set(tool.name, tool);
	}

	registerCommand(): void {}

	on(): void {}
}

function session(
	id: string,
	cwd: string,
	entries: Array<{
		id: string;
		parentId?: string | null;
		timestamp: string;
		role: string;
		content: unknown;
	}>,
	parentSession?: string,
): string {
	return [
		JSON.stringify({
			type: "session",
			version: 3,
			id,
			timestamp: "2026-08-11T00:00:00.000Z",
			cwd,
			parentSession,
		}),
		...entries.map((entry) =>
			JSON.stringify({
				type: "message",
				parentId: null,
				...entry,
				message: { role: entry.role, content: entry.content },
			}),
		),
	].join("\n");
}

async function setup(options?: {
	readSession?: (path: string) => Promise<string>;
}): Promise<{
	directory: string;
	sessionsDir: string;
	writeSession: (name: string, content: string) => Promise<string>;
	search: RegisteredTool["execute"];
	tool: RegisteredTool;
}> {
	const directory = await mkdtemp(join(tmpdir(), "pi-honcho-local-tools-"));
	const sessionsDir = join(directory, "sessions");
	await mkdir(join(sessionsDir, "project"), { recursive: true });
	const pi = new FakePi();
	localKnowledgeTools(pi as unknown as ExtensionAPI, {
		sessionsDir,
		databasePath: join(directory, "index.sqlite"),
		...options,
	});
	const tool = pi.tools.get("session_search");
	assert.ok(tool);
	return {
		directory,
		sessionsDir,
		writeSession: async (name, content) => {
			const path = join(sessionsDir, "project", name);
			await writeFile(path, content);
			return path;
		},
		search: tool.execute,
		tool,
	};
}

test("session_search defaults its rebuildable index under pi-honcho", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-honcho-session-search-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
	delete process.env.PI_CODING_AGENT_SESSION_DIR;

	try {
		const sessionsDir = join(root, "sessions", "project");
		await mkdir(sessionsDir, { recursive: true });
		await writeFile(
			join(sessionsDir, "a.jsonl"),
			session("one", "/work/alpha", [
				{
					id: "m1",
					timestamp: "2026-08-11T00:01:00.000Z",
					role: "user",
					content: "remember the default index path",
				},
			]),
			"utf8",
		);

		const pi = new FakePi();
		localKnowledgeTools(pi as unknown as ExtensionAPI);
		const tool = pi.tools.get("session_search");
		assert.ok(tool);
		const result = await tool.execute("call-1", { query: "default index" });
		assert.match(String(result.content?.[0]?.text ?? result), /default index/i);

		const db = new DatabaseSync(
			join(root, "pi-honcho", "session-search.sqlite"),
		);
		try {
			const count = (
				db.prepare("SELECT COUNT(*) AS count FROM messages").get() as {
					count: number;
				}
			).count;
			assert.ok(count > 0);
		} finally {
			db.close();
		}
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousSessionDir === undefined)
			delete process.env.PI_CODING_AGENT_SESSION_DIR;
		else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessionDir;
		await rm(root, { recursive: true, force: true });
	}
});

test("package registers local tools separately from the Honcho extension", async () => {
	const manifest: unknown = JSON.parse(
		await readFile(new URL("../package.json", import.meta.url), "utf8"),
	);
	if (
		!manifest ||
		typeof manifest !== "object" ||
		!("pi" in manifest) ||
		!manifest.pi ||
		typeof manifest.pi !== "object" ||
		!("extensions" in manifest.pi) ||
		!Array.isArray(manifest.pi.extensions)
	)
		throw new Error("package manifest is missing pi.extensions");
	assert.deepEqual(manifest.pi.extensions, [
		"./src/index.ts",
		"./src/local-tools.ts",
	]);
});

test("session_search registers the established public tool contract", () => {
	const pi = new FakePi();
	localKnowledgeTools(pi as unknown as ExtensionAPI);
	const tool = pi.tools.get("session_search");
	assert.ok(tool);
	assert.deepEqual(Object.keys(tool).sort(), [
		"description",
		"execute",
		"label",
		"name",
		"parameters",
		"promptGuidelines",
		"promptSnippet",
	]);
	assert.deepEqual(
		{
			name: tool.name,
			label: tool.label,
			description: tool.description,
			promptSnippet: tool.promptSnippet,
			promptGuidelines: tool.promptGuidelines,
			parameters: JSON.parse(JSON.stringify(tool.parameters)),
		},
		{
			name: "session_search",
			label: "Session Search",
			description: `Search across past Pi coding sessions for relevant conversation context. Use this when the user asks about previous discussions, past work, or when you need context from earlier sessions.

Examples:
- "What did we discuss about auth last week?"
- "Find the PR where we fixed the test hang"
- "What approach did we take for the database migration?"

Returns bounded conversation snippets with session dates and project context. Large messages are truncated with their original character count.`,
			promptSnippet: "Search past conversations for relevant context",
			promptGuidelines: [
				"Use session_search when the user asks about previous discussions or past work.",
				"Use session_search when you need context from earlier sessions.",
			],
			parameters: {
				type: "object",
				properties: {
					query: {
						type: "string",
						description:
							"Search query. Use natural language or specific terms.",
					},
					project: {
						type: "string",
						description: "Filter by project name (optional).",
					},
					role: {
						type: "string",
						enum: ["user", "assistant"],
						description: "Filter by message role (optional).",
					},
					limit: {
						type: "number",
						description:
							"Maximum results to return (default: 10, min: 1, max: 20).",
						minimum: 1,
						maximum: 20,
					},
					snippetChars: {
						type: "number",
						description:
							"Maximum characters per result snippet (default: 1200, max: 4000).",
						minimum: 100,
						maximum: 4000,
					},
				},
				required: ["query"],
			},
		},
	);
});

test("session_search rebuilds from Pi JSONL and preserves filters, FTS operators, and bounds", async () => {
	const fixture = await setup();
	try {
		await fixture.writeSession(
			"one.jsonl",
			session("one", "/work/alpha", [
				{
					id: "first",
					timestamp: "2026-08-11T00:01:00.000Z",
					role: "user",
					content: "alpha needle",
				},
				{
					id: "second",
					timestamp: "2026-08-11T00:02:00.000Z",
					role: "assistant",
					content: [{ type: "text", text: "beta needle and a long response" }],
				},
			]),
		);
		await fixture.writeSession(
			"two.jsonl",
			session("two", "/work/beta", [
				{
					id: "third",
					timestamp: "2026-08-11T00:03:00.000Z",
					role: "assistant",
					content: "gamma needle",
				},
			]),
		);

		const filtered = await fixture.search("search-1", {
			query: "needle",
			project: "alpha",
			role: "assistant",
			limit: 1,
			snippetChars: 12,
		});
		assert.match(
			filtered.content[0]?.text ?? "",
			/Found 1 results for "needle"/,
		);
		assert.match(filtered.content[0]?.text ?? "", /beta needle/);
		assert.equal(filtered.details.count, 1);
		assert.equal(filtered.details.snippetChars, 100);
		assert.equal(filtered.details.truncatedCount, 0);

		const operator = await fixture.search("search-2", {
			query: "alpha OR gamma",
		});
		assert.match(operator.content[0]?.text ?? "", /alpha needle/);
		assert.match(operator.content[0]?.text ?? "", /gamma needle/);
	} finally {
		await rm(fixture.directory, { recursive: true, force: true });
	}
});

test("session_search reindexes changed and deleted files without stale or duplicate messages", async () => {
	const fixture = await setup();
	try {
		const file = await fixture.writeSession(
			"changed.jsonl",
			session("changed", "/work/alpha", [
				{
					id: "message",
					timestamp: "2026-08-11T00:01:00.000Z",
					role: "user",
					content: "old-term",
				},
			]),
		);
		assert.match(
			(await fixture.search("search-1", { query: "old-term" })).content[0]
				?.text ?? "",
			/old-term/,
		);

		await writeFile(
			file,
			session("changed", "/work/alpha", [
				{
					id: "message",
					timestamp: "2026-08-11T00:02:00.000Z",
					role: "user",
					content: "new-term extra",
				},
			]),
		);
		assert.match(
			(await fixture.search("search-2", { query: "new-term" })).content[0]
				?.text ?? "",
			/new-term extra/,
		);
		assert.match(
			(await fixture.search("search-3", { query: "old-term" })).content[0]
				?.text ?? "",
			/No results found/,
		);

		await unlink(file);
		assert.match(
			(await fixture.search("search-4", { query: "new-term" })).content[0]
				?.text ?? "",
			/No sessions indexed yet/,
		);
	} finally {
		await rm(fixture.directory, { recursive: true, force: true });
	}
});

test("session_search removes a changed malformed session while keeping other sessions searchable", async () => {
	const fixture = await setup();
	try {
		const changed = await fixture.writeSession(
			"changed.jsonl",
			session("changed", "/work/alpha", [
				{
					id: "changed-message",
					timestamp: "2026-08-11T00:01:00.000Z",
					role: "user",
					content: "stale-term",
				},
			]),
		);
		await fixture.writeSession(
			"other.jsonl",
			session("other", "/work/beta", [
				{
					id: "other-message",
					timestamp: "2026-08-11T00:02:00.000Z",
					role: "assistant",
					content: "remaining-term",
				},
			]),
		);
		assert.match(
			(await fixture.search("search-1", { query: "stale-term" })).content[0]
				?.text ?? "",
			/stale-term/,
		);

		await writeFile(changed, '{"type":"session"');
		assert.match(
			(await fixture.search("search-2", { query: "stale-term" })).content[0]
				?.text ?? "",
			/No results found/,
		);
		assert.match(
			(await fixture.search("search-3", { query: "remaining-term" })).content[0]
				?.text ?? "",
			/remaining-term/,
		);
	} finally {
		await rm(fixture.directory, { recursive: true, force: true });
	}
});

test("session_search detects same-size rewrites with a restored mtime", async () => {
	const fixture = await setup();
	try {
		const file = await fixture.writeSession(
			"changed.jsonl",
			session("changed", "/work/alpha", [
				{
					id: "message",
					timestamp: "2026-08-11T00:01:00.000Z",
					role: "user",
					content: "old-term",
				},
			]),
		);
		const preservedMtime = new Date("2026-08-11T00:00:00.000Z");
		await utimes(file, preservedMtime, preservedMtime);
		const before = await stat(file, { bigint: true });
		assert.match(
			(await fixture.search("search-1", { query: "old-term" })).content[0]
				?.text ?? "",
			/old-term/,
		);

		await writeFile(
			file,
			session("changed", "/work/alpha", [
				{
					id: "message",
					timestamp: "2026-08-11T00:01:00.000Z",
					role: "user",
					content: "new-term",
				},
			]),
		);
		await utimes(file, preservedMtime, preservedMtime);
		const after = await stat(file, { bigint: true });
		assert.equal(after.size, before.size);
		assert.equal(after.mtimeNs, before.mtimeNs);
		assert.notEqual(after.ctimeNs, before.ctimeNs);

		assert.match(
			(await fixture.search("search-2", { query: "new-term" })).content[0]
				?.text ?? "",
			/new-term/,
		);
		assert.match(
			(await fixture.search("search-3", { query: "old-term" })).content[0]
				?.text ?? "",
			/No results found/,
		);
	} finally {
		await rm(fixture.directory, { recursive: true, force: true });
	}
});

test("session_search reindexes legacy rows without logical identities", async () => {
	const fixture = await setup();
	try {
		const contents = session("legacy", "/work/alpha", [
			{
				id: "message",
				timestamp: "2026-08-11T00:01:00.000Z",
				role: "user",
				content: "upgraded-term",
			},
		]);
		const file = await fixture.writeSession("legacy.jsonl", contents);
		const metadata = await stat(file);
		const database = new DatabaseSync(join(fixture.directory, "index.sqlite"));
		try {
			database.exec(`
				CREATE TABLE session_files (
					path TEXT PRIMARY KEY,
					size INTEGER NOT NULL,
					mtime_ms INTEGER NOT NULL,
					fingerprint TEXT NOT NULL
				);
				CREATE TABLE messages (
					source_path TEXT NOT NULL REFERENCES session_files(path) ON DELETE CASCADE,
					entry_id TEXT NOT NULL,
					session_id TEXT NOT NULL,
					project TEXT NOT NULL,
					cwd TEXT NOT NULL,
					role TEXT NOT NULL,
					content TEXT NOT NULL,
					timestamp TEXT NOT NULL,
					PRIMARY KEY (source_path, entry_id)
				);
				CREATE VIRTUAL TABLE message_fts USING fts5(content, content='messages', content_rowid='rowid');
				CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
					INSERT INTO message_fts(rowid, content) VALUES (new.rowid, new.content);
				END;
				CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
					INSERT INTO message_fts(message_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
				END;
			`);
			database
				.prepare(
					"INSERT INTO session_files(path, size, mtime_ms, fingerprint) VALUES (?, ?, ?, ?)",
				)
				.run(
					file,
					metadata.size,
					Math.trunc(metadata.mtimeMs),
					createHash("sha256").update(contents).digest("hex"),
				);
			database
				.prepare(
					"INSERT INTO messages(source_path, entry_id, session_id, project, cwd, role, content, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					file,
					"message",
					"legacy",
					"alpha",
					"/work/alpha",
					"user",
					"upgraded-term",
					"2026-08-11T00:01:00.000Z",
				);
		} finally {
			database.close();
		}

		assert.match(
			(await fixture.search("search-1", { query: "upgraded-term" })).content[0]
				?.text ?? "",
			/upgraded-term/,
		);
		const upgraded = new DatabaseSync(join(fixture.directory, "index.sqlite"));
		try {
			assert.match(
				upgraded
					.prepare("SELECT logical_id FROM messages WHERE source_path = ?")
					.get(file)?.logical_id as string,
				/^[0-9a-f]{64}$/,
			);
		} finally {
			upgraded.close();
		}
	} finally {
		await rm(fixture.directory, { recursive: true, force: true });
	}
});

test("session_search reindexes non-empty logical IDs from the prior algorithm", async () => {
	const fixture = await setup();
	try {
		const timestamp = "2026-08-11T00:01:00.000Z";
		const content = "versioned shared needle";
		const parent = await fixture.writeSession(
			"parent.jsonl",
			session("parent", "/work/alpha", [
				{
					id: "shared",
					parentId: "removed-label",
					timestamp,
					role: "user",
					content,
				},
			]),
		);
		const fork = await fixture.writeSession(
			"fork.jsonl",
			session(
				"fork",
				"/work/alpha",
				[
					{
						id: "shared",
						parentId: "first",
						timestamp,
						role: "user",
						content,
					},
				],
				parent,
			),
		);
		assert.equal(
			(await fixture.search("search-1", { query: "versioned" })).details.count,
			1,
		);

		const database = new DatabaseSync(join(fixture.directory, "index.sqlite"));
		try {
			const update = database.prepare(
				"UPDATE messages SET logical_id = ? WHERE source_path = ? AND entry_id = 'shared'",
			);
			for (const [path, parentId] of [
				[parent, "removed-label"],
				[fork, "first"],
			] as const)
				update.run(
					createHash("sha256")
						.update(
							JSON.stringify(["shared", parentId, "user", timestamp, content]),
						)
						.digest("hex"),
					path,
				);
			database.exec("ALTER TABLE session_files DROP COLUMN logical_id_version");
		} finally {
			database.close();
		}

		assert.equal(
			(await fixture.search("search-2", { query: "versioned" })).details.count,
			1,
		);
		const upgraded = new DatabaseSync(join(fixture.directory, "index.sqlite"));
		try {
			const versions = upgraded
				.prepare(
					"SELECT DISTINCT logical_id_version FROM session_files ORDER BY logical_id_version",
				)
				.all() as Array<{ logical_id_version: number }>;
			assert.deepEqual(
				versions.map(({ logical_id_version }) => logical_id_version),
				[2],
			);
		} finally {
			upgraded.close();
		}
	} finally {
		await rm(fixture.directory, { recursive: true, force: true });
	}
});

test("session_search deduplicates copied fork history after label parent rechaining", async () => {
	const fixture = await setup();
	try {
		const parent = await fixture.writeSession(
			"parent.jsonl",
			session("parent", "/work/alpha", [
				{
					id: "first",
					parentId: "root",
					timestamp: "2026-08-11T00:00:00.000Z",
					role: "user",
					content: "setup context",
				},
				{
					id: "shared",
					parentId: "removed-label",
					timestamp: "2026-08-11T00:01:00.000Z",
					role: "user",
					content: "shared needle",
				},
			]),
		);
		await fixture.writeSession(
			"fork.jsonl",
			session(
				"fork",
				"/work/alpha",
				[
					{
						id: "first",
						parentId: "root",
						timestamp: "2026-08-11T00:00:00.000Z",
						role: "user",
						content: "setup context",
					},
					{
						id: "shared",
						parentId: "first",
						timestamp: "2026-08-11T00:01:00.000Z",
						role: "user",
						content: "shared needle",
					},
					{
						id: "fork-only",
						parentId: "shared",
						timestamp: "2026-08-11T00:02:00.000Z",
						role: "assistant",
						content: "fork needle",
					},
				],
				parent,
			),
		);

		const result = await fixture.search("search-1", {
			query: "needle",
			limit: 20,
		});
		assert.equal(result.details.count, 2);
		assert.equal(
			(result.content[0]?.text.match(/shared needle/g) ?? []).length,
			1,
		);
		assert.match(result.content[0]?.text ?? "", /fork needle/);

		await unlink(parent);
		assert.match(
			(await fixture.search("search-2", { query: "shared" })).content[0]
				?.text ?? "",
			/shared needle/,
		);
		assert.match(
			(await fixture.search("search-3", { query: "fork" })).content[0]?.text ??
				"",
			/fork needle/,
		);
	} finally {
		await rm(fixture.directory, { recursive: true, force: true });
	}
});

test("session_search keeps unrelated messages with colliding entry IDs", async () => {
	const fixture = await setup();
	try {
		await fixture.writeSession(
			"alpha.jsonl",
			session("alpha", "/work/alpha", [
				{
					id: "deadbeef",
					parentId: "alpha-root",
					timestamp: "2026-08-11T00:01:00.000Z",
					role: "user",
					content: "alpha collision needle",
				},
			]),
		);
		await fixture.writeSession(
			"beta.jsonl",
			session("beta", "/work/beta", [
				{
					id: "deadbeef",
					parentId: "beta-root",
					timestamp: "2026-08-11T00:02:00.000Z",
					role: "assistant",
					content: "beta collision needle",
				},
			]),
		);

		const result = await fixture.search("search-1", {
			query: "collision",
			limit: 20,
		});
		assert.equal(result.details.count, 2);
		assert.match(result.content[0]?.text ?? "", /alpha collision needle/);
		assert.match(result.content[0]?.text ?? "", /beta collision needle/);
	} finally {
		await rm(fixture.directory, { recursive: true, force: true });
	}
});

test("session_search expands ordinary text but retains valid explicit operator semantics", async () => {
	const fixture = await setup();
	try {
		await fixture.writeSession(
			"searches.jsonl",
			session("searches", "/work/alpha", [
				{
					id: "naruto",
					timestamp: "2026-08-11T12:00:00.000Z",
					role: "user",
					content: "The user name is Naruto",
				},
				{
					id: "sakura",
					timestamp: "2026-08-11T12:01:00.000Z",
					role: "assistant",
					content: "Sakura is not Naruto",
				},
				{
					id: "cjk",
					timestamp: "2026-08-11T12:02:00.000Z",
					role: "user",
					content: "ユーザーの名前はナルトです",
				},
			]),
		);

		const naturalLanguage = await fixture.search("search-1", {
			query: "name identity Naruto",
		});
		assert.match(
			naturalLanguage.content[0]?.text ?? "",
			/The user name is Naruto/,
		);
		assert.equal(naturalLanguage.details.count, 2);

		const operator = await fixture.search("search-2", {
			query: "Sakura AND Naruto",
		});
		assert.match(operator.content[0]?.text ?? "", /Sakura is not Naruto/);
		assert.doesNotMatch(
			operator.content[0]?.text ?? "",
			/The user name is Naruto/,
		);
		assert.equal(operator.details.count, 1);

		const noBroadenedOperator = await fixture.search("search-3", {
			query: "Sakura AND name",
		});
		assert.match(
			noBroadenedOperator.content[0]?.text ?? "",
			/No results found/,
		);

		const cjk = await fixture.search("search-4", { query: "ナルト" });
		assert.match(cjk.content[0]?.text ?? "", /ユーザーの名前はナルトです/);

		const injection = await fixture.search("search-5", {
			query: "ナルト' OR 1=1 --",
		});
		assert.match(injection.content[0]?.text ?? "", /No results found/);
	} finally {
		await rm(fixture.directory, { recursive: true, force: true });
	}
});

test("session_search renders localized dates and established empty results", async () => {
	const fixture = await setup();
	try {
		assert.equal(
			(await fixture.search("search-0", { query: "needle" })).content[0]?.text,
			"No sessions indexed yet. Pi JSONL sessions are indexed automatically when available.",
		);
		assert.equal(
			(await fixture.search("search-empty", { query: " " })).content[0]?.text,
			"query is required",
		);
		await fixture.writeSession(
			"dated.jsonl",
			session("dated", "/work/alpha", [
				{
					id: "dated-message",
					timestamp: "2026-08-11T12:00:00.000Z",
					role: "user",
					content: "dated needle",
				},
			]),
		);
		const result = await fixture.search("search-1", { query: "needle" });
		assert.equal(
			result.content[0]?.text,
			'Found 1 results for "needle":\n\n---\n📅 Aug 11, 2026 | 📁 alpha | 👤 User\ndated needle',
		);
		assert.match(
			(await fixture.search("search-2", { query: "missing" })).content[0]
				?.text ?? "",
			/No results found. Try a different search term or broader query./,
		);
	} finally {
		await rm(fixture.directory, { recursive: true, force: true });
	}
});

test("session_search retains valid messages beside a truncated JSONL line", async () => {
	const fixture = await setup();
	try {
		await fixture.writeSession(
			"partial.jsonl",
			`${session("partial", "/work/alpha", [
				{
					id: "first",
					timestamp: "2026-08-11T00:01:00.000Z",
					role: "user",
					content: "first complete needle",
				},
				{
					id: "second",
					timestamp: "2026-08-11T00:02:00.000Z",
					role: "assistant",
					content: "second complete needle",
				},
			])}\n{"type":"message"`,
		);

		const result = await fixture.search("search-1", { query: "complete" });
		assert.equal(result.details.count, 2);
		assert.match(result.content[0]?.text ?? "", /first complete needle/);
		assert.match(result.content[0]?.text ?? "", /second complete needle/);
	} finally {
		await rm(fixture.directory, { recursive: true, force: true });
	}
});

test("session_search reuses an unchanged indexed session without reading it", async () => {
	let reads = 0;
	let unreadable = false;
	const fixture = await setup({
		readSession: async (path) => {
			reads += 1;
			if (unreadable) throw new Error("session is unreadable");
			return readFile(path, "utf8");
		},
	});
	try {
		await fixture.writeSession(
			"cached.jsonl",
			session("cached", "/work/alpha", [
				{
					id: "cached-message",
					timestamp: "2026-08-11T00:01:00.000Z",
					role: "user",
					content: "cached needle",
				},
			]),
		);
		assert.match(
			(await fixture.search("search-1", { query: "cached" })).content[0]
				?.text ?? "",
			/cached needle/,
		);
		unreadable = true;
		assert.match(
			(await fixture.search("search-2", { query: "cached" })).content[0]
				?.text ?? "",
			/cached needle/,
		);
		assert.equal(reads, 1);
	} finally {
		await rm(fixture.directory, { recursive: true, force: true });
	}
});

test("session_search skips malformed JSONL and safely falls back from invalid FTS syntax", async () => {
	const fixture = await setup();
	try {
		await fixture.writeSession("broken.jsonl", "{not json\n");
		await fixture.writeSession(
			"valid.jsonl",
			session("valid", "/work/alpha", [
				{
					id: "message",
					timestamp: "2026-08-11T00:01:00.000Z",
					role: "user",
					content: "fallback needle",
				},
			]),
		);

		const result = await fixture.search("search-1", { query: '"fallback' });
		assert.match(result.content[0]?.text ?? "", /fallback needle/);
	} finally {
		await rm(fixture.directory, { recursive: true, force: true });
	}
});
