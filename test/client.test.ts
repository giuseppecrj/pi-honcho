import assert from "node:assert/strict"; // pi-lens-ignore: find-import-file-without-extension
import test from "node:test";

import { type HonchoSdkClient, SdkHonchoMemoryClient } from "../src/remote/client.js";
import type { HonchoConnectionConfig } from "../src/remote/config.js";

const config: HonchoConnectionConfig = {
	apiKey: "test-key",
	baseUrl: "https://honcho.invalid",
	workspaceId: "pi-test",
	workspaceSource: "default",
	peerName: "user",
	aiPeer: "pi",
	timeoutMs: 123,
	maxMessageLength: 5,
};

type FakeMessage = {
	id: string;
	content: string;
	metadata: Record<string, unknown>;
};

class FakePage<T> implements AsyncIterable<T> {
	constructor(
		private readonly values: T[],
		readonly total = values.length,
	) {}

	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		yield* this.values;
	}

	async toArray(): Promise<T[]> {
		return [...this.values];
	}
}

class FakeConclusionScope {
	readonly created: Array<{ content: string; sessionId: string }> = [];
	readonly deleted: string[] = [];
	createResponses: unknown[] = [];
	count = 0;
	list: () => Promise<FakePage<never>> = async () =>
		new FakePage([], this.count);

	async create(input: {
		content: string;
		sessionId: string;
	}): Promise<Array<{ id: string }>> {
		this.created.push(input);
		return (this.createResponses.shift() ?? [{ id: "conclusion-1" }]) as Array<{
			id: string;
		}>;
	}

	async delete(id: string): Promise<void> {
		this.deleted.push(id);
	}
}

class FakePeer {
	readonly scopes = new Map<string, FakeConclusionScope>();
	chatResponses: unknown[] = [];

	constructor(readonly id: string) {}

	message(
		content: string,
		options?: { metadata?: Record<string, unknown> },
	): { peerId: string; content: string; metadata?: Record<string, unknown> } {
		return { peerId: this.id, content, metadata: options?.metadata };
	}

	readonly chatCalls: Array<{
		query: string;
		options?: { target?: unknown; session?: unknown };
	}> = [];

	async chat(
		query: string,
		options?: { target?: unknown; session?: unknown },
	): Promise<string | null> {
		this.chatCalls.push({ query, options });
		return (
			this.chatResponses.length ? this.chatResponses.shift() : "chat answer"
		) as string | null;
	}

	conclusionsOf(target: { id: string } | string): FakeConclusionScope {
		const targetId = typeof target === "string" ? target : target.id;
		let scope = this.scopes.get(targetId);
		if (!scope) {
			scope = new FakeConclusionScope();
			this.scopes.set(targetId, scope);
		}
		return scope;
	}
}

class FakeSession {
	readonly addedPeerSets: unknown[] = [];
	readonly addedMessageSets: Array<
		Array<{
			peerId: string;
			content: string;
			metadata?: Record<string, unknown>;
		}>
	> = [];
	readonly cloneMessageIds: string[] = [];
	readonly contextCalls: unknown[] = [];
	readonly searchCalls: Array<{ query: string; options?: { limit?: number } }> =
		[];
	addPeersFailures = 0;
	addMessageResponses: unknown[] = [];
	contextResponses: unknown[] = [];
	searchResponses: unknown[] = [];
	cloneResponses: unknown[] = [];
	messagesResponse: unknown = new FakePage<FakeMessage>([]);
	deleted = false;

	constructor(
		readonly id: string,
		private readonly onDelete?: (id: string) => Promise<void>,
	) {}

	async addPeers(peers: unknown): Promise<void> {
		this.addedPeerSets.push(peers);
		if (this.addPeersFailures > 0) {
			this.addPeersFailures -= 1;
			throw new Error("session setup failed");
		}
	}

	async addMessages(
		messages: Array<{
			peerId: string;
			content: string;
			metadata?: Record<string, unknown>;
		}>,
	): Promise<FakeMessage[]> {
		this.addedMessageSets.push(messages);
		const response = this.addMessageResponses.shift();
		if (response instanceof Error) throw response;
		if (response !== undefined) return response as FakeMessage[];
		return messages.map((message, index) => ({
			id: `${this.id}-message-${this.addedMessageSets.length}-${index}`,
			content: message.content,
			metadata: message.metadata ?? {},
		}));
	}

	async context(options: unknown): Promise<{
		summary?: { content?: unknown } | null;
		peerRepresentation?: unknown;
		peerCard?: unknown;
	}> {
		this.contextCalls.push(options);
		return (
			this.contextResponses.length
				? this.contextResponses.shift()
				: {
						summary: { content: "project summary" },
						peerRepresentation: "user representation",
					}
		) as {
			summary?: { content?: unknown } | null;
			peerRepresentation?: unknown;
			peerCard?: unknown;
		};
	}

	async clone(messageId: string): Promise<{ id: string }> {
		this.cloneMessageIds.push(messageId);
		return (this.cloneResponses.shift() ?? { id: `${this.id}-clone` }) as {
			id: string;
		};
	}

	async search(
		query: string,
		options?: { limit?: number },
	): Promise<FakeMessage[]> {
		this.searchCalls.push({ query, options });
		return (
			this.searchResponses.length
				? this.searchResponses.shift()
				: [{ id: "search-1", content: "search result", metadata: {} }]
		) as FakeMessage[];
	}

	async messages(): Promise<AsyncIterable<FakeMessage>> {
		return this.messagesResponse as AsyncIterable<FakeMessage>;
	}

	async delete(): Promise<void> {
		this.deleted = true;
		await this.onDelete?.(this.id);
	}
}

class FakeSdk implements HonchoSdkClient {
	readonly peersById = new Map<string, FakePeer>();
	readonly sessionsById = new Map<string, FakeSession>();
	readonly peerCalls: Array<{
		id: string;
		configuration?: { observeMe?: boolean };
	}> = [];
	readonly sessionCalls: string[] = [];
	readonly deletedWorkspaces: string[] = [];
	peerFailures = new Map<string, number>();
	peerGates = new Map<string, Promise<void>>();
	sessionFailures = new Map<string, number>();
	workspaceProbeResponses: unknown[] = [];
	peerListResponses: unknown[] = [];
	sessionListResponses: unknown[] = [];
	workspaceDeleteResponses: unknown[] = [];
	workspaceDeleteGate: Promise<void> | undefined;
	workspaceDeleteStarted: (() => void) | undefined;
	sessionDeleteGate: Promise<void> | undefined;
	sessionDeleteStarted: (() => void) | undefined;
	workspaceSetupFailure: Error | undefined;
	workspaceReady: Promise<void> | undefined;
	workspaceCreationAttempts = 0;
	readonly deletedSessionIds: string[] = [];
	activeDeletes = 0;
	maxActiveDeletes = 0;
	activeReads = 0;
	maxActiveReads = 0;

	constructor(peerIds: string[] = ["user", "pi"]) {
		for (const id of peerIds) this.peersById.set(id, new FakePeer(id));
	}

	getSession(id: string): FakeSession {
		let session = this.sessionsById.get(id);
		if (!session) {
			session = new FakeSession(id, (sessionId) =>
				this.deleteSession(sessionId),
			);
			this.sessionsById.set(id, session);
		}
		return session;
	}

	async workspaces(_options?: unknown): Promise<FakePage<string>> {
		const response = this.workspaceProbeResponses.shift();
		if (response instanceof Error) throw response;
		return (
			response === undefined ? new FakePage(["pi-test"]) : response
		) as FakePage<string>;
	}

	async peer(
		id: string,
		options?: { configuration?: { observeMe?: boolean } },
	): Promise<FakePeer> {
		await this.ensureWorkspace();
		this.peerCalls.push({ id, configuration: options?.configuration });
		await this.peerGates.get(id);
		const failures = this.peerFailures.get(id) ?? 0;
		if (failures > 0) {
			this.peerFailures.set(id, failures - 1);
			throw new Error("peer setup failed");
		}
		const peer = this.peersById.get(id);
		if (!peer) throw new Error(`Missing fake peer ${id}`);
		return peer;
	}

	async session(id: string): Promise<FakeSession> {
		await this.ensureWorkspace();
		this.sessionCalls.push(id);
		const failures = this.sessionFailures.get(id) ?? 0;
		if (failures > 0) {
			this.sessionFailures.set(id, failures - 1);
			throw new Error("session lookup failed");
		}
		return this.getSession(id);
	}

	async peers(): Promise<FakePage<FakePeer>> {
		const response = this.peerListResponses.shift();
		if (response instanceof Error) throw response;
		return this.remoteRead(
			(response ??
				new FakePage(
					[...this.peersById.values()],
					this.peersById.size,
				)) as FakePage<FakePeer>,
		);
	}

	async sessions(): Promise<FakePage<FakeSession>> {
		const response = this.sessionListResponses.shift();
		if (response instanceof Error) throw response;
		return this.remoteRead(
			(response ??
				new FakePage(
					[...this.sessionsById.values()],
					this.sessionsById.size,
				)) as FakePage<FakeSession>,
		);
	}

	async deleteWorkspace(id: string): Promise<void> {
		this.deletedWorkspaces.push(id);
		this.workspaceDeleteStarted?.();
		await this.workspaceDeleteGate;
		const response = this.workspaceDeleteResponses.shift();
		if (response instanceof Error) throw response;
	}

	trackConclusionReads(): void {
		for (const observer of this.peersById.values()) {
			for (const observed of this.peersById.values()) {
				const scope = observer.conclusionsOf(observed);
				scope.list = () => this.remoteRead(new FakePage([], scope.count));
			}
		}
	}

	private async ensureWorkspace(): Promise<void> {
		if (!this.workspaceReady) {
			this.workspaceCreationAttempts += 1;
			this.workspaceReady = this.workspaceSetupFailure
				? Promise.reject(this.workspaceSetupFailure)
				: Promise.resolve();
		}
		await this.workspaceReady;
	}

	private async deleteSession(id: string): Promise<void> {
		this.activeDeletes += 1;
		this.maxActiveDeletes = Math.max(this.maxActiveDeletes, this.activeDeletes);
		this.sessionDeleteStarted?.();
		await this.sessionDeleteGate;
		await new Promise((resolve) => setTimeout(resolve, 0));
		this.deletedSessionIds.push(id);
		this.activeDeletes -= 1;
	}

	private async remoteRead<T>(value: T): Promise<T> {
		this.activeReads += 1;
		this.maxActiveReads = Math.max(this.maxActiveReads, this.activeReads);
		await new Promise((resolve) => setTimeout(resolve, 0));
		this.activeReads -= 1;
		return value;
	}
}

function adapter(fake = new FakeSdk()): SdkHonchoMemoryClient {
	return new SdkHonchoMemoryClient(config, () => fake);
}

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolve: () => void = () => undefined;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

test("injects the SDK factory and probes the configured workspace", async () => {
	const fake = new FakeSdk();
	let options: unknown;
	const client = new SdkHonchoMemoryClient(config, (createdOptions) => {
		options = createdOptions;
		return fake;
	});

	await client.checkConnection();
	assert.deepEqual(options, {
		apiKey: "test-key",
		baseURL: "https://honcho.invalid",
		workspaceId: "pi-test",
		timeout: 123,
		maxRetries: 0,
	});

	fake.workspaceProbeResponses.push(new Error("connection failed"), null);
	await assert.rejects(client.checkConnection(), /connection failed/);
	await assert.rejects(
		client.checkConnection(),
		/malformed workspace response/i,
	);
	await client.checkConnection();
});

test("maps cached recall, delivery, reconciliation, and tool operations", async () => {
	const fake = new FakeSdk();
	const session = fake.getSession("project");
	session.messagesResponse = new FakePage<FakeMessage>([
		{
			id: "existing-1",
			content: "old",
			metadata: { operationId: "pi-entry-1" },
		},
		{ id: "other", content: "other", metadata: {} },
		{
			id: "existing-2",
			content: "old",
			metadata: { operationId: "pi-entry-1" },
		},
	]);
	const pi = fake.peersById.get("pi");
	assert.ok(pi);
	pi.chatResponses.push(null, "remembered answer");
	const client = adapter(fake);

	assert.deepEqual(await client.fetchCachedMemory("project"), {
		summary: "project summary",
		userRepresentation: "user representation",
	});
	assert.deepEqual(session.contextCalls, [
		{
			summary: true,
			tokens: 800,
			peerPerspective: pi,
			peerTarget: fake.peersById.get("user"),
			limitToSession: false,
		},
	]);
	assert.deepEqual(session.addedPeerSets, [
		[
			[fake.peersById.get("user"), { observeMe: true, observeOthers: true }],
			[pi, { observeMe: false, observeOthers: true }],
		],
	]);
	const messageIds = await client.deliverExchange("project", {
		operationId: "pi-entry-1",
		userText: "123456",
		assistantText: "abcdef",
	});
	assert.equal(messageIds.length, 4);
	assert.deepEqual(session.addedMessageSets[0], [
		{
			peerId: "user",
			content: "12345",
			metadata: {
				operationId: "pi-entry-1",
				participant: "user",
				chunkIndex: 0,
				chunkCount: 2,
			},
		},
		{
			peerId: "user",
			content: "6",
			metadata: {
				operationId: "pi-entry-1",
				participant: "user",
				chunkIndex: 1,
				chunkCount: 2,
			},
		},
		{
			peerId: "pi",
			content: "abcde",
			metadata: {
				operationId: "pi-entry-1",
				participant: "assistant",
				chunkIndex: 0,
				chunkCount: 2,
			},
		},
		{
			peerId: "pi",
			content: "f",
			metadata: {
				operationId: "pi-entry-1",
				participant: "assistant",
				chunkIndex: 1,
				chunkCount: 2,
			},
		},
	]);
	assert.deepEqual(await client.reconcileOperationId("project", "pi-entry-1"), [
		"existing-1",
		"existing-2",
	]);
	assert.deepEqual(await client.search("project", "needle"), ["search result"]);
	assert.deepEqual(session.searchCalls, [
		{ query: "needle", options: { limit: 10 } },
	]);
	assert.equal(await client.chat("project", "unknown"), undefined);
	assert.equal(await client.chat("project", "known"), "remembered answer");
	assert.deepEqual(pi.chatCalls, [
		{
			query: "unknown",
			options: { target: fake.peersById.get("user"), session },
		},
		{
			query: "known",
			options: { target: fake.peersById.get("user"), session },
		},
	]);
	assert.equal(
		await client.remember("project", "Use TypeScript"),
		"conclusion-1",
	);
	const scope = pi.conclusionsOf("user");
	assert.deepEqual(scope.created, [
		{ content: "Use TypeScript", sessionId: "project" },
	]);
	await client.deleteConclusion("project", "conclusion-1");
	assert.deepEqual(scope.deleted, ["conclusion-1"]);
});

test("retries failed setup and shares concurrent successful setup", async () => {
	const peerFake = new FakeSdk();
	peerFake.peerFailures.set("user", 1);
	const peerRetryFake = new FakeSdk();
	const peerFakes = [peerFake, peerRetryFake];
	const peerClient = new SdkHonchoMemoryClient(
		config,
		() => peerFakes.shift() ?? peerRetryFake,
	);
	await assert.rejects(
		peerClient.search("project", "first"),
		/peer setup failed/,
	);
	assert.deepEqual(await peerClient.search("project", "second"), [
		"search result",
	]);
	assert.equal(peerFake.peerCalls.filter(({ id }) => id === "user").length, 1);
	assert.equal(
		peerRetryFake.peerCalls.filter(({ id }) => id === "user").length,
		1,
	);

	const sessionFake = new FakeSdk();
	const retrySession = sessionFake.getSession("project");
	retrySession.addPeersFailures = 1;
	const sessionRetryFake = new FakeSdk();
	const sessionFakes = [sessionFake, sessionRetryFake];
	const sessionClient = new SdkHonchoMemoryClient(
		config,
		() => sessionFakes.shift() ?? sessionRetryFake,
	);
	await assert.rejects(
		sessionClient.search("project", "first"),
		/session setup failed/,
	);
	assert.deepEqual(await sessionClient.search("project", "second"), [
		"search result",
	]);
	assert.equal(sessionFake.sessionCalls.length, 1);
	assert.equal(retrySession.addedPeerSets.length, 1);
	assert.equal(sessionRetryFake.sessionCalls.length, 1);

	const concurrentFake = new FakeSdk();
	const concurrentClient = adapter(concurrentFake);
	await Promise.all([
		concurrentClient.fetchCachedMemory("project"),
		concurrentClient.search("project", "query"),
		concurrentClient.chat("project", "query"),
	]);
	assert.equal(concurrentFake.sessionCalls.length, 1);
	assert.equal(concurrentFake.getSession("project").addedPeerSets.length, 1);
	assert.deepEqual(
		concurrentFake.peerCalls.map(({ id, configuration }) => ({
			id,
			observeMe: configuration?.observeMe,
		})),
		[
			{ id: "user", observeMe: true },
			{ id: "pi", observeMe: false },
		],
	);
});

test("replaces poisoned SDK instances without letting stale setup failures win", async () => {
	const poisoned = new FakeSdk();
	poisoned.workspaceSetupFailure = new Error("workspace setup failed");
	const recovered = new FakeSdk();
	const recreated = new FakeSdk();
	const instances = [poisoned, recovered, recreated];
	const client = new SdkHonchoMemoryClient(
		config,
		() => instances.shift() ?? recovered,
	);

	await assert.rejects(
		client.search("project", "first"),
		/workspace setup failed/,
	);
	assert.equal(poisoned.workspaceCreationAttempts, 1);
	assert.deepEqual(await client.search("project", "retry"), ["search result"]);
	assert.equal(recovered.workspaceCreationAttempts, 1);

	await client.deleteWorkspace("pi-test");
	assert.deepEqual(recovered.deletedWorkspaces, ["pi-test"]);
	assert.equal(instances.length, 0);
	assert.deepEqual(await client.search("project", "recreate"), [
		"search result",
	]);
	assert.equal(recovered.workspaceCreationAttempts, 1);
	assert.equal(recreated.workspaceCreationAttempts, 1);

	const stale = new FakeSdk();
	const fresh = new FakeSdk();
	const staleInstances = [stale, fresh];
	let staleFactoryCalls = 0;
	const staleClient = new SdkHonchoMemoryClient(config, () => {
		staleFactoryCalls += 1;
		return staleInstances.shift() ?? fresh;
	});
	const gate = deferred();
	stale.peerGates.set("user", gate.promise);
	const staleSearch = staleClient.search("stale", "query");
	await new Promise((resolve) => setTimeout(resolve, 0));
	stale.sessionFailures.set("replace", 1);
	await assert.rejects(
		staleClient.search("replace", "query"),
		/session lookup failed/,
	);
	assert.deepEqual(await staleClient.search("fresh", "query"), [
		"search result",
	]);
	stale.peerFailures.set("user", 1);
	gate.resolve();
	await assert.rejects(staleSearch, /peer setup failed/);
	assert.equal(staleFactoryCalls, 2);
	assert.deepEqual(await staleClient.search("fresh", "again"), [
		"search result",
	]);
});

test("refreshes failed direct SDK operations before retrying", async () => {
	const cloneFailure = new FakeSdk();
	cloneFailure.workspaceSetupFailure = new Error("clone lookup failed");
	const inspectionFailure = new FakeSdk();
	inspectionFailure.peerListResponses.push(new Error("inspection failed"));
	const sessionDeletionFailure = new FakeSdk();
	sessionDeletionFailure.workspaceSetupFailure = new Error(
		"session delete lookup failed",
	);
	const workspaceDeletionFailure = new FakeSdk();
	workspaceDeletionFailure.workspaceDeleteResponses.push(
		new Error("workspace deletion failed"),
	);
	const connectionFailure = new FakeSdk();
	connectionFailure.workspaceProbeResponses.push(
		new Error("connection failed"),
	);
	const recovered = new FakeSdk();
	const afterWorkspaceDeletion = new FakeSdk();
	const instances = [
		cloneFailure,
		inspectionFailure,
		sessionDeletionFailure,
		workspaceDeletionFailure,
		connectionFailure,
		recovered,
		afterWorkspaceDeletion,
	];
	let factoryCalls = 0;
	const client = new SdkHonchoMemoryClient(config, () => {
		factoryCalls += 1;
		return instances.shift() ?? afterWorkspaceDeletion;
	});

	await assert.rejects(
		client.cloneSession("project", "message"),
		/clone lookup failed/,
	);
	assert.equal(
		await client.cloneSession("project", "message"),
		"project-clone",
	);

	await assert.rejects(client.inspectWorkspace(), /inspection failed/);
	await client.inspectWorkspace();

	await assert.rejects(
		client.deleteSession("project"),
		/session delete lookup failed/,
	);
	await client.deleteSession("project");

	await assert.rejects(
		client.deleteWorkspace("pi-test"),
		/workspace deletion failed/,
	);
	await assert.rejects(client.checkConnection(), /connection failed/);
	await client.checkConnection();

	await client.deleteWorkspace("pi-test");
	assert.equal(
		await client.cloneSession("project", "message"),
		"project-clone",
	);
	assert.equal(factoryCalls, 7);
});

test("workspace deletion invalidates a newer SDK replacement", async () => {
	const deleting = new FakeSdk();
	const replaced = new FakeSdk();
	const afterDeletion = new FakeSdk();
	const instances = [deleting, replaced, afterDeletion];
	const client = new SdkHonchoMemoryClient(
		config,
		() => instances.shift() ?? afterDeletion,
	);
	const deletionGate = deferred();
	const deletionStarted = deferred();
	deleting.workspaceDeleteGate = deletionGate.promise;
	deleting.workspaceDeleteStarted = deletionStarted.resolve;

	const deletion = client.deleteWorkspace("pi-test");
	await deletionStarted.promise;
	deleting.workspaceProbeResponses.push(new Error("replace client"));
	await assert.rejects(client.checkConnection(), /replace client/);
	await client.search("project", "cache current client");

	deletionGate.resolve();
	await deletion;
	await client.search("project", "open fresh client");

	assert.equal(replaced.sessionCalls.length, 1);
	assert.equal(afterDeletion.sessionCalls.length, 1);
});

test("session deletion removes a newer cached session", async () => {
	const deleting = new FakeSdk();
	const replaced = new FakeSdk();
	const instances = [deleting, replaced];
	const client = new SdkHonchoMemoryClient(
		config,
		() => instances.shift() ?? replaced,
	);
	const deletionGate = deferred();
	const deletionStarted = deferred();
	deleting.sessionDeleteGate = deletionGate.promise;
	deleting.sessionDeleteStarted = deletionStarted.resolve;

	const deletion = client.deleteSession("project");
	await deletionStarted.promise;
	deleting.workspaceProbeResponses.push(new Error("replace client"));
	await assert.rejects(client.checkConnection(), /replace client/);
	await client.search("project", "cache current session");

	deletionGate.resolve();
	await deletion;
	await client.search("project", "reopen deleted session");

	assert.equal(replaced.sessionCalls.length, 2);
});

test("inspects complete workspace counts concurrently and performs explicit deletion and cloning", async () => {
	const fake = new FakeSdk(["user", "pi", "reviewer"]);
	fake.getSession("one");
	fake.getSession("two");
	fake.trackConclusionReads();
	let conclusionCount = 0;
	for (const observer of fake.peersById.values()) {
		for (const observed of fake.peersById.values()) {
			const scope = observer.conclusionsOf(observed);
			scope.count = conclusionCount;
			conclusionCount += 1;
		}
	}
	const client = adapter(fake);

	assert.deepEqual(await client.inspectWorkspace(), {
		workspaceId: "pi-test",
		peerIds: ["pi", "reviewer", "user"],
		sessionCount: 2,
		conclusionCount: 36,
	});
	assert.ok(fake.maxActiveReads > 1);
	assert.equal(await client.cloneSession("one", "message-3"), "one-clone");
	assert.deepEqual(fake.getSession("one").cloneMessageIds, ["message-3"]);

	await client.deleteSession("one");
	assert.equal(fake.getSession("one").deleted, true);
	fake.deletedSessionIds.length = 0;
	fake.maxActiveDeletes = 0;
	await client.deleteWorkspace("pi-test");
	assert.equal(fake.getSession("two").deleted, true);
	assert.deepEqual(fake.deletedSessionIds, ["one", "two"]);
	assert.equal(fake.maxActiveDeletes, 1);
	assert.deepEqual(fake.deletedWorkspaces, ["pi-test"]);
	await assert.rejects(
		client.deleteWorkspace("other"),
		/does not match the configured workspace/i,
	);
});

test("rejects empty or malformed responses without poisoning later calls", async () => {
	const fake = new FakeSdk();
	const session = fake.getSession("project");
	const pi = fake.peersById.get("pi");
	assert.ok(pi);
	const scope = pi.conclusionsOf("user");
	const client = adapter(fake);

	await assert.rejects(client.remember("project", "   "), /cannot be empty/i);
	assert.equal(scope.created.length, 0);
	scope.createResponses.push([], [{ id: "conclusion-2" }]);
	await assert.rejects(
		client.remember("project", "remember me"),
		/did not create/i,
	);
	assert.equal(await client.remember("project", "remember me"), "conclusion-2");

	session.contextResponses.push(
		null,
		{ peerRepresentation: ["not a string"] },
		{ peerCard: ["card item", 1] },
		{ peerCard: ["card item"] },
	);
	await assert.rejects(
		client.fetchCachedMemory("project"),
		/malformed context/i,
	);
	await assert.rejects(
		client.fetchCachedMemory("project"),
		/malformed peer representation/i,
	);
	await assert.rejects(
		client.fetchCachedMemory("project"),
		/malformed peer card/i,
	);
	assert.deepEqual(await client.fetchCachedMemory("project"), {
		summary: undefined,
		userRepresentation: "card item",
	});

	session.addMessageResponses.push([], new Error("remote delivery failed"));
	await assert.rejects(
		client.deliverExchange("project", {
			operationId: "empty-delivery",
			userText: "user",
			assistantText: "assistant",
		}),
		/did not return message IDs/i,
	);
	await assert.rejects(
		client.deliverExchange("project", {
			operationId: "failed-delivery",
			userText: "user",
			assistantText: "assistant",
		}),
		/remote delivery failed/,
	);
	assert.equal(
		(
			await client.deliverExchange("project", {
				operationId: "successful-delivery",
				userText: "user",
				assistantText: "assistant",
			})
		).length,
		3,
	);

	session.searchResponses.push(null, [
		{ id: "search-2", content: "recovered", metadata: {} },
	]);
	await assert.rejects(client.search("project", "bad"), /malformed search/i);
	assert.deepEqual(await client.search("project", "good"), ["recovered"]);

	session.cloneResponses.push({}, { id: "clone-recovered" });
	await assert.rejects(
		client.cloneSession("project", "message"),
		/did not return a cloned memory session/i,
	);
	assert.equal(
		await client.cloneSession("project", "message"),
		"clone-recovered",
	);
});
