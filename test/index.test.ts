import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
	type ExtensionAPI,
	type ExtensionContext,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

import honchoMemory from "../src/remote/index.js";

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
	const client = {
		checkConnection: async () => undefined,
		fetchCachedMemory: async (sessionId: string) => {
			recalledSessionId = sessionId;
			return {};
		},
		deliverExchange: async () => [],
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
	const sessionManager = SessionManager as unknown as {
		listAll: () => Promise<Array<{ path: string }>>;
	};
	const listAll = sessionManager.listAll;
	sessionManager.listAll = async () => [];
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
	const sessionShutdown = pi.handlers.get("session_shutdown") as (
		event: unknown,
		ctx: ExtensionContext,
	) => Promise<void>;
	try {
		await sessionStart({ reason: "startup" }, context);
		await waitFor(() => recalledSessionId !== undefined);
		assert.equal(recalledSessionId, "legacy-remote-session");
		assert.ok(!recalledSessionId.startsWith("repo-v2-"));
	} finally {
		await sessionShutdown({}, context);
		sessionManager.listAll = listAll;
		restoreEnvironment("HONCHO_API_KEY", previous.HONCHO_API_KEY);
		restoreEnvironment("HONCHO_ENABLED", previous.HONCHO_ENABLED);
		restoreEnvironment("PI_SUBAGENT_ID", previous.PI_SUBAGENT_ID);
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

test("rejects invalid global setup workspaces before saving settings", async () => {
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
				return "invalid.workspace";
			},
			notify: (message: string, level: string) =>
				notifications.push({ message, level }),
			setStatus: () => undefined,
		},
	} as unknown as ExtensionContext);

	assert.equal(inputs, 1);
	assert.equal(notifications[0].level, "warning");
	assert.match(
		notifications[0].message,
		/letters, digits, underscores, or hyphens/,
	);
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
	const sessionManager = SessionManager as unknown as {
		listAll: () => Promise<Array<{ path: string }>>;
	};
	const listAll = sessionManager.listAll;
	sessionManager.listAll = async () => [];
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
		reconcileOperationId: async (_sessionId: string, operationId: string) => {
			reconciled.push(operationId);
			return ["remote-existing"];
		},
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
	} finally {
		await sessionShutdown({}, context);
		sessionManager.listAll = listAll;
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
	const client = {
		checkConnection: async () => undefined,
		fetchCachedMemory: async () => ({}),
		deliverExchange: async (
			_sessionId: string,
			exchange: { operationId: string },
		) => {
			delivered.push(exchange.operationId);
			return [`remote-${exchange.operationId}`];
		},
		reconcileOperationId: async (_sessionId: string, operationId: string) => {
			reconciled.push(operationId);
			return operationId === "pi-existing-post-reset"
				? ["remote-existing"]
				: [];
		},
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
	const context = {
		...startupContext(),
		sessionManager: {
			getSessionId: () => "pi-session",
			getEntries: () => branch,
			getBranch: () => branch,
		},
	} as unknown as ExtensionContext;
	const sessionManager = SessionManager as unknown as {
		listAll: () => Promise<Array<{ path: string }>>;
		open: (path: string) => { getEntries: () => unknown[] };
	};
	const listAll = sessionManager.listAll;
	const open = sessionManager.open;
	sessionManager.listAll = async () => [{ path: "completed-reset" }];
	sessionManager.open = () => ({
		getEntries: () => [
			{
				type: "custom",
				customType: "pi-honcho-memory.reset",
				timestamp: "2026-08-11T00:00:00.000Z",
				data: { kind: "complete", workspaceId: "pi" },
			},
		],
	});
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
		sessionManager.listAll = listAll;
		sessionManager.open = open;
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
