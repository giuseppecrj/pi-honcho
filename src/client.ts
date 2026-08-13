import { Honcho } from "@honcho-ai/sdk"; // pi-lens-ignore: find-import-file-without-extension

import type { HonchoConnectionConfig } from "./config.js";
import type { HonchoExchangeClient, HonchoRecoveryClient } from "./delivery.js";
import type { FinalizedExchange } from "./exchange.js";
import { chunkText } from "./exchange.js";
import type { CachedMemory } from "./memory-context.js";
import type { HonchoMemoryClient } from "./status.js";

interface HonchoSdkPage<T> extends AsyncIterable<T> {
	readonly total: number;
	toArray(): Promise<T[]>;
}

interface HonchoSdkConclusionScope {
	list(): Promise<{ readonly total: number }>;
	create(input: {
		content: string;
		sessionId: string;
	}): Promise<Array<{ readonly id: string }>>;
	delete(conclusionId: string): Promise<void>;
}

interface HonchoSdkPeer {
	readonly id: string;
	message(
		content: string,
		options?: { metadata?: Record<string, unknown> },
	): {
		peerId: string;
		content: string;
		metadata?: Record<string, unknown>;
	};
	chat(
		query: string,
		options?: { target?: unknown; session?: unknown },
	): Promise<string | null>;
	conclusionsOf(target: unknown): HonchoSdkConclusionScope;
}

interface HonchoSdkMessage {
	readonly id: string;
	readonly content: string;
	readonly metadata: Record<string, unknown>;
}

interface HonchoSdkSession {
	readonly id: string;
	addPeers(peers: unknown): Promise<void>;
	addMessages(messages: unknown): Promise<HonchoSdkMessage[]>;
	context(options: unknown): Promise<{
		summary?: { content?: unknown } | null;
		peerRepresentation?: unknown;
		peerCard?: unknown;
	}>;
	clone(messageId: string): Promise<{ readonly id: string }>;
	search(
		query: string,
		options?: { limit?: number },
	): Promise<HonchoSdkMessage[]>;
	messages(): Promise<AsyncIterable<HonchoSdkMessage>>;
	delete(): Promise<void>;
}

export interface HonchoSdkClient {
	workspaces(options?: unknown): Promise<HonchoSdkPage<string>>;
	peer(
		id: string,
		options?: { configuration?: { observeMe?: boolean } },
	): Promise<HonchoSdkPeer>;
	session(id: string): Promise<HonchoSdkSession>;
	peers(): Promise<HonchoSdkPage<HonchoSdkPeer>>;
	sessions(): Promise<HonchoSdkPage<HonchoSdkSession>>;
	deleteWorkspace(workspaceId: string): Promise<void>;
}

type HonchoSdkFactory = (
	options: ConstructorParameters<typeof Honcho>[0],
) => HonchoSdkClient;

type OpenSession = {
	user: HonchoSdkPeer;
	pi: HonchoSdkPeer;
	session: HonchoSdkSession;
};

function sdkPage<T>(value: unknown, description: string): HonchoSdkPage<T> {
	if (
		!value ||
		typeof value !== "object" ||
		!(Symbol.asyncIterator in value) ||
		!("toArray" in value) ||
		typeof value.toArray !== "function" ||
		!("total" in value) ||
		typeof value.total !== "number" ||
		!Number.isSafeInteger(value.total) ||
		value.total < 0
	)
		throw new Error(`Honcho returned a malformed ${description}`);
	return value as HonchoSdkPage<T>;
}

function nonEmptyId(value: unknown, description: string): string {
	if (typeof value !== "string" || !value.trim())
		throw new Error(`Honcho did not return ${description}`);
	return value;
}

export interface WorkspaceInspection {
	workspaceId: string;
	peerIds: string[];
	sessionCount: number;
	conclusionCount: number;
}

export interface HonchoForkClient {
	cloneSession(sessionId: string, messageId: string): Promise<string>;
}

export interface HonchoToolClient {
	search(sessionId: string, query: string): Promise<string[]>;
	chat(sessionId: string, query: string): Promise<string | undefined>;
	remember(sessionId: string, content: string): Promise<string>;
	deleteSession(sessionId: string): Promise<void>;
	deleteConclusion(sessionId: string, conclusionId: string): Promise<void>;
	inspectWorkspace(): Promise<WorkspaceInspection>;
	deleteWorkspace(workspaceId: string): Promise<void>;
}

// pi-lens-ignore: large-class — single SDK adapter implementing the transport interfaces
export class SdkHonchoMemoryClient
	implements
		HonchoMemoryClient,
		HonchoExchangeClient,
		HonchoRecoveryClient,
		HonchoForkClient,
		HonchoToolClient
{
	private client: HonchoSdkClient;
	private generation = 0;
	private readonly createSdk: HonchoSdkFactory;
	private readonly sdkOptions: ConstructorParameters<typeof Honcho>[0];
	private readonly peers = new Map<string, Promise<HonchoSdkPeer>>();
	private readonly sessions = new Map<string, Promise<OpenSession>>();

	constructor(
		private readonly config: HonchoConnectionConfig,
		createSdk: HonchoSdkFactory = (options) => new Honcho(options),
	) {
		this.createSdk = createSdk;
		this.sdkOptions = {
			apiKey: config.apiKey,
			baseURL: config.baseUrl,
			workspaceId: config.workspaceId,
			timeout: config.timeoutMs,
			maxRetries: 0,
		};
		this.client = this.createSdk(this.sdkOptions);
	}

	async checkConnection(): Promise<void> {
		await this.direct(async (client) => {
			sdkPage(await client.workspaces({ size: 1 }), "workspace response");
		});
	}

	async fetchCachedMemory(sessionId: string): Promise<CachedMemory> {
		const { user, pi, session } = await this.openSession(sessionId);
		const context: unknown = await session.context({
			summary: true,
			tokens: 800,
			peerPerspective: pi,
			peerTarget: user,
			limitToSession: false,
		});
		if (!context || typeof context !== "object")
			throw new Error("Honcho returned a malformed context");
		const { summary, peerRepresentation, peerCard } = context as {
			summary?: unknown;
			peerRepresentation?: unknown;
			peerCard?: unknown;
		};
		if (
			summary != null &&
			(typeof summary !== "object" ||
				!("content" in summary) ||
				typeof summary.content !== "string")
		)
			throw new Error("Honcho returned a malformed context summary");
		if (peerRepresentation != null && typeof peerRepresentation !== "string")
			throw new Error("Honcho returned a malformed peer representation");
		if (
			peerCard != null &&
			(!Array.isArray(peerCard) ||
				peerCard.some((item) => typeof item !== "string"))
		)
			throw new Error("Honcho returned a malformed peer card");
		return {
			summary:
				summary && typeof summary === "object" && "content" in summary
					? (summary.content as string)
					: undefined,
			userRepresentation:
				(peerRepresentation as string | null | undefined) ??
				(peerCard as string[] | null | undefined)?.join("\n"),
		};
	}

	async deliverExchange(
		sessionId: string,
		exchange: FinalizedExchange,
	): Promise<string[]> {
		const { user, pi, session } = await this.openSession(sessionId);
		const metadata = { operationId: exchange.operationId };
		const messages = [
			...chunkText(exchange.userText, this.config.maxMessageLength).map(
				(content, chunkIndex, chunks) =>
					user.message(content, {
						metadata: {
							...metadata,
							participant: "user",
							chunkIndex,
							chunkCount: chunks.length,
						},
					}),
			),
			...chunkText(exchange.assistantText, this.config.maxMessageLength).map(
				(content, chunkIndex, chunks) =>
					pi.message(content, {
						metadata: {
							...metadata,
							participant: "assistant",
							chunkIndex,
							chunkCount: chunks.length,
						},
					}),
			),
		];
		const delivered: unknown = await session.addMessages(messages);
		if (!Array.isArray(delivered) || delivered.length !== messages.length)
			throw new Error("Honcho did not return message IDs for the delivery");
		return delivered.map((message) =>
			nonEmptyId(
				message && typeof message === "object" && "id" in message
					? message.id
					: undefined,
				"a message ID for the delivery",
			),
		);
	}

	async reconcileOperationId(
		sessionId: string,
		operationId: string,
	): Promise<string[]> {
		const { session } = await this.openSession(sessionId);
		return this.findAcknowledgedMessages(session, operationId);
	}

	async cloneSession(sessionId: string, messageId: string): Promise<string> {
		return this.direct(async (client) => {
			const session = await client.session(sessionId);
			const cloned: unknown = await session.clone(messageId);
			return nonEmptyId(
				cloned && typeof cloned === "object" && "id" in cloned
					? cloned.id
					: undefined,
				"a cloned memory session",
			);
		});
	}

	async search(sessionId: string, query: string): Promise<string[]> {
		const { session } = await this.openSession(sessionId);
		const results: unknown = await session.search(query, { limit: 10 });
		if (!Array.isArray(results))
			throw new Error("Honcho returned malformed search results");
		return results.map((message) => {
			if (
				!message ||
				typeof message !== "object" ||
				!("content" in message) ||
				typeof message.content !== "string"
			)
				throw new Error("Honcho returned a malformed search result");
			return message.content;
		});
	}

	async chat(sessionId: string, query: string): Promise<string | undefined> {
		const { user, pi, session } = await this.openSession(sessionId);
		const response: unknown = await pi.chat(query, { target: user, session });
		if (response == null || response === "") return undefined;
		if (typeof response !== "string")
			throw new Error("Honcho returned a malformed chat response");
		return response;
	}

	async remember(sessionId: string, content: string): Promise<string> {
		if (!content.trim()) throw new Error("Conclusion content cannot be empty");
		const { user, pi } = await this.openSession(sessionId);
		const conclusions: unknown = await pi.conclusionsOf(user).create({
			content,
			sessionId,
		});
		if (!Array.isArray(conclusions) || conclusions.length === 0)
			throw new Error("Honcho did not create a conclusion");
		return nonEmptyId(
			conclusions[0] &&
				typeof conclusions[0] === "object" &&
				"id" in conclusions[0]
				? conclusions[0].id
				: undefined,
			"a conclusion ID",
		);
	}

	async inspectWorkspace(): Promise<WorkspaceInspection> {
		return this.direct(async (client) => {
			const [peerResponse, sessionResponse] = await Promise.all([
				client.peers(),
				client.sessions(),
			]);
			const peerPage = sdkPage<HonchoSdkPeer>(peerResponse, "peer response");
			const sessionPage = sdkPage<HonchoSdkSession>(
				sessionResponse,
				"memory session response",
			);
			const peers = await peerPage.toArray();
			if (!Array.isArray(peers))
				throw new Error("Honcho returned a malformed peer list");
			const conclusionCounts = await Promise.all(
				peers.flatMap((observer) =>
					peers.map(async (observed) => {
						const response = await observer.conclusionsOf(observed).list();
						const count = response?.total;
						if (!Number.isSafeInteger(count) || count < 0)
							throw new Error("Honcho returned a malformed conclusion count");
						return count;
					}),
				),
			);
			const conclusionCount = conclusionCounts.reduce(
				(total, count) => total + count,
				0,
			);
			return {
				workspaceId: this.config.workspaceId,
				peerIds: peers
					.map((peer) => peer.id)
					.sort((left, right) => left.localeCompare(right)),
				sessionCount: sessionPage.total,
				conclusionCount,
			};
		});
	}

	async deleteWorkspace(workspaceId: string): Promise<void> {
		if (workspaceId !== this.config.workspaceId)
			throw new Error("Workspace does not match the configured workspace");
		await this.direct(async (client) => {
			const sessionPage = sdkPage<HonchoSdkSession>(
				await client.sessions(),
				"memory session response",
			);
			const sessions = await sessionPage.toArray();
			if (!Array.isArray(sessions))
				throw new Error("Honcho returned a malformed memory session list");
			for (const session of sessions) await session.delete();
			await client.deleteWorkspace(workspaceId);
		});
		this.replaceCurrentClient();
	}

	async deleteSession(sessionId: string): Promise<void> {
		await this.direct(async (client) => {
			const session = await client.session(sessionId);
			await session.delete();
		});
		this.sessions.delete(sessionId);
	}

	async deleteConclusion(
		sessionId: string,
		conclusionId: string,
	): Promise<void> {
		const { user, pi } = await this.openSession(sessionId);
		await pi.conclusionsOf(user).delete(conclusionId);
	}

	private async findAcknowledgedMessages(
		session: HonchoSdkSession,
		operationId: string,
	): Promise<string[]> {
		const messages: unknown = await session.messages();
		if (
			!messages ||
			typeof messages !== "object" ||
			!(Symbol.asyncIterator in messages)
		)
			throw new Error("Honcho returned a malformed message history");
		const acknowledged: string[] = [];
		for await (const message of messages as AsyncIterable<unknown>) {
			if (
				!message ||
				typeof message !== "object" ||
				!("metadata" in message) ||
				!message.metadata ||
				typeof message.metadata !== "object"
			)
				throw new Error("Honcho returned a malformed message history entry");
			if (
				"operationId" in message.metadata &&
				message.metadata.operationId === operationId
			)
				acknowledged.push(
					nonEmptyId(
						"id" in message ? message.id : undefined,
						"a reconciled message ID",
					),
				);
		}
		return acknowledged;
	}

	private openSession(sessionId: string): Promise<OpenSession> {
		const existing = this.sessions.get(sessionId);
		if (existing) return existing;
		const client = this.client;
		const generation = this.generation;
		const opening = this.createSession(sessionId, client, generation).catch(
			(error) => {
				if (this.sessions.get(sessionId) === opening)
					this.sessions.delete(sessionId);
				this.replaceClient(client, generation);
				throw error;
			},
		);
		this.sessions.set(sessionId, opening);
		return opening;
	}

	private async createSession(
		sessionId: string,
		client: HonchoSdkClient,
		generation: number,
	): Promise<OpenSession> {
		const [[user, pi], session] = await Promise.all([
			Promise.all([
				this.openPeer(this.config.peerName, true, client, generation),
				this.openPeer(this.config.aiPeer, false, client, generation),
			]),
			client.session(sessionId),
		]);
		await session.addPeers([
			[user, { observeMe: true, observeOthers: true }],
			[pi, { observeMe: false, observeOthers: true }],
		]);
		return { user, pi, session };
	}

	private openPeer(
		id: string,
		observeMe: boolean,
		client: HonchoSdkClient,
		generation: number,
	): Promise<HonchoSdkPeer> {
		const existing = this.peers.get(id);
		if (existing) return existing;
		const opening = client
			.peer(id, { configuration: { observeMe } })
			.catch((error) => {
				if (this.peers.get(id) === opening) this.peers.delete(id);
				this.replaceClient(client, generation);
				throw error;
			});
		this.peers.set(id, opening);
		return opening;
	}

	private async direct<T>(
		operation: (client: HonchoSdkClient) => Promise<T>,
	): Promise<T> {
		const client = this.client;
		const generation = this.generation;
		try {
			return await operation(client);
		} catch (error) {
			this.replaceClient(client, generation);
			throw error;
		}
	}

	private replaceClient(client: HonchoSdkClient, generation: number): void {
		if (this.client !== client || this.generation !== generation) return;
		this.replaceCurrentClient();
	}

	private replaceCurrentClient(): void {
		this.client = this.createSdk(this.sdkOptions);
		this.generation += 1;
		this.sessions.clear();
		this.peers.clear();
	}
}
