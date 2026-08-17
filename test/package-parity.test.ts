import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	type ExtensionAPI,
	type ExtensionContext,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

import piHoncho from "../src/index.js";
import localKnowledgeTools from "../src/local/index.js";
import honchoMemory from "../src/remote/index.js";

type ToolResult = {
	content: Array<{ type?: string; text: string }>;
	details?: Record<string, unknown>;
};
type RegisteredTool = {
	name: string;
	execute: (id: string, args: Record<string, unknown>) => Promise<ToolResult>;
};
type LifecycleHandler = (...args: unknown[]) => unknown;
type ResourceHandler = (event: {
	cwd: string;
}) => Promise<{ skillPaths?: string[] }>;

/** Fake ExtensionAPI that accumulates multi-handler lifecycle registrations. */
class PackageFakePi {
	readonly tools = new Map<string, RegisteredTool>();
	readonly commands = new Map<string, { name: string }>();
	readonly handlers = new Map<string, LifecycleHandler[]>();
	activeTools = ["read"];

	registerTool(tool: RegisteredTool): void {
		assert.equal(
			this.tools.has(tool.name),
			false,
			`duplicate tool registration: ${tool.name}`,
		);
		this.tools.set(tool.name, tool);
	}

	registerCommand(name: string): void {
		assert.equal(
			this.commands.has(name),
			false,
			`duplicate command registration: ${name}`,
		);
		this.commands.set(name, { name });
	}

	on(event: string, handler: LifecycleHandler): void {
		const existing = this.handlers.get(event) ?? [];
		existing.push(handler);
		this.handlers.set(event, existing);
	}

	getActiveTools(): string[] {
		return this.activeTools;
	}

	setActiveTools(names: string[]): void {
		this.activeTools = names;
	}

	appendEntry(): void {}
}

const EXPECTED_TOOLS = [
	"honcho_chat",
	"honcho_remember",
	"honcho_search",
	"session_search",
	"skill_manage",
].sort();
const EXPECTED_COMMANDS = [
	"honcho",
	"honcho-forget",
	"honcho-project-policy",
	"honcho-reset-workspace",
	"honcho-setup",
	"honcho-status",
	"memory-pin",
].sort();
const RETIRED_MEMORY_TOOLS = [
	"memory_add",
	"memory_replace",
	"memory_remove",
	"memory_search",
] as const;
const RETIRED_HERMES_COMMANDS = [
	"memory-consolidate",
	"memory-insights",
	"memory-sync-markdown",
	"memory-switch-project",
	"memory-index-sessions",
	"memory-interview",
	"memory-skills",
	"memory-preview-context",
	"learn-memory-tool",
] as const;

function restoreEnvironment(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

async function waitFor(check: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 500; attempt += 1) {
		if (check()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Timed out waiting for lifecycle work");
}

function connectedClient() {
	return {
		checkConnection: async () => undefined,
		fetchCachedMemory: async () => ({}),
		deliverExchange: async () => ["remote-1"],
		reconcileOperationId: async () => [],
		cloneSession: async () => "cloned-session",
		search: async () => [],
		chat: async () => undefined,
		remember: async () => "conclusion-1",
		deleteSession: async () => undefined,
		deleteConclusion: async () => undefined,
		inspectWorkspace: async () => ({
			workspaceId: "pi",
			peerIds: [],
			sessionCount: 0,
			conclusionCount: 0,
		}),
		deleteWorkspace: async () => undefined,
	};
}

function startupContext(
	cwd: string,
	statuses: string[] = [],
): ExtensionContext {
	return {
		cwd,
		hasUI: true,
		isProjectTrusted: () => false,
		sessionManager: {
			getSessionId: () => "pi-session",
			getEntries: () => [],
			getBranch: () => [],
		},
		ui: {
			setStatus: (_key: string, value: string) => statuses.push(value),
			notify: () => undefined,
		},
	} as unknown as ExtensionContext;
}

function sessionJsonl(
	id: string,
	cwd: string,
	entries: Array<{
		id: string;
		timestamp: string;
		role: string;
		content: unknown;
	}>,
): string {
	return [
		JSON.stringify({
			type: "session",
			version: 3,
			id,
			timestamp: "2026-08-11T00:00:00.000Z",
			cwd,
		}),
		...entries.map((entry) =>
			JSON.stringify({
				type: "message",
				parentId: null,
				id: entry.id,
				timestamp: entry.timestamp,
				message: { role: entry.role, content: entry.content },
			}),
		),
	].join("\n");
}

async function skillOutput(
	tool: RegisteredTool,
	input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const result = await tool.execute("test", input);
	const text = result.content[0]?.text ?? "{}";
	try {
		return JSON.parse(text) as Record<string, unknown>;
	} catch {
		assert.fail(`skill_manage returned invalid JSON: ${text}`);
	}
}

async function loadPackage(
	options: { root?: string; cwd?: string } = {},
): Promise<{
	pi: PackageFakePi;
	root: string;
	cwd: string;
	cleanup: () => Promise<void>;
}> {
	const root =
		options.root ??
		(await mkdtemp(join(tmpdir(), "pi-honcho-package-parity-")));
	const cwd = options.cwd ?? join(root, "repo");
	await mkdir(cwd, { recursive: true });
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	process.env.PI_CODING_AGENT_SESSION_DIR = join(root, "sessions");
	const pi = new PackageFakePi();
	piHoncho(pi as unknown as ExtensionAPI);
	return {
		pi,
		root,
		cwd,
		cleanup: async () => {
			restoreEnvironment("PI_CODING_AGENT_DIR", previousAgentDir);
			restoreEnvironment("PI_CODING_AGENT_SESSION_DIR", previousSessionDir);
			await rm(root, { recursive: true, force: true });
		},
	};
}

async function chainBeforeAgentStart(
	handlers: LifecycleHandler[],
	systemPrompt: string,
	ctx: ExtensionContext,
): Promise<string> {
	let prompt = systemPrompt;
	for (const handler of handlers) {
		const result = await handler(
			{ prompt: "user turn", systemPrompt: prompt },
			ctx,
		);
		if (result && typeof result === "object" && "systemPrompt" in result) {
			const next = (result as { systemPrompt?: string }).systemPrompt;
			if (typeof next === "string") prompt = next;
		}
	}
	return prompt;
}

test("package root registers remote then local behavior exactly once", async () => {
	const previousEnabled = process.env.HONCHO_ENABLED;
	process.env.HONCHO_ENABLED = "0";
	const fixture = await loadPackage();
	try {
		assert.deepEqual([...fixture.pi.tools.keys()].sort(), EXPECTED_TOOLS);
		assert.deepEqual([...fixture.pi.commands.keys()].sort(), EXPECTED_COMMANDS);

		for (const name of RETIRED_MEMORY_TOOLS)
			assert.equal(
				fixture.pi.tools.has(name),
				false,
				`retired tool still registered: ${name}`,
			);
		for (const name of RETIRED_HERMES_COMMANDS)
			assert.equal(
				fixture.pi.commands.has(name),
				false,
				`retired Hermes command still registered: ${name}`,
			);

		assert.deepEqual(
			Object.fromEntries(
				[...fixture.pi.handlers]
					.sort(([left], [right]) => left.localeCompare(right))
					.map(([name, handlers]) => [name, handlers.length]),
			),
			{
				agent_settled: 1,
				before_agent_start: 2,
				context: 1,
				resources_discover: 1,
				session_before_compact: 1,
				session_before_fork: 1,
				session_before_switch: 1,
				session_shutdown: 1,
				session_start: 1,
			},
		);
	} finally {
		await fixture.cleanup();
		restoreEnvironment("HONCHO_ENABLED", previousEnabled);
	}
});

test("Herdr subagents load only local knowledge behavior", async () => {
	const previous = process.env.PI_SUBAGENT_ID;
	process.env.PI_SUBAGENT_ID = "child-1";
	const fixture = await loadPackage();
	try {
		assert.deepEqual([...fixture.pi.tools.keys()].sort(), [
			"session_search",
			"skill_manage",
		]);
		assert.deepEqual([...fixture.pi.commands.keys()], ["memory-pin"]);
		assert.deepEqual(
			Object.fromEntries(
				[...fixture.pi.handlers].map(([name, handlers]) => [
					name,
					handlers.length,
				]),
			),
			{ before_agent_start: 1, resources_discover: 1 },
		);
	} finally {
		await fixture.cleanup();
		restoreEnvironment("PI_SUBAGENT_ID", previous);
	}
});

test("package root exposes local tools and resources while Honcho is disabled", async () => {
	const previousEnabled = process.env.HONCHO_ENABLED;
	process.env.HONCHO_ENABLED = "0";
	const root = await mkdtemp(join(tmpdir(), "pi-honcho-package-exercise-"));
	const cwd = join(root, "repo");
	await mkdir(join(cwd, ".git"), { recursive: true });
	const sessionsDir = join(root, "sessions", "repo");
	await mkdir(sessionsDir, { recursive: true });
	await writeFile(
		join(sessionsDir, "one.jsonl"),
		sessionJsonl("one", cwd, [
			{
				id: "first",
				timestamp: "2026-08-11T00:01:00.000Z",
				role: "user",
				content: "package parity needle alpha",
			},
			{
				id: "second",
				timestamp: "2026-08-11T00:02:00.000Z",
				role: "assistant",
				content: [{ type: "text", text: "package parity needle beta" }],
			},
		]),
	);

	const fixture = await loadPackage({ root, cwd });
	try {
		const search = fixture.pi.tools.get("session_search");
		const skills = fixture.pi.tools.get("skill_manage");
		const resources = fixture.pi.handlers.get("resources_discover")?.[0] as
			| ResourceHandler
			| undefined;
		assert.ok(search);
		assert.ok(skills);
		assert.ok(resources);

		const found = await search.execute("search-1", {
			query: "needle",
			project: "repo",
			limit: 5,
		});
		assert.match(
			found.content[0]?.text ?? "",
			/Found \d+ results for "needle"/,
		);
		assert.match(found.content[0]?.text ?? "", /package parity needle/);
		assert.equal(found.details?.success, true);
		assert.ok(Number(found.details?.count) >= 1);

		await resources({ cwd });
		const created = await skillOutput(skills, {
			action: "create",
			name: "parity-probe",
			description: "Package parity project skill",
			scope: "project",
			content: "Use for dual-module parity proof only.",
		});
		assert.equal(created.success, true);
		assert.equal(created.skillId, "project:repo:parity-probe");

		const listed = await skillOutput(skills, { action: "view" });
		const skillIds = (
			(listed.skills as Array<{ skillId: string }> | undefined) ?? []
		).map((item) => item.skillId);
		assert.ok(skillIds.includes("project:repo:parity-probe"));

		const viewed = await skillOutput(skills, {
			action: "view",
			skill_id: "project:repo:parity-probe",
		});
		assert.equal(viewed.success, true);
		assert.match(String(viewed.body), /dual-module parity proof/);

		const discovered = await resources({ cwd });
		assert.ok(
			discovered.skillPaths?.includes(
				join(root, "agent", "projects-memory", "repo", "skills"),
			),
		);
		assert.equal(
			await readFile(
				join(
					root,
					"agent",
					"projects-memory",
					"repo",
					"skills",
					"parity-probe",
					"SKILL.md",
				),
				"utf8",
			).then((text) => text.includes("parity-probe")),
			true,
		);
	} finally {
		await fixture.cleanup();
		restoreEnvironment("HONCHO_ENABLED", previousEnabled);
	}
});

test("package root adds standing instructions after the offline remote handler", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-honcho-package-standing-"));
	const agentDir = join(root, "agent");
	const standingFilePath = join(agentDir, "pi-hermes-memory", "STANDING.md");
	await mkdir(join(agentDir, "pi-hermes-memory"), { recursive: true });
	await writeFile(standingFilePath, "Prefer small focused diffs\n", "utf8");

	const previous = Object.fromEntries(
		["HONCHO_ENABLED", "HONCHO_API_KEY"].map((name) => [
			name,
			process.env[name],
		]),
	);
	const sessionManager = SessionManager as unknown as {
		listAll: () => Promise<Array<{ path: string }>>;
	};
	const listAll = sessionManager.listAll;
	sessionManager.listAll = async () => [];

	try {
		process.env.HONCHO_ENABLED = "0";
		delete process.env.HONCHO_API_KEY;
		const offlineRoot = join(root, "offline");
		await mkdir(join(offlineRoot, "agent", "pi-hermes-memory"), {
			recursive: true,
		});
		await writeFile(
			join(offlineRoot, "agent", "pi-hermes-memory", "STANDING.md"),
			"Prefer small focused diffs\n",
			"utf8",
		);
		const offline = await loadPackage({ root: offlineRoot });
		try {
			const handlers = offline.pi.handlers.get("before_agent_start") ?? [];
			assert.equal(handlers.length, 2);
			const ctx = startupContext(offline.cwd);
			assert.equal(
				await chainBeforeAgentStart([handlers[0]], "base system prompt", ctx),
				"base system prompt",
			);
			const prompt = await chainBeforeAgentStart(
				handlers,
				"base system prompt",
				ctx,
			);
			assert.match(prompt, /<standing-instructions>/);
			assert.match(prompt, /Prefer small focused diffs/);
			assert.match(prompt, /^base system prompt/);
		} finally {
			await offline.cleanup();
		}

		process.env.HONCHO_API_KEY = "test-key";
		delete process.env.HONCHO_ENABLED;
		const statuses: string[] = [];
		const connectedRoot = join(root, "connected");
		const connectedCwd = join(connectedRoot, "repo");
		await mkdir(connectedCwd, { recursive: true });
		const connectedPi = new PackageFakePi();
		honchoMemory(
			connectedPi as unknown as ExtensionAPI,
			() => connectedClient() as never,
		);
		localKnowledgeTools(connectedPi as unknown as ExtensionAPI, {
			agentDir,
			standingFilePath,
			standingEnabled: true,
			cwd: connectedCwd,
		});
		const ctx = startupContext(connectedCwd, statuses);
		const sessionStart = connectedPi.handlers.get("session_start")?.[0] as
			| ((event: { reason: "startup" }, ctx: ExtensionContext) => Promise<void>)
			| undefined;
		const sessionShutdown = connectedPi.handlers.get("session_shutdown")?.[0] as
			| ((event: unknown, ctx: ExtensionContext) => Promise<void>)
			| undefined;
		assert.ok(sessionStart);
		try {
			await sessionStart({ reason: "startup" }, ctx);
			await waitFor(
				() =>
					connectedPi.activeTools.includes("honcho_search") &&
					connectedPi.activeTools.includes("honcho_chat") &&
					connectedPi.activeTools.includes("honcho_remember"),
			);
			assert.ok(
				statuses.some((status) => /^Honcho: connected · .+$/i.test(status)),
			);

			const handlers = connectedPi.handlers.get("before_agent_start") ?? [];
			assert.equal(handlers.length, 2);
			const prompt = await chainBeforeAgentStart(
				handlers,
				"base system prompt",
				ctx,
			);
			assert.match(prompt, /<standing-instructions>/);
			assert.match(prompt, /Prefer small focused diffs/);
			assert.match(prompt, /^base system prompt/);
		} finally {
			if (sessionShutdown) await sessionShutdown({}, ctx);
			await rm(connectedRoot, { recursive: true, force: true });
		}
	} finally {
		sessionManager.listAll = listAll;
		restoreEnvironment("HONCHO_ENABLED", previous.HONCHO_ENABLED);
		restoreEnvironment("HONCHO_API_KEY", previous.HONCHO_API_KEY);
		await rm(root, { recursive: true, force: true });
	}
});

test("package manifest lists only the composition root", async () => {
	const manifest: unknown = JSON.parse(
		await readFile(new URL("../package.json", import.meta.url), "utf8"),
	);
	assert.ok(manifest && typeof manifest === "object" && "pi" in manifest);
	const pi = (manifest as { pi?: { extensions?: unknown } }).pi;
	assert.ok(pi && typeof pi === "object");
	assert.deepEqual(pi.extensions, ["./src/index.ts"]);
});
