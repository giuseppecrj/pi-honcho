import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	type ExtensionAPI,
	type ExtensionContext,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

import {
	loadHonchoRegistry,
	repositoryOrigin,
	saveHonchoRegistry,
} from "../src/remote/config-file.js";
import honchoMemory from "../src/remote/index.js";
import {
	canonicalRepositoryKey,
	initialRegistry,
	updateRepositoryEntry,
} from "../src/remote/registry.js";

// Pin every user-scoped path before any test runs and never restore them:
// extension startup does fire-and-forget async work (registry writes, oauth
// refresh persisting ~/.honcho/config.json) that must never reach real paths.
const hermeticHome = await mkdtemp(join(tmpdir(), "pi-honcho-agent-home-"));
process.env.HOME = hermeticHome;
process.env.USERPROFILE = hermeticHome;
process.env.PI_CODING_AGENT_DIR = await mkdtemp(
	join(tmpdir(), "pi-honcho-agent-"),
);
process.env.PI_CODING_AGENT_SESSION_DIR = await mkdtemp(
	join(tmpdir(), "pi-honcho-agent-sessions-"),
);
const testRepositoryKey = canonicalRepositoryKey(
	process.cwd(),
	await repositoryOrigin(process.cwd()),
);
await saveHonchoRegistry(
	updateRepositoryEntry(initialRegistry(), testRepositoryKey, {
		workspaceId: "pi",
		enabled: true,
	}),
);

class FakePiRuntime {
	readonly handlers = new Map<string, unknown>();
	readonly commands = new Map<
		string,
		{ handler: (args: string, ctx: ExtensionContext) => Promise<void> }
	>();
	readonly entries: Array<{ customType: string; data: unknown }> = [];
	activeTools = ["read"];

	on(event: string, handler: unknown): void {
		this.handlers.set(event, handler);
	}

	registerTool(tool: { name: string }): void {
		this.activeTools.push(tool.name);
	}

	registerCommand(
		name: string,
		command: {
			handler: (args: string, ctx: ExtensionContext) => Promise<void>;
		},
	): void {
		this.commands.set(name, command);
	}

	appendEntry(customType: string, data: unknown): void {
		this.entries.push({ customType, data });
	}

	getActiveTools(): string[] {
		return this.activeTools;
	}

	setActiveTools(names: string[]): void {
		this.activeTools = names;
	}
}

function startupContext(statuses: string[] = []): ExtensionContext {
	return {
		cwd: process.cwd(),
		hasUI: true,
		isProjectTrusted: () => false,
		sessionManager: {
			getSessionId: () => "pi-session",
			getEntries: () => [],
			getBranch: () => [],
		},
		ui: {
			setStatus: (_key: string, value: string) => statuses.push(value),
		},
	} as unknown as ExtensionContext;
}

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

/** Startup must enumerate session paths, never parse every history. */
function forbidListAll(): () => void {
	const sessionManager = SessionManager as unknown as {
		listAll: () => Promise<Array<{ path: string }>>;
	};
	const listAll = sessionManager.listAll;
	sessionManager.listAll = async () => {
		throw new Error("SessionManager.listAll must not run at startup");
	};
	return () => {
		sessionManager.listAll = listAll;
	};
}

/** Pi's global sessions root inside this file's hermetic agent directory. */
function globalSessionsRoot(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR;
	assert.ok(agentDir?.startsWith(tmpdir()) && agentDir);
	return join(agentDir, "sessions");
}

async function writeSessionFile(
	dir: string,
	name: string,
	entries: unknown[],
): Promise<string> {
	await mkdir(dir, { recursive: true });
	const path = join(dir, name);
	const header = {
		type: "session",
		version: 3,
		id: name,
		timestamp: "2026-08-10T00:00:00.000Z",
		cwd: "/synthetic/other-repository",
	};
	await writeFile(
		path,
		`${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
	);
	return path;
}

function resetSessionEntry(
	kind: "intent" | "complete" | "uncertain" | "failed",
	timestamp = "2026-08-11T00:00:00.000Z",
): unknown {
	return {
		type: "custom",
		id: `reset-${kind}`,
		parentId: null,
		timestamp,
		customType: "pi-honcho-memory.reset",
		data: { kind, workspaceId: "pi" },
	};
}

/** Records every entry-parsed session path while keeping Pi's real parser. */
function spyOnSessionOpen(): { paths: string[]; restore: () => void } {
	const sessionManager = SessionManager as unknown as {
		open: (path: string) => unknown;
	};
	const open = sessionManager.open;
	const paths: string[] = [];
	sessionManager.open = (path: string) => {
		paths.push(path);
		return open.call(SessionManager, path);
	};
	return {
		paths,
		restore: () => {
			sessionManager.open = open;
		},
	};
}

type LifecycleClient = ReturnType<
	NonNullable<Parameters<typeof honchoMemory>[1]>
>;

function lifecycleClient(
	overrides: Record<string, unknown> = {},
): LifecycleClient {
	return {
		checkConnection: async () => undefined,
		fetchCachedMemory: async () => ({}),
		deliverExchange: async () => ["remote-1"],
		reconcileOperationIds: async () => new Map<string, string[]>(),
		cloneSession: async () => "cloned-session",
		search: async () => [],
		chat: async () => undefined,
		remember: async () => "conclusion-1",
		listWorkspaces: async () => ["pi"],
		deleteSession: async () => undefined,
		deleteConclusion: async () => undefined,
		inspectWorkspace: async () => ({
			workspaceId: "pi",
			peerIds: [],
			sessionCount: 0,
			conclusionCount: 0,
		}),
		deleteWorkspace: async () => undefined,
		...overrides,
	} as unknown as LifecycleClient;
}

test("does not register remote Honcho behavior in a Herdr subagent", () => {
	const previous = process.env.PI_SUBAGENT_ID;
	process.env.PI_SUBAGENT_ID = "child-1";
	try {
		const pi = new FakePiRuntime();
		let factoryCalls = 0;
		honchoMemory(pi as unknown as ExtensionAPI, () => {
			factoryCalls += 1;
			throw new Error("unexpected client creation");
		});

		assert.equal(factoryCalls, 0);
		assert.equal(pi.handlers.size, 0);
		assert.deepEqual(pi.activeTools, ["read"]);
		assert.deepEqual(pi.entries, []);
	} finally {
		restoreEnvironment("PI_SUBAGENT_ID", previous);
	}
});

test("uses a legacy Pi session mapping for startup recall", async () => {
	const previous = Object.fromEntries(
		["HONCHO_API_KEY", "HONCHO_ENABLED", "PI_SUBAGENT_ID"].map((name) => [
			name,
			process.env[name],
		]),
	);
	process.env.HONCHO_API_KEY = "test-key";
	delete process.env.HONCHO_ENABLED;
	delete process.env.PI_SUBAGENT_ID;
	const branch: unknown[] = [
		{
			type: "custom",
			customType: "pi-honcho-memory.session",
			data: { remoteSessionId: "legacy-remote-session" },
		},
	];
	let recalledSessionId: string | undefined;
	const deletedSessionIds: string[] = [];
	const confirmations: Array<{ title: string; details: string }> = [];
	const client = {
		checkConnection: async () => undefined,
		fetchCachedMemory: async (sessionId: string) => {
			recalledSessionId = sessionId;
			return { summary: "recalled session" };
		},
		deliverExchange: async () => [],
		reconcileOperationIds: async () => new Map<string, string[]>(),
		cloneSession: async () => "cloned-session",
		search: async () => [],
		chat: async () => undefined,
		remember: async () => "conclusion-1",
		listWorkspaces: async () => ["pi"],
		deleteSession: async (sessionId: string) => {
			deletedSessionIds.push(sessionId);
		},
		deleteConclusion: async () => undefined,
		inspectWorkspace: async () => ({
			workspaceId: "pi",
			peerIds: [],
			sessionCount: 0,
			conclusionCount: 0,
		}),
		deleteWorkspace: async () => undefined,
	};
	const restoreListAll = forbidListAll();
	const context = {
		...startupContext(),
		sessionManager: {
			getSessionId: () => "pi-session",
			getEntries: () => branch,
			getBranch: () => branch,
		},
		getContextUsage: () => undefined,
		ui: {
			setStatus: () => undefined,
			confirm: async (title: string, details: string) => {
				confirmations.push({ title, details });
				return true;
			},
			notify: () => undefined,
		},
	} as unknown as ExtensionContext;
	const pi = new FakePiRuntime();
	honchoMemory(pi as unknown as ExtensionAPI, () => client);
	const sessionStart = pi.handlers.get("session_start") as (
		event: { reason: "startup" },
		ctx: ExtensionContext,
	) => Promise<void>;
	const sessionShutdown = pi.handlers.get("session_shutdown") as (
		event: unknown,
		ctx: ExtensionContext,
	) => Promise<void>;
	try {
		await sessionStart({ reason: "startup" }, context);
		await waitFor(() => recalledSessionId !== undefined);
		assert.equal(recalledSessionId, "legacy-remote-session");
		assert.ok(!recalledSessionId.startsWith("repo-v2-"));
		const contextHandler = pi.handlers.get("context") as (
			event: { messages: unknown[] },
			ctx: ExtensionContext,
		) => { messages: unknown[] } | undefined;
		assert.equal(contextHandler({ messages: [] }, context)?.messages.length, 1);
		const sessionDelete = pi.commands.get("honcho-session-delete")?.handler;
		assert.ok(sessionDelete);
		await sessionDelete("", context);
		assert.deepEqual(deletedSessionIds, ["legacy-remote-session"]);
		assert.match(confirmations[0]?.title ?? "", /active repository session/i);
		assert.match(
			confirmations[0]?.details ?? "",
			/Repository session: legacy-remote-session/,
		);
		assert.equal(contextHandler({ messages: [] }, context), undefined);
	} finally {
		await sessionShutdown({}, context);
		restoreListAll();
		restoreEnvironment("HONCHO_API_KEY", previous.HONCHO_API_KEY);
		restoreEnvironment("HONCHO_ENABLED", previous.HONCHO_ENABLED);
		restoreEnvironment("PI_SUBAGENT_ID", previous.PI_SUBAGENT_ID);
	}
});

test("setup trims stable identities before saving them", async () => {
	const registry = await loadHonchoRegistry();
	assert.ok(registry);
	const pi = new FakePiRuntime();
	honchoMemory(pi as unknown as ExtensionAPI);
	const setup = pi.commands.get("honcho-setup")?.handler;
	assert.ok(setup);
	try {
		await setup("", {
			...startupContext(),
			ui: {
				input: async (label: string) =>
					label === "Stable user peer" ? " user " : " pi ",
				confirm: async () => true,
				notify: () => undefined,
				setStatus: () => undefined,
			},
		} as unknown as ExtensionContext);
		assert.deepEqual((await loadHonchoRegistry())?.identity, {
			userPeer: "user",
			aiPeer: "pi",
		});
	} finally {
		await saveHonchoRegistry(registry);
	}
});

test("legacy workspace configuration cannot activate an uninitialized repository", async () => {
	const previous = Object.fromEntries(
		["HONCHO_API_KEY", "HONCHO_WORKSPACE_ID"].map((name) => [
			name,
			process.env[name],
		]),
	);
	process.env.HONCHO_API_KEY = "test-key";
	process.env.HONCHO_WORKSPACE_ID = "legacy-workspace";
	const cwd = await mkdtemp(join(tmpdir(), "pi-honcho-uninitialized-"));
	try {
		const pi = new FakePiRuntime();
		let factoryCalls = 0;
		honchoMemory(pi as unknown as ExtensionAPI, () => {
			factoryCalls += 1;
			throw new Error("unexpected client creation");
		});
		const handler = pi.handlers.get("session_start") as (
			event: { reason: "startup" },
			ctx: ExtensionContext,
		) => Promise<void>;
		const statuses: string[] = [];
		const notifications: string[] = [];
		const context = {
			...startupContext(statuses),
			cwd,
			ui: {
				setStatus: (_key: string, value: string) => statuses.push(value),
				notify: (message: string) => notifications.push(message),
			},
		} as unknown as ExtensionContext;
		await handler({ reason: "startup" }, context);
		assert.equal(factoryCalls, 0);
		assert.match(statuses.at(-1) ?? "", /not initialized/i);
		const status = pi.commands.get("honcho-status")?.handler;
		assert.ok(status);
		await status("", context);
		assert.match(notifications[0] ?? "", /Repository memory: uninitialized/);
		assert.match(notifications[0] ?? "", /Run \/honcho init/);
		assert.doesNotMatch(notifications[0] ?? "", /Workspace source/);
	} finally {
		restoreEnvironment("HONCHO_API_KEY", previous.HONCHO_API_KEY);
		restoreEnvironment("HONCHO_WORKSPACE_ID", previous.HONCHO_WORKSPACE_ID);
	}
});

test("fails open and keeps Honcho tools inactive when startup is disabled", async () => {
	const previous = process.env.HONCHO_ENABLED;
	process.env.HONCHO_ENABLED = "0";
	try {
		const pi = new FakePiRuntime();
		honchoMemory(pi as unknown as ExtensionAPI);
		const handler = pi.handlers.get("session_start") as (
			event: { reason: "startup" },
			ctx: ExtensionContext,
		) => Promise<void>;

		await handler({ reason: "startup" }, startupContext());

		assert.deepEqual(pi.activeTools, ["read"]);
		assert.deepEqual(pi.entries, []);
	} finally {
		restoreEnvironment("HONCHO_ENABLED", previous);
	}
});

test("setup requires non-empty stable identities", async () => {
	const pi = new FakePiRuntime();
	const notifications: Array<{ message: string; level: string }> = [];
	let inputs = 0;
	honchoMemory(pi as unknown as ExtensionAPI);
	const setup = pi.commands.get("honcho-setup")?.handler;
	assert.ok(setup);

	await setup("", {
		...startupContext(),
		ui: {
			input: async () => {
				inputs += 1;
				return undefined;
			},
			notify: (message: string, level: string) =>
				notifications.push({ message, level }),
			setStatus: () => undefined,
		},
	} as unknown as ExtensionContext);

	assert.equal(inputs, 2);
	assert.deepEqual(notifications, []);
});

test("does not create a client for an invalid effective workspace", async () => {
	const previous = Object.fromEntries(
		["HONCHO_API_KEY", "HONCHO_WORKSPACE_ID", "HONCHO_ENABLED"].map((name) => [
			name,
			process.env[name],
		]),
	);
	process.env.HONCHO_API_KEY = "test-key";
	process.env.HONCHO_WORKSPACE_ID = "invalid.workspace";
	delete process.env.HONCHO_ENABLED;
	try {
		const pi = new FakePiRuntime();
		const statuses: string[] = [];
		let factoryCalls = 0;
		honchoMemory(pi as unknown as ExtensionAPI, () => {
			factoryCalls += 1;
			throw new Error("unexpected client creation");
		});
		const handler = pi.handlers.get("session_start") as (
			event: { reason: "startup" },
			ctx: ExtensionContext,
		) => Promise<void>;

		await handler({ reason: "startup" }, startupContext(statuses));

		assert.equal(factoryCalls, 0);
		assert.deepEqual(pi.activeTools, ["read"]);
		assert.match(
			statuses.at(-1) ?? "",
			/unconfigured — Invalid workspace ID from environment/,
		);
		assert.match(statuses.at(-1) ?? "", /HONCHO_WORKSPACE_ID/);
	} finally {
		restoreEnvironment("HONCHO_API_KEY", previous.HONCHO_API_KEY);
		restoreEnvironment("HONCHO_WORKSPACE_ID", previous.HONCHO_WORKSPACE_ID);
		restoreEnvironment("HONCHO_ENABLED", previous.HONCHO_ENABLED);
	}
});

test("uses remote reconciliation only for pending recovery delivery", async () => {
	const previous = process.env.HONCHO_API_KEY;
	process.env.HONCHO_API_KEY = "test-key";
	const branch: unknown[] = [
		{
			type: "custom",
			customType: "pi-honcho-memory.delivery",
			timestamp: "2026-08-11T00:00:00.000Z",
			data: {
				kind: "pending",
				exchange: {
					operationId: "pi-recovery",
					userText: "Recovered prompt",
					assistantText: "Recovered response",
				},
			},
		},
	];
	const restoreListAll = forbidListAll();
	const reconciled: string[] = [];
	const delivered: string[] = [];
	let cachedMemoryRequests = 0;
	const client = {
		checkConnection: async () => undefined,
		fetchCachedMemory: async () => {
			cachedMemoryRequests += 1;
			return {};
		},
		deliverExchange: async (
			_sessionId: string,
			exchange: { operationId: string },
		) => {
			delivered.push(exchange.operationId);
			return [`remote-${exchange.operationId}`];
		},
		reconcileOperationIds: async (
			_sessionId: string,
			operationIds: readonly string[],
		) => {
			reconciled.push(...operationIds);
			return new Map(
				operationIds.map((operationId) => [operationId, ["remote-existing"]]),
			);
		},
		cloneSession: async () => "cloned-session",
		search: async () => [],
		chat: async () => undefined,
		remember: async () => "conclusion-1",
		listWorkspaces: async () => ["pi"],
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
	const context = {
		...startupContext(),
		sessionManager: {
			getSessionId: () => "pi-session",
			getEntries: () => branch,
			getBranch: () => branch,
		},
	} as unknown as ExtensionContext;
	const pi = new FakePiRuntime();
	honchoMemory(pi as unknown as ExtensionAPI, () => client);
	const sessionStart = pi.handlers.get("session_start") as (
		event: { reason: "startup" },
		ctx: ExtensionContext,
	) => Promise<void>;
	const beforeAgentStart = pi.handlers.get("before_agent_start") as (
		event: { prompt: string },
		ctx: ExtensionContext,
	) => void;
	const agentSettled = pi.handlers.get("agent_settled") as (
		event: unknown,
		ctx: ExtensionContext,
	) => void;
	const sessionShutdown = pi.handlers.get("session_shutdown") as (
		event: unknown,
		ctx: ExtensionContext,
	) => Promise<void>;
	try {
		await sessionStart({ reason: "startup" }, context);
		await waitFor(
			() =>
				cachedMemoryRequests === 1 &&
				pi.entries.some(
					(entry) =>
						entry.customType === "pi-honcho-memory.delivery" &&
						(entry.data as { kind?: string }).kind === "acknowledged",
				),
		);

		assert.deepEqual(reconciled, ["pi-recovery"]);
		assert.deepEqual(delivered, []);
		assert.deepEqual(pi.entries.at(-1), {
			customType: "pi-honcho-memory.delivery",
			data: {
				kind: "acknowledged",
				operationId: "pi-recovery",
				messageIds: ["remote-existing"],
			},
		});

		beforeAgentStart({ prompt: "New prompt" }, context);
		branch.push({
			id: "assistant-1",
			type: "message",
			message: {
				role: "assistant",
				stopReason: "stop",
				content: [{ type: "text", text: "New response" }],
			},
		});
		agentSettled({}, context);
		await waitFor(() => delivered.length === 1);

		assert.deepEqual(reconciled, ["pi-recovery"]);
		assert.deepEqual(delivered, ["pi-assistant-1"]);
		assert.deepEqual(pi.entries.slice(-2), [
			{
				customType: "pi-honcho-memory.delivery",
				data: {
					kind: "pending",
					exchange: {
						operationId: "pi-assistant-1",
						userText: "New prompt",
						assistantText: "New response",
					},
				},
			},
			{
				customType: "pi-honcho-memory.delivery",
				data: {
					kind: "acknowledged",
					operationId: "pi-assistant-1",
					messageIds: ["remote-pi-assistant-1"],
				},
			},
		]);

		beforeAgentStart({ prompt: "Prompt without a new response" }, context);
		agentSettled({}, context);
		const switchedBranch: unknown[] = [
			{ id: "stale-custom", type: "custom", customType: "noise", data: {} },
			{
				id: "stale-assistant",
				type: "message",
				message: {
					role: "assistant",
					stopReason: "stop",
					content: [{ type: "text", text: "Stale response" }],
				},
			},
		];
		const switchedContext = {
			...context,
			sessionManager: {
				getSessionId: () => "pi-session-2",
				getEntries: () => switchedBranch,
				getBranch: () => switchedBranch,
			},
		} as unknown as ExtensionContext;
		beforeAgentStart(
			{ prompt: "Prompt in a switched session" },
			switchedContext,
		);
		agentSettled({}, switchedContext);
		await new Promise<void>((resolve) => setTimeout(resolve, 25));

		assert.deepEqual(delivered, ["pi-assistant-1"]);
		assert.equal(
			pi.entries.filter(
				(entry) =>
					entry.customType === "pi-honcho-memory.delivery" &&
					(entry.data as { kind?: string }).kind === "pending",
			).length,
			1,
		);
	} finally {
		await sessionShutdown({}, context);
		restoreListAll();
		restoreEnvironment("HONCHO_API_KEY", previous);
	}
});

test("reconciles older post-reset delivery before normally delivering the exchange that recreates the workspace", async () => {
	const previous = process.env.HONCHO_API_KEY;
	const previousWorkspaceId = process.env.HONCHO_WORKSPACE_ID;
	process.env.HONCHO_API_KEY = "test-key";
	process.env.HONCHO_WORKSPACE_ID = "pi";
	const branch: unknown[] = [
		{
			type: "custom",
			customType: "pi-honcho-memory.delivery",
			timestamp: "2026-08-11T00:00:30.000Z",
			data: {
				kind: "pending",
				exchange: {
					operationId: "pi-existing-post-reset",
					userText: "Earlier post-reset prompt",
					assistantText: "Earlier post-reset response",
				},
			},
		},
	];
	const reconciled: string[] = [];
	const delivered: string[] = [];
	let memoryRequests = 0;
	const statuses: string[] = [];
	const client = {
		checkConnection: async () => undefined,
		fetchCachedMemory: async () => {
			memoryRequests += 1;
			return {};
		},
		deliverExchange: async (
			_sessionId: string,
			exchange: { operationId: string },
		) => {
			delivered.push(exchange.operationId);
			return [`remote-${exchange.operationId}`];
		},
		reconcileOperationIds: async (
			_sessionId: string,
			operationIds: readonly string[],
		) => {
			reconciled.push(...operationIds);
			return new Map(
				operationIds
					.filter((operationId) => operationId === "pi-existing-post-reset")
					.map((operationId) => [operationId, ["remote-existing"]]),
			);
		},
		cloneSession: async () => "cloned-session",
		search: async () => [],
		chat: async () => undefined,
		remember: async () => "conclusion-1",
		listWorkspaces: async () => ["pi"],
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
	const context = {
		...startupContext(statuses),
		sessionManager: {
			getSessionId: () => "pi-session",
			getEntries: () => branch,
			getBranch: () => branch,
		},
	} as unknown as ExtensionContext;
	// The reset was recorded from another repository's Pi session directory.
	const sessionsRoot = globalSessionsRoot();
	await writeSessionFile(
		join(sessionsRoot, "--synthetic-other-repository--"),
		"completed-reset.jsonl",
		[
			resetSessionEntry("intent"),
			resetSessionEntry("complete", "2026-08-11T00:00:01.000Z"),
		],
	);
	const restoreListAll = forbidListAll();
	const pi = new FakePiRuntime();
	const appendEntry = pi.appendEntry.bind(pi);
	pi.appendEntry = (customType, data) => {
		appendEntry(customType, data);
		if (customType === "pi-honcho-memory.delivery") {
			branch.push({
				type: "custom",
				customType,
				timestamp: "2026-08-11T00:01:00.000Z",
				data,
			});
		}
	};
	honchoMemory(pi as unknown as ExtensionAPI, () => client);
	const sessionStart = pi.handlers.get("session_start") as (
		event: { reason: "startup" },
		ctx: ExtensionContext,
	) => Promise<void>;
	const beforeAgentStart = pi.handlers.get("before_agent_start") as (
		event: { prompt: string },
		ctx: ExtensionContext,
	) => void;
	const agentSettled = pi.handlers.get("agent_settled") as (
		event: unknown,
		ctx: ExtensionContext,
	) => void;
	const sessionShutdown = pi.handlers.get("session_shutdown") as (
		event: unknown,
		ctx: ExtensionContext,
	) => Promise<void>;
	try {
		await sessionStart({ reason: "startup" }, context);
		await waitFor(
			() => statuses.at(-1)?.startsWith("Honcho: connected") === true,
		);
		// A completed reset gates recall and tools until the first exchange
		// recreates the remote workspace.
		await new Promise<void>((resolve) => setTimeout(resolve, 25));
		assert.equal(memoryRequests, 0);
		assert.deepEqual(
			pi.activeTools.filter((name) => name.startsWith("honcho_")),
			[],
		);
		beforeAgentStart({ prompt: "First post-reset prompt" }, context);
		branch.push({
			id: "post-reset-assistant",
			type: "message",
			message: {
				role: "assistant",
				stopReason: "stop",
				content: [{ type: "text", text: "First post-reset response" }],
			},
		});
		agentSettled({}, context);
		await waitFor(() => delivered.includes("pi-post-reset-assistant"));

		assert.deepEqual(reconciled, ["pi-existing-post-reset"]);
		assert.deepEqual(delivered, ["pi-post-reset-assistant"]);
	} finally {
		await sessionShutdown({}, context);
		restoreListAll();
		await rm(sessionsRoot, { recursive: true, force: true });
		restoreEnvironment("HONCHO_API_KEY", previous);
		restoreEnvironment("HONCHO_WORKSPACE_ID", previousWorkspaceId);
	}
});

test("does not let a stale connection status replace a newer disabled startup", async () => {
	let releaseConnection: (() => void) | undefined;
	let requestReceived: (() => void) | undefined;
	const request = new Promise<void>((resolve) => {
		requestReceived = resolve;
	});
	const server = createServer((_request, response) => {
		requestReceived?.();
		releaseConnection = () => {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify({ items: [], total: 0, page: 1, size: 1, pages: 1 }),
			);
		};
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const previous = Object.fromEntries(
		["HONCHO_API_KEY", "HONCHO_BASE_URL", "HONCHO_ENABLED"].map((name) => [
			name,
			process.env[name],
		]),
	);
	process.env.HONCHO_API_KEY = "test-key";
	process.env.HONCHO_BASE_URL = `http://127.0.0.1:${address.port}`;
	delete process.env.HONCHO_ENABLED;
	try {
		const pi = new FakePiRuntime();
		const statuses: string[] = [];
		honchoMemory(pi as unknown as ExtensionAPI);
		const handler = pi.handlers.get("session_start") as (
			event: { reason: "startup" },
			ctx: ExtensionContext,
		) => Promise<void>;

		await handler({ reason: "startup" }, startupContext(statuses));
		await request;
		process.env.HONCHO_ENABLED = "0";
		await handler({ reason: "startup" }, startupContext(statuses));
		assert.equal(
			statuses.at(-1),
			"Honcho: disabled — HONCHO_ENABLED is disabled",
		);

		assert.ok(releaseConnection);
		releaseConnection();
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(
			statuses.at(-1),
			"Honcho: disabled — HONCHO_ENABLED is disabled",
		);
	} finally {
		restoreEnvironment("HONCHO_API_KEY", previous.HONCHO_API_KEY);
		restoreEnvironment("HONCHO_BASE_URL", previous.HONCHO_BASE_URL);
		restoreEnvironment("HONCHO_ENABLED", previous.HONCHO_ENABLED);
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

interface ResetStartupHarness {
	pi: FakePiRuntime;
	statuses: string[];
	branch: unknown[];
	delivered: string[];
	memoryRequests: () => number;
	context: ExtensionContext;
	start: () => Promise<void>;
	settleExchange: (prompt: string, assistantId: string) => void;
	shutdown: () => Promise<void>;
}

function resetStartupHarness(): ResetStartupHarness {
	const statuses: string[] = [];
	const branch: unknown[] = [];
	const delivered: string[] = [];
	let memoryRequests = 0;
	const client = lifecycleClient({
		fetchCachedMemory: async () => {
			memoryRequests += 1;
			return {};
		},
		deliverExchange: async (
			_sessionId: string,
			exchange: { operationId: string },
		) => {
			delivered.push(exchange.operationId);
			return [`remote-${exchange.operationId}`];
		},
	});
	const context = {
		...startupContext(statuses),
		sessionManager: {
			getSessionId: () => "pi-session",
			getEntries: () => branch,
			getBranch: () => branch,
		},
	} as unknown as ExtensionContext;
	const pi = new FakePiRuntime();
	const appendEntry = pi.appendEntry.bind(pi);
	pi.appendEntry = (customType, data) => {
		appendEntry(customType, data);
		branch.push({
			type: "custom",
			customType,
			timestamp: "2026-08-11T00:01:00.000Z",
			data,
		});
	};
	honchoMemory(pi as unknown as ExtensionAPI, () => client);
	const handler = <T>(name: string) => pi.handlers.get(name) as T;
	return {
		pi,
		statuses,
		branch,
		delivered,
		memoryRequests: () => memoryRequests,
		context,
		start: () =>
			handler<
				(event: { reason: "startup" }, ctx: ExtensionContext) => Promise<void>
			>("session_start")({ reason: "startup" }, context),
		settleExchange: (prompt, assistantId) => {
			handler<(event: { prompt: string }, ctx: ExtensionContext) => void>(
				"before_agent_start",
			)({ prompt }, context);
			branch.push({
				id: assistantId,
				type: "message",
				message: {
					role: "assistant",
					stopReason: "stop",
					content: [{ type: "text", text: `${prompt} response` }],
				},
			});
			handler<(event: unknown, ctx: ExtensionContext) => void>("agent_settled")(
				{},
				context,
			);
		},
		shutdown: () =>
			handler<(event: unknown, ctx: ExtensionContext) => Promise<void>>(
				"session_shutdown",
			)({}, context),
	};
}

async function withResetStartupEnvironment(
	run: (sessionsRoot: string) => Promise<void>,
): Promise<void> {
	const previous = process.env.HONCHO_API_KEY;
	const previousWorkspaceId = process.env.HONCHO_WORKSPACE_ID;
	process.env.HONCHO_API_KEY = "test-key";
	process.env.HONCHO_WORKSPACE_ID = "pi";
	const sessionsRoot = globalSessionsRoot();
	const restoreListAll = forbidListAll();
	try {
		await run(sessionsRoot);
	} finally {
		restoreListAll();
		await rm(sessionsRoot, { recursive: true, force: true });
		restoreEnvironment("HONCHO_API_KEY", previous);
		restoreEnvironment("HONCHO_WORKSPACE_ID", previousWorkspaceId);
	}
}

function activeHonchoTools(pi: FakePiRuntime): string[] {
	return pi.activeTools.filter((name) => name.startsWith("honcho_"));
}

test("entry-parses only marked Pi sessions found across every global cwd directory", async () => {
	await withResetStartupEnvironment(async (sessionsRoot) => {
		const otherRepository = join(
			sessionsRoot,
			"--synthetic-other-repository--",
		);
		const resetSessionPath = await writeSessionFile(
			otherRepository,
			"with-reset.jsonl",
			[resetSessionEntry("failed")],
		);
		await writeSessionFile(
			join(sessionsRoot, "--synthetic-third-repository--"),
			"without-reset.jsonl",
			[
				{
					type: "message",
					id: "plain-user",
					parentId: null,
					timestamp: "2026-08-11T00:00:00.000Z",
					message: { role: "user", content: "plain" },
				},
			],
		);
		// Pi lists neither non-JSONL files, files directly under the root,
		// unreadable `.jsonl` paths, nor files without a session header.
		await writeSessionFile(otherRepository, "with-reset.jsonl.bak", [
			resetSessionEntry("intent"),
		]);
		await writeSessionFile(sessionsRoot, "root-level.jsonl", [
			resetSessionEntry("intent"),
		]);
		await mkdir(join(otherRepository, "directory.jsonl"));
		await writeFile(
			join(otherRepository, "headerless.jsonl"),
			`${JSON.stringify(resetSessionEntry("intent"))}\n`,
		);
		const opened = spyOnSessionOpen();
		const harness = resetStartupHarness();
		try {
			await harness.start();
			await waitFor(() => harness.memoryRequests() === 1);

			assert.deepEqual(opened.paths, [resetSessionPath]);
			assert.deepEqual(activeHonchoTools(harness.pi), [
				"honcho_search",
				"honcho_chat",
				"honcho_remember",
			]);
		} finally {
			await harness.shutdown();
			opened.restore();
		}
	});
});

for (const kind of ["intent", "uncertain"] as const) {
	test(`a ${kind} reset from another cwd blocks delivery and tools`, async () => {
		await withResetStartupEnvironment(async (sessionsRoot) => {
			await writeSessionFile(
				join(sessionsRoot, "--synthetic-other-repository--"),
				`${kind}.jsonl`,
				[resetSessionEntry(kind)],
			);
			const harness = resetStartupHarness();
			try {
				await harness.start();
				await waitFor(
					() =>
						harness.statuses.at(-1)?.startsWith("Honcho: connected") === true,
				);
				assert.deepEqual(activeHonchoTools(harness.pi), []);

				harness.settleExchange("Blocked prompt", "blocked-assistant");
				await new Promise<void>((resolve) => setTimeout(resolve, 25));

				assert.equal(harness.memoryRequests(), 0);
				assert.deepEqual(harness.delivered, []);
				assert.deepEqual(harness.pi.entries, []);
			} finally {
				await harness.shutdown();
			}
		});
	});
}

test("starts normally when the global sessions directory is missing", async () => {
	await withResetStartupEnvironment(async (sessionsRoot) => {
		await rm(sessionsRoot, { recursive: true, force: true });
		const harness = resetStartupHarness();
		try {
			await harness.start();
			await waitFor(() => harness.memoryRequests() === 1);
		} finally {
			await harness.shutdown();
		}
	});
});

test("follows symlinked cwd session directories and skips dangling ones", async (t) => {
	await withResetStartupEnvironment(async (sessionsRoot) => {
		const linkedTarget = await mkdtemp(join(tmpdir(), "pi-honcho-linked-cwd-"));
		await writeSessionFile(linkedTarget, "linked-intent.jsonl", [
			resetSessionEntry("intent"),
		]);
		await mkdir(sessionsRoot, { recursive: true });
		try {
			await symlink(
				join(linkedTarget, "missing"),
				join(sessionsRoot, "--dangling-repository--"),
				"dir",
			);
			await symlink(
				linkedTarget,
				join(sessionsRoot, "--linked-repository--"),
				"dir",
			);
		} catch (error) {
			await rm(linkedTarget, { recursive: true, force: true });
			t.skip(`directory symlinks unavailable: ${(error as Error).message}`);
			return;
		}
		const harness = resetStartupHarness();
		try {
			await harness.start();
			await waitFor(
				() => harness.statuses.at(-1)?.startsWith("Honcho: connected") === true,
			);
			harness.settleExchange("Blocked prompt", "blocked-assistant");
			await new Promise<void>((resolve) => setTimeout(resolve, 25));

			assert.deepEqual(activeHonchoTools(harness.pi), []);
			assert.equal(harness.memoryRequests(), 0);
			assert.deepEqual(harness.delivered, []);
		} finally {
			await harness.shutdown();
			await rm(linkedTarget, { recursive: true, force: true });
		}
	});
});

for (const prefix of ["null", "false", "0", '""', 'null\nfalse\n0\n""']) {
	test(`finds a reset after falsy JSON lines before the header: ${JSON.stringify(prefix)}`, async () => {
		await withResetStartupEnvironment(async (sessionsRoot) => {
			const dir = join(sessionsRoot, "--synthetic-other-repository--");
			await mkdir(dir, { recursive: true });
			// Pi's session parser skips falsy entries while looking for the header.
			const header = {
				type: "session",
				version: 3,
				id: "falsy-prefix",
				timestamp: "2026-08-10T00:00:00.000Z",
				cwd: "/synthetic/other-repository",
			};
			await writeFile(
				join(dir, "falsy-prefix.jsonl"),
				`${prefix}\n${[header, resetSessionEntry("intent")].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
			);
			const harness = resetStartupHarness();
			try {
				await harness.start();
				await waitFor(
					() =>
						harness.statuses.at(-1)?.startsWith("Honcho: connected") === true,
				);
				harness.settleExchange("Blocked prompt", "blocked-assistant");
				await new Promise<void>((resolve) => setTimeout(resolve, 25));

				assert.deepEqual(activeHonchoTools(harness.pi), []);
				assert.equal(harness.memoryRequests(), 0);
				assert.deepEqual(harness.delivered, []);
			} finally {
				await harness.shutdown();
			}
		});
	});
}

/**
 * Writes two tied resets into different cwd directories. Each case runs with
 * both placements so the outcome cannot depend on directory listing order.
 */
async function writeTiedResets(
	sessionsRoot: string,
	first: "intent" | "complete" | "failed",
	second: "intent" | "complete" | "failed",
): Promise<void> {
	const tie = "2026-08-11T00:00:00.000Z";
	await writeSessionFile(join(sessionsRoot, "--a--"), `${first}.jsonl`, [
		resetSessionEntry(first, tie),
	]);
	await writeSessionFile(join(sessionsRoot, "--z--"), `${second}.jsonl`, [
		resetSessionEntry(second, tie),
		{
			type: "message",
			id: "newer-activity",
			parentId: `reset-${second}`,
			timestamp: "2026-08-11T00:05:00.000Z",
			message: { role: "user", content: "newer activity" },
		},
	]);
}

for (const [first, second] of [
	["failed", "intent"],
	["intent", "failed"],
] as const) {
	test(`tied intent and failed resets across cwds block (${first} listed in --a--)`, async () => {
		await withResetStartupEnvironment(async (sessionsRoot) => {
			await writeTiedResets(sessionsRoot, first, second);
			const harness = resetStartupHarness();
			try {
				await harness.start();
				await waitFor(
					() =>
						harness.statuses.at(-1)?.startsWith("Honcho: connected") === true,
				);
				harness.settleExchange("Blocked prompt", "blocked-assistant");
				await new Promise<void>((resolve) => setTimeout(resolve, 25));

				assert.deepEqual(activeHonchoTools(harness.pi), []);
				assert.equal(harness.memoryRequests(), 0);
				assert.deepEqual(harness.delivered, []);
			} finally {
				await harness.shutdown();
			}
		});
	});
}

for (const [first, second] of [
	["failed", "complete"],
	["complete", "failed"],
] as const) {
	test(`tied complete and failed resets across cwds await recreation (${first} listed in --a--)`, async () => {
		await withResetStartupEnvironment(async (sessionsRoot) => {
			await writeTiedResets(sessionsRoot, first, second);
			const harness = resetStartupHarness();
			try {
				await harness.start();
				await waitFor(
					() =>
						harness.statuses.at(-1)?.startsWith("Honcho: connected") === true,
				);
				// Give an ungated startup time to recall memory and enable tools.
				await new Promise<void>((resolve) => setTimeout(resolve, 25));
				assert.equal(harness.memoryRequests(), 0);
				assert.deepEqual(activeHonchoTools(harness.pi), []);

				harness.settleExchange("Recreating prompt", "recreating-assistant");
				await waitFor(() =>
					harness.delivered.includes("pi-recreating-assistant"),
				);
				await waitFor(() => harness.memoryRequests() === 1);
			} finally {
				await harness.shutdown();
			}
		});
	});
}
