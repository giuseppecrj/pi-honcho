// Adapted from pi-hermes-memory's MIT-licensed session search behavior.
// See THIRD_PARTY_NOTICES.md for the upstream notice.
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { SkillStore } from "./skill-store.js";
import { registerSkillTool } from "./skill-tool.js";
import { registerStandingInstructions } from "./standing-instructions.js";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 20;
const DEFAULT_SNIPPET_CHARS = 1_200;
const MAX_SNIPPET_CHARS = 4_000;
const MAX_OUTPUT_CHARS = 50 * 1024;

type SearchInput = {
	query: string;
	project?: string;
	role?: string;
	limit?: number;
	snippetChars?: number;
};

type LocalKnowledgeToolsOptions = {
	sessionsDir?: string;
	databasePath?: string;
	readSession?: (path: string) => Promise<string>;
	globalSkillsDir?: string;
	piGlobalSkillsDir?: string;
	projectsMemoryDir?: string;
	projectSkillsDir?: string | null;
	projectName?: string | null;
	cwd?: string;
	/** Injectable agent root for standing-instruction path/config resolution. */
	agentDir?: string;
	/** Injectable STANDING.md path (tests). */
	standingFilePath?: string;
	/** Injectable Hermes config path (tests). */
	standingConfigPath?: string;
	/** Force standing instructions on/off without reading config. */
	standingEnabled?: boolean;
};

type SessionMessage = {
	id: string;
	role: "user" | "assistant";
	content: string;
	timestamp: string;
};

type ParsedSession = {
	id: string;
	project: string;
	cwd: string;
	messages: SessionMessage[];
};

type SearchRow = {
	project: string;
	role: string;
	content: string;
	timestamp: string;
	source_path: string;
	entry_id: string;
};

type Statement = {
	all(...params: unknown[]): unknown[];
	get(...params: unknown[]): unknown;
	run(...params: unknown[]): unknown;
};

type Database = {
	exec(sql: string): void;
	prepare(sql: string): Statement;
	close(): void;
};

type DatabaseConstructor = new (path: string) => Database;

async function openDatabase(path: string): Promise<Database> {
	const moduleId = "bun" in process.versions ? "bun:sqlite" : "node:sqlite";
	const sqlite = (await import(moduleId)) as {
		Database?: DatabaseConstructor;
		DatabaseSync?: DatabaseConstructor;
	};
	const Database = sqlite.DatabaseSync ?? sqlite.Database;
	if (!Database) throw new Error(`No SQLite database export in ${moduleId}`);
	return new Database(path);
}

type SourceMetadata = {
	size: string;
	mtimeNs: string;
	ctimeNs: string;
};

const LOGICAL_ID_VERSION = 2;

function defaultPaths(): Required<
	Pick<LocalKnowledgeToolsOptions, "sessionsDir" | "databasePath">
> {
	const agentDir =
		process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	return {
		sessionsDir:
			process.env.PI_CODING_AGENT_SESSION_DIR ?? join(agentDir, "sessions"),
		databasePath: join(agentDir, "pi-honcho", "session-search.sqlite"),
	};
}

function textContent(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((block) =>
			block &&
			typeof block === "object" &&
			(block as { type?: unknown }).type === "text" &&
			typeof (block as { text?: unknown }).text === "string"
				? [(block as { text: string }).text]
				: [],
		)
		.join("\n")
		.trim();
}

function parseSession(content: string): ParsedSession | undefined {
	let header: { id: string; cwd: string } | undefined;
	const messages: SessionMessage[] = [];
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as {
				type?: unknown;
				id?: unknown;
				cwd?: unknown;
				timestamp?: unknown;
				message?: { role?: unknown; content?: unknown };
			};
			if (
				entry.type === "session" &&
				typeof entry.id === "string" &&
				typeof entry.cwd === "string"
			) {
				header = { id: entry.id, cwd: entry.cwd };
				continue;
			}
			if (
				entry.type !== "message" ||
				typeof entry.id !== "string" ||
				typeof entry.timestamp !== "string" ||
				(entry.message?.role !== "user" && entry.message?.role !== "assistant")
			)
				continue;
			const content = textContent(entry.message.content);
			if (content)
				messages.push({
					id: entry.id,
					role: entry.message.role,
					content,
					timestamp: entry.timestamp,
				});
		} catch {
			// Skip malformed JSONL lines, including an active partial final entry.
		}
	}
	if (!header) return undefined;
	return {
		id: header.id,
		cwd: header.cwd,
		project: basename(header.cwd) || header.cwd,
		messages,
	};
}

async function sessionFiles(directory: string): Promise<string[]> {
	try {
		const entries = await readdir(directory, { withFileTypes: true });
		const files = await Promise.all(
			entries.map(async (entry) => {
				const path = join(directory, entry.name);
				if (entry.isFile()) return entry.name.endsWith(".jsonl") ? [path] : [];
				if (!entry.isDirectory()) return [];
				try {
					return (await readdir(path))
						.filter((name) => name.endsWith(".jsonl"))
						.map((name) => join(path, name));
				} catch {
					return [];
				}
			}),
		);
		return files.flat().sort();
	} catch {
		return [];
	}
}

function initialize(db: Database): void {
	db.exec(`
		PRAGMA foreign_keys = ON;
		CREATE TABLE IF NOT EXISTS session_files (
			path TEXT PRIMARY KEY,
			size INTEGER NOT NULL,
			mtime_ms INTEGER NOT NULL,
			mtime_ns TEXT NOT NULL,
			ctime_ns TEXT NOT NULL,
			fingerprint TEXT NOT NULL,
			logical_id_version INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS messages (
			source_path TEXT NOT NULL REFERENCES session_files(path) ON DELETE CASCADE,
			entry_id TEXT NOT NULL,
			session_id TEXT NOT NULL,
			project TEXT NOT NULL,
			cwd TEXT NOT NULL,
			role TEXT NOT NULL,
			content TEXT NOT NULL,
			timestamp TEXT NOT NULL,
			logical_id TEXT NOT NULL,
			PRIMARY KEY (source_path, entry_id)
		);
	`);
	const columns = db
		.prepare("PRAGMA table_info(session_files)")
		.all() as Array<{
		name: string;
	}>;
	if (!columns.some((column) => column.name === "fingerprint"))
		db.exec(
			"ALTER TABLE session_files ADD COLUMN fingerprint TEXT NOT NULL DEFAULT ''",
		);
	if (!columns.some((column) => column.name === "mtime_ns"))
		db.exec(
			"ALTER TABLE session_files ADD COLUMN mtime_ns TEXT NOT NULL DEFAULT ''",
		);
	if (!columns.some((column) => column.name === "ctime_ns"))
		db.exec(
			"ALTER TABLE session_files ADD COLUMN ctime_ns TEXT NOT NULL DEFAULT ''",
		);
	if (!columns.some((column) => column.name === "logical_id_version"))
		db.exec(
			"ALTER TABLE session_files ADD COLUMN logical_id_version INTEGER NOT NULL DEFAULT 0",
		);
	const messageColumns = db
		.prepare("PRAGMA table_info(messages)")
		.all() as Array<{
		name: string;
	}>;
	if (!messageColumns.some((column) => column.name === "logical_id"))
		db.exec(
			"ALTER TABLE messages ADD COLUMN logical_id TEXT NOT NULL DEFAULT ''",
		);
	db.exec(`
		CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(content, content='messages', content_rowid='rowid');
		CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
			INSERT INTO message_fts(rowid, content) VALUES (new.rowid, new.content);
		END;
		CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
			INSERT INTO message_fts(message_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
		END;
		CREATE INDEX IF NOT EXISTS messages_order ON messages(timestamp DESC, source_path, entry_id);
		CREATE INDEX IF NOT EXISTS messages_logical_id ON messages(logical_id);
	`);
}

function unchanged(
	db: Database,
	path: string,
	metadata: SourceMetadata,
): boolean {
	const row = db
		.prepare(
			"SELECT CAST(size AS TEXT) AS size, mtime_ns, ctime_ns, logical_id_version, NOT EXISTS (SELECT 1 FROM messages WHERE source_path = ? AND logical_id = '') AS logical_ids_ready FROM session_files WHERE path = ?",
		)
		.get(path, path) as
		| {
				size: string;
				mtime_ns: string;
				ctime_ns: string;
				logical_id_version: number;
				logical_ids_ready: number;
		  }
		| undefined;
	return (
		row?.size === metadata.size &&
		row.mtime_ns === metadata.mtimeNs &&
		row.ctime_ns === metadata.ctimeNs &&
		row.logical_id_version === LOGICAL_ID_VERSION &&
		row.logical_ids_ready === 1
	);
}

function contentChanged(
	db: Database,
	path: string,
	fingerprint: string,
): boolean {
	const row = db
		.prepare(
			"SELECT fingerprint, logical_id_version, EXISTS (SELECT 1 FROM messages WHERE source_path = ? AND logical_id = '') AS needs_logical_ids FROM session_files WHERE path = ?",
		)
		.get(path, path) as
		| {
				fingerprint: string;
				logical_id_version: number;
				needs_logical_ids: number;
		  }
		| undefined;
	return (
		!row ||
		row.fingerprint !== fingerprint ||
		row.logical_id_version !== LOGICAL_ID_VERSION ||
		row.needs_logical_ids === 1
	);
}

function logicalId(message: SessionMessage): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				message.id,
				message.role,
				message.timestamp,
				message.content,
			]),
		)
		.digest("hex");
}

function reindex(
	db: Database,
	path: string,
	session: ParsedSession,
	metadata: SourceMetadata,
	fingerprint: string,
): void {
	db.exec("BEGIN");
	try {
		db.prepare("DELETE FROM messages WHERE source_path = ?").run(path);
		db.prepare(
			"INSERT INTO session_files(path, size, mtime_ms, mtime_ns, ctime_ns, fingerprint, logical_id_version) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms, mtime_ns = excluded.mtime_ns, ctime_ns = excluded.ctime_ns, fingerprint = excluded.fingerprint, logical_id_version = excluded.logical_id_version",
		).run(
			path,
			metadata.size,
			Number(BigInt(metadata.mtimeNs) / 1_000_000n),
			metadata.mtimeNs,
			metadata.ctimeNs,
			fingerprint,
			LOGICAL_ID_VERSION,
		);
		const insert = db.prepare(
			"INSERT INTO messages(source_path, entry_id, session_id, project, cwd, role, content, timestamp, logical_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		);
		for (const message of session.messages)
			insert.run(
				path,
				message.id,
				session.id,
				session.project,
				session.cwd,
				message.role,
				message.content,
				message.timestamp,
				logicalId(message),
			);
		db.exec("COMMIT");
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}

async function indexSessions(
	db: Database,
	sessionsDir: string,
	readSession: (path: string) => Promise<string>,
): Promise<void> {
	const files = await sessionFiles(sessionsDir);
	const seen = new Set(files);
	for (const path of files) {
		try {
			const stats = await stat(path, { bigint: true });
			const metadata: SourceMetadata = {
				size: stats.size.toString(),
				mtimeNs: stats.mtimeNs.toString(),
				ctimeNs: stats.ctimeNs.toString(),
			};
			if (unchanged(db, path, metadata)) continue;
			const content = await readSession(path);
			const fingerprint = createHash("sha256").update(content).digest("hex");
			if (contentChanged(db, path, fingerprint)) {
				const session = parseSession(content);
				if (session) reindex(db, path, session, metadata, fingerprint);
				else db.prepare("DELETE FROM session_files WHERE path = ?").run(path);
			} else
				db.prepare(
					"UPDATE session_files SET size = ?, mtime_ms = ?, mtime_ns = ?, ctime_ns = ? WHERE path = ?",
				).run(
					metadata.size,
					Number(BigInt(metadata.mtimeNs) / 1_000_000n),
					metadata.mtimeNs,
					metadata.ctimeNs,
					path,
				);
		} catch {
			// Unreadable or disappearing files are skipped; the next search can retry.
		}
	}
	const indexed = db.prepare("SELECT path FROM session_files").all() as Array<{
		path: string;
	}>;
	for (const { path } of indexed) {
		if (!seen.has(path))
			db.prepare("DELETE FROM session_files WHERE path = ?").run(path);
	}
}

const FTS5_OPERATOR = /\b(?:OR|AND|NOT|NEAR)\b/;

function terms(query: string): string[] {
	return Array.from(query.matchAll(/"([^"]*)"|(\S+)/g))
		.map((match) => (match[1] ?? match[2] ?? "").replaceAll('"', "").trim())
		.filter(Boolean)
		.filter(
			(term) => !["and", "or", "not", "near"].includes(term.toLowerCase()),
		);
}

function quoteTerms(query: string, separator: string): string {
	return terms(query)
		.map((term) => `"${term.replaceAll('"', '""')}"`)
		.join(separator);
}

function isFtsError(error: unknown): boolean {
	return (
		error instanceof Error &&
		/fts5|match|unterminated|string|no such column/i.test(error.message)
	);
}

function rowsFor(
	db: Database,
	match: { query: string } | { terms: string[] },
	input: SearchInput,
	limit: number,
): SearchRow[] {
	const values: Array<string | number> = [];
	const conditions =
		"query" in match
			? ["m.rowid IN (SELECT rowid FROM message_fts WHERE message_fts MATCH ?)"]
			: [
					`(${match.terms
						.map(() => "m.content LIKE ? ESCAPE '\\'")
						.join(" OR ")})`,
				];
	if ("query" in match) values.push(match.query);
	else
		values.push(
			...match.terms.map((term) => `%${term.replace(/[\\%_]/g, "\\$&")}%`),
		);
	if (input.project) {
		conditions.push("m.project = ?");
		values.push(input.project);
	}
	if (input.role) {
		conditions.push("m.role = ?");
		values.push(input.role);
	}
	values.push(limit);
	return db
		.prepare(
			`WITH matching AS (
				SELECT m.project, m.role, m.content, m.timestamp, m.source_path, m.entry_id,
					ROW_NUMBER() OVER (PARTITION BY m.logical_id ORDER BY m.timestamp DESC, m.source_path ASC) AS result_rank
				FROM messages m WHERE ${conditions.join(" AND ")}
			)
			SELECT project, role, content, timestamp, source_path, entry_id FROM matching
			WHERE result_rank = 1
			ORDER BY timestamp DESC, source_path ASC, entry_id ASC LIMIT ?`,
		)
		.all(...values) as SearchRow[];
}

function search(db: Database, input: SearchInput, limit: number): SearchRow[] {
	try {
		const rows = rowsFor(db, { query: input.query.trim() }, input, limit);
		if (rows.length || FTS5_OPERATOR.test(input.query)) return rows;
	} catch (error) {
		if (!isFtsError(error)) throw error;
	}
	for (const fallback of [
		quoteTerms(input.query, " "),
		quoteTerms(input.query, " OR "),
	]) {
		if (!fallback) continue;
		try {
			const rows = rowsFor(db, { query: fallback }, input, limit);
			if (rows.length) return rows;
		} catch (error) {
			if (!isFtsError(error)) throw error;
		}
	}
	const fallbackTerms = terms(input.query);
	return fallbackTerms.length
		? rowsFor(db, { terms: fallbackTerms }, input, limit)
		: [];
}

function bounded(
	value: number | undefined,
	fallback: number,
	minimum: number,
	maximum: number,
): number {
	const number = Number.isFinite(value)
		? Math.floor(value as number)
		: fallback;
	return Math.min(Math.max(number, minimum), maximum);
}

function capOutput(text: string): { text: string; truncated: boolean } {
	if (text.length <= MAX_OUTPUT_CHARS) return { text, truncated: false };
	const suffix = `\n... (output truncated, ${text.length} chars total — refine the query or lower the result limit)`;
	return {
		text: `${text.slice(0, MAX_OUTPUT_CHARS - suffix.length)}${suffix}`,
		truncated: true,
	};
}

type ToolDetails = {
	success: boolean;
	count?: number;
	message?: string;
	truncatedCount?: number;
	snippetChars?: number;
	outputChars?: number;
	outputTruncated?: boolean;
};

function toolResult(
	text: string,
	details: ToolDetails,
): { content: Array<{ type: "text"; text: string }>; details: ToolDetails } {
	return { content: [{ type: "text", text }], details };
}

export default function localKnowledgeTools(
	pi: ExtensionAPI,
	options: LocalKnowledgeToolsOptions = {},
): void {
	const paths = { ...defaultPaths(), ...options };
	const skillStore = new SkillStore({
		globalSkillsDir: options.globalSkillsDir,
		piGlobalSkillsDir: options.piGlobalSkillsDir,
		projectsMemoryDir: options.projectsMemoryDir,
		projectSkillsDir: options.projectSkillsDir,
		projectName: options.projectName,
		cwd: options.cwd,
	});
	registerSkillTool(pi, skillStore);
	registerStandingInstructions(pi, {
		agentDir: options.agentDir,
		filePath: options.standingFilePath,
		configPath: options.standingConfigPath,
		enabled: options.standingEnabled,
	});
	if (typeof pi.on === "function") {
		pi.on("resources_discover", async (event) => {
			await skillStore.setProjectFromCwd(
				event.cwd || options.cwd || process.cwd(),
			);
			await skillStore.ensureRoots();
			const skillPaths = [skillStore.getGlobalSkillsDir()];
			const projectSkillsDir = skillStore.getProjectSkillsDir();
			if (projectSkillsDir) skillPaths.push(projectSkillsDir);
			return { skillPaths };
		});
	}

	const readSession =
		options.readSession ?? ((path: string) => readFile(path, "utf8"));
	pi.registerTool({
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
		parameters: Type.Object({
			query: Type.String({
				description: "Search query. Use natural language or specific terms.",
			}),
			project: Type.Optional(
				Type.String({ description: "Filter by project name (optional)." }),
			),
			role: Type.Optional(
				Type.String({
					enum: ["user", "assistant"],
					description: "Filter by message role (optional).",
				}),
			),
			limit: Type.Optional(
				Type.Number({
					description:
						"Maximum results to return (default: 10, min: 1, max: 20).",
					minimum: 1,
					maximum: MAX_LIMIT,
				}),
			),
			snippetChars: Type.Optional(
				Type.Number({
					description: `Maximum characters per result snippet (default: ${DEFAULT_SNIPPET_CHARS}, max: ${MAX_SNIPPET_CHARS}).`,
					minimum: 100,
					maximum: MAX_SNIPPET_CHARS,
				}),
			),
		}),
		async execute(_id, input: SearchInput) {
			if (!input.query.trim())
				return toolResult("query is required", {
					success: false,
					message: "query is required",
				});
			let db: Database | undefined;
			try {
				await mkdir(dirname(paths.databasePath), { recursive: true });
				db = await openDatabase(paths.databasePath);
				db.exec("PRAGMA busy_timeout = 5000");
				initialize(db);
				await indexSessions(db, paths.sessionsDir, readSession);
				const total = (
					db.prepare("SELECT COUNT(*) AS count FROM messages").get() as {
						count: number;
					}
				).count;
				if (!total)
					return toolResult(
						"No sessions indexed yet. Pi JSONL sessions are indexed automatically when available.",
						{
							success: false,
							message:
								"No sessions indexed yet. Pi JSONL sessions are indexed automatically when available.",
						},
					);
				const limit = bounded(input.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
				const snippetChars = bounded(
					input.snippetChars,
					DEFAULT_SNIPPET_CHARS,
					100,
					MAX_SNIPPET_CHARS,
				);
				const results = search(db, input, limit);
				if (!results.length)
					return toolResult(
						"No results found. Try a different search term or broader query.",
						{
							success: true,
							count: 0,
							message:
								"No results found. Try a different search term or broader query.",
						},
					);
				let truncatedCount = 0;
				const blocks = results.map((result) => {
					const truncated = result.content.length > snippetChars;
					if (truncated) truncatedCount += 1;
					const snippet = truncated
						? `${result.content.slice(0, snippetChars)}\n... (truncated, ${result.content.length} chars total — refine the query or increase snippetChars)`
						: result.content;
					const date = new Date(result.timestamp).toLocaleDateString("en-US", {
						year: "numeric",
						month: "short",
						day: "numeric",
					});
					return [
						"---",
						`📅 ${date} | 📁 ${result.project} | ${result.role === "user" ? "👤 User" : "🤖 Assistant"}`,
						snippet,
					].join("\n");
				});
				const output = capOutput(
					`Found ${results.length} results for "${input.query}":\n\n${blocks.join("\n\n")}`,
				);
				return toolResult(output.text, {
					success: true,
					count: results.length,
					truncatedCount,
					snippetChars,
					outputChars: output.text.length,
					outputTruncated: output.truncated,
				});
			} catch (error) {
				return toolResult(
					`Session search unavailable: ${error instanceof Error ? error.message : "unknown error"}`,
					{ success: false, message: "Session search unavailable" },
				);
			} finally {
				db?.close();
			}
		},
	});
}
