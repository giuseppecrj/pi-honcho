import {
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
	SessionManager,
} from "@earendil-works/pi-coding-agent"; // pi-lens-ignore: find-import-file-without-extension
import { Type } from "typebox";

import {
	type HonchoForkClient,
	type HonchoToolClient,
	SdkHonchoMemoryClient,
	type WorkspaceInspection,
} from "./client.js";
import {
	commandArgumentCompletions,
	dispatchHonchoCommand,
	formatHonchoCommandHelp,
} from "./command-namespace.js";
import {
	deletionTarget,
	type HonchoConfiguration,
	type HonchoConnectionConfig,
	isValidHonchoWorkspaceId,
	resolveHonchoConfig,
	resolveHonchoWorkspace,
} from "./config.js";
import {
	loadHonchoConfigFile,
	loadProjectHonchoPolicy,
	readProjectHonchoPolicyFile,
	saveHonchoSettings,
	saveProjectHonchoPolicy,
} from "./config-file.js";
import {
	ExchangeDeliveryQueue,
	type HonchoExchangeClient,
	type HonchoRecoveryClient,
} from "./delivery.js";
import {
	DELIVERY_LEDGER_KEY,
	type DeliveryLedgerEntry,
	deliveryLedger,
} from "./delivery-ledger.js";
import { safeExchange } from "./exchange.js";
import {
	FORK_LEDGER_KEY,
	type ForkLedgerEntry,
	forkLedger,
	InMemoryForkHandoffs,
	latestRemoteMessageAtFork,
	resolveRemoteSessionForStartup,
	SESSION_MAPPING_KEY,
} from "./fork.js";
import {
	type CachedMemory,
	contextBudget,
	formatMemoryContext,
} from "./memory-context.js";
import { disableProjectMemoryNow } from "./privacy-barrier.js";
import type { ProjectHonchoPolicy } from "./project-policy.js";
import {
	disableProjectPolicy,
	type ProjectPolicyCommandContext,
	type ProjectPolicyStore,
	projectPolicyPath,
	setupProjectPolicy,
} from "./project-policy-command.js";
import { repositorySessionKey } from "./session-key.js";
import {
	type HonchoMemoryClient,
	type HonchoMemoryStatus,
	HonchoStatusController,
} from "./status.js";
import { formatStatusDetails, type StatusDetails } from "./status-details.js";
import {
	deletionOutcomeIsUncertain,
	isWorkspaceResetEntry,
	resetConfirmation,
	resetRecovery,
	WORKSPACE_RESET_ENTRY_KEY,
} from "./workspace-reset.js";

const STATUS_KEY = "pi-honcho";
const FLUSH_TIMEOUT_MS = 2_000;
const inMemoryForkHandoffs = new InMemoryForkHandoffs();

async function persistedResetRecovery(
	workspaceId: string,
): Promise<StartupRecovery> {
	const sessions = await SessionManager.listAll();
	const resetEntries = await Promise.all(
		sessions.map((session) =>
			SessionManager.open(session.path)
				.getEntries()
				.flatMap((entry) =>
					entry.type === "custom" &&
					entry.customType === WORKSPACE_RESET_ENTRY_KEY &&
					isWorkspaceResetEntry(entry.data)
						? [{ data: entry.data, timestamp: entry.timestamp }]
						: [],
				),
		),
	);
	return resetRecovery(workspaceId, resetEntries.flat());
}

function remoteSessionIdForStartup(
	ctx: ExtensionContext,
	repositorySessionId: string,
	isFork: boolean,
	forkSourceSessionFile?: string,
): string {
	let sourceEntries: SessionEntry[] | undefined;
	if (forkSourceSessionFile) {
		try {
			sourceEntries = SessionManager.open(forkSourceSessionFile).getEntries();
		} catch {
			// The child remains isolated when its parent ledger is unavailable.
		}
	}
	return resolveRemoteSessionForStartup({
		repositorySessionId,
		piSessionId: ctx.sessionManager.getSessionId(),
		isFork,
		branch: ctx.sessionManager.getBranch(),
		sourceEntries,
		handoffs: inMemoryForkHandoffs,
	});
}

function latestCompletedAssistant(
	entries: SessionEntry[],
	entryIdsBeforeRun: ReadonlySet<string>,
): { entryId: string; text: string } | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type !== "message") continue;
		if (entryIdsBeforeRun.has(entry.id)) continue;
		const message = entry.message;
		if (message.role !== "assistant" || message.stopReason !== "stop") continue;
		const text = message.content
			.flatMap((content: { type: string; text?: string }) =>
				content.type === "text" && typeof content.text === "string"
					? [content.text]
					: [],
			)
			.join("")
			.trim();
		if (text) return { entryId: entry.id, text };
	}
	return undefined;
}

function describeStatus(status: HonchoMemoryStatus): string {
	switch (status.kind) {
		case "disabled":
			return `disabled — ${status.reason}`;
		case "unconfigured":
			return `unconfigured — ${status.reason}`;
		case "connecting":
			return "connecting";
		case "connected":
			return "connected";
		case "retrying":
			return `retrying — ${status.reason}`;
		default:
			return "unknown";
	}
}

function showStatus(
	ctx: ExtensionContext,
	status: HonchoMemoryStatus,
	workspaceId: string,
): void {
	if (ctx.hasUI) {
		const workspace =
			status.kind === "disabled" || status.kind === "unconfigured"
				? ""
				: ` · ${workspaceId}`;
		ctx.ui.setStatus(
			STATUS_KEY,
			`Honcho: ${describeStatus(status)}${workspace}`,
		);
	}
}

interface HonchoLifecycleClient
	extends HonchoExchangeClient,
		HonchoRecoveryClient,
		HonchoForkClient,
		HonchoMemoryClient,
		HonchoToolClient {
	fetchCachedMemory(sessionId: string): Promise<CachedMemory>;
}

type StartupClientFactory = (
	configuration: HonchoConnectionConfig,
) => HonchoLifecycleClient;

interface StartupConfiguration {
	policy: ProjectHonchoPolicy;
	workspace: {
		workspaceId: string;
		workspaceSource: StatusDetails["workspaceSource"];
	};
	configuration: HonchoConfiguration;
}

interface StartupRecovery {
	blocked: boolean;
	completedAt?: string;
}

interface StartupSession {
	sessionId: string;
	recovery: StartupRecovery;
	normalDeliveryOperationId?: string;
}

async function resolveStartupConfiguration(
	ctx: ExtensionContext,
): Promise<StartupConfiguration> {
	const policy = await loadProjectHonchoPolicy(ctx.cwd, ctx.isProjectTrusted());
	const configFile = await loadHonchoConfigFile();
	const workspace = resolveHonchoWorkspace(
		process.env,
		configFile,
		policy.workspaceId,
	);
	const configured = resolveHonchoConfig(
		process.env,
		configFile,
		policy.workspaceId,
	);
	return {
		policy,
		workspace,
		configuration: policy.enabled
			? configured
			: {
					kind: "disabled",
					reason: policy.reason ?? "Disabled by trusted project policy",
				},
	};
}

function createStartupClient(
	configuration: HonchoConfiguration,
	createClient: StartupClientFactory,
): HonchoLifecycleClient | undefined {
	return configuration.kind === "configured"
		? createClient(configuration.config)
		: undefined;
}

function startupStatusDetails(startup: StartupConfiguration): StatusDetails {
	const configured = startup.configuration;
	return {
		state: configured.kind,
		workspaceId: startup.workspace.workspaceId,
		userPeer:
			configured.kind === "configured" ? configured.config.peerName : undefined,
		aiPeer:
			configured.kind === "configured" ? configured.config.aiPeer : undefined,
		credentialSource: process.env.HONCHO_API_KEY
			? "environment"
			: "Honcho config",
		workspaceSource: startup.workspace.workspaceSource,
		projectPolicy: startup.policy.enabled ? "enabled" : "disabled",
		projectPolicyPath: startup.policy.policyPath,
		projectPolicyReason: startup.policy.reason,
	};
}

function resolveStartupSession(
	ctx: ExtensionContext,
	repositorySessionId: string,
	recovery: StartupRecovery,
	normalDeliveryOperationId: string | undefined,
	isFork: boolean,
	forkSourceSessionFile: string | undefined,
): StartupSession {
	return {
		sessionId: remoteSessionIdForStartup(
			ctx,
			repositorySessionId,
			isFork,
			forkSourceSessionFile,
		),
		recovery,
		normalDeliveryOperationId,
	};
}

function retrieveStartupMemory(
	client: HonchoLifecycleClient,
	session: StartupSession,
): Promise<CachedMemory> {
	return client.fetchCachedMemory(session.sessionId);
}

// This is the extension lifecycle coordinator; its event registrations are intentional.
// pi-lens-ignore: high-complexity, high-fan-out
export default function honchoMemory(
	pi: ExtensionAPI,
	createLifecycleClient: StartupClientFactory = (configuration) =>
		new SdkHonchoMemoryClient(configuration),
): void {
	if (process.env.PI_SUBAGENT_ID?.trim()) return;

	let controller: HonchoStatusController | undefined;
	let cachedMemory: CachedMemory | undefined;
	let deliveryQueue: ExchangeDeliveryQueue | undefined;
	let forkClient: HonchoForkClient | undefined;
	let toolClient: HonchoToolClient | undefined;
	let remoteSessionId: string | undefined;
	let memoryGeneration = 0;
	let submittedPrompt: string | undefined;
	let entryIdsBeforeRun = new Set<string>();
	let resetBlocked = false;
	let awaitingRemoteRecreation = false;
	let privacyDisabled = false;
	let statusDetails: StatusDetails = { state: "unconfigured" };

	function isCurrentStartup(generation: number): boolean {
		return generation === memoryGeneration;
	}

	function staleStartupStatus(): HonchoMemoryStatus {
		return { kind: "unconfigured", reason: "Startup superseded" };
	}

	function replayStartupDelivery(
		ctx: ExtensionContext,
		client: HonchoLifecycleClient,
		session: StartupSession,
		generation: number,
	): ExchangeDeliveryQueue {
		const queue = new ExchangeDeliveryQueue(
			client,
			session.sessionId,
			(acknowledgement) => {
				if (!isCurrentStartup(generation)) return;
				pi.appendEntry(DELIVERY_LEDGER_KEY, {
					kind: "acknowledged",
					...acknowledgement,
				} satisfies DeliveryLedgerEntry);
			},
			client,
		);
		for (const exchange of deliveryLedger(
			ctx.sessionManager.getBranch(),
			session.recovery,
		).replayableExchanges) {
			if (exchange.operationId === session.normalDeliveryOperationId)
				queue.enqueue(exchange);
			else queue.enqueueRecovery(exchange);
		}
		void queue.flush();
		return queue;
	}

	async function completeStartup(
		ctx: ExtensionContext,
		client: HonchoLifecycleClient,
		recovery: StartupRecovery,
		generation: number,
		normalDeliveryOperationId: string | undefined,
		isFork: boolean,
		forkSourceSessionFile: string | undefined,
		peerName: string,
	): Promise<void> {
		const repositorySessionId = await repositorySessionKey(ctx.cwd, peerName);
		if (!isCurrentStartup(generation)) return;
		const session = resolveStartupSession(
			ctx,
			repositorySessionId,
			recovery,
			normalDeliveryOperationId,
			isFork,
			forkSourceSessionFile,
		);
		pi.appendEntry(SESSION_MAPPING_KEY, { remoteSessionId: session.sessionId });
		statusDetails.sessionId = session.sessionId;
		remoteSessionId = session.sessionId;
		forkClient = client;
		toolClient = client;
		deliveryQueue = replayStartupDelivery(ctx, client, session, generation);
		if (!isCurrentStartup(generation)) return;
		refreshHonchoTools();
		const memory = await retrieveStartupMemory(client, session);
		if (isCurrentStartup(generation)) cachedMemory = memory;
	}

	// This coordinates independent non-blocking connection, replay, and recall work.
	// pi-lens-ignore: high-complexity, high-fan-out
	async function initialize(
		ctx: ExtensionContext,
		normalDeliveryOperationId?: string,
		isFork = false,
		forkSourceSessionFile?: string,
	): Promise<HonchoMemoryStatus> {
		const generation = ++memoryGeneration;
		controller?.stop();
		privacyDisabled = false;
		cachedMemory = undefined;
		deliveryQueue = undefined;
		forkClient = undefined;
		toolClient = undefined;
		remoteSessionId = undefined;
		resetBlocked = false;
		awaitingRemoteRecreation = false;

		const startup = await resolveStartupConfiguration(ctx);
		if (!isCurrentStartup(generation)) return staleStartupStatus();
		const memoryClient = createStartupClient(
			startup.configuration,
			createLifecycleClient,
		);
		const createClient = memoryClient
			? () => memoryClient
			: () => {
					throw new Error("Honcho is not configured");
				};
		const statusController = new HonchoStatusController(
			startup.configuration,
			createClient,
			(status) => {
				if (!isCurrentStartup(generation)) return;
				showStatus(ctx, status, startup.workspace.workspaceId);
				refreshHonchoTools();
			},
		);
		controller = statusController;
		statusController.start();
		statusDetails = startupStatusDetails(startup);
		statusDetails.state = describeStatus(statusController.current);
		if (!memoryClient || startup.configuration.kind !== "configured")
			return statusController.current;

		const recovery = await persistedResetRecovery(
			startup.configuration.config.workspaceId,
		);
		if (!isCurrentStartup(generation)) return staleStartupStatus();
		resetBlocked = recovery.blocked;
		awaitingRemoteRecreation =
			Boolean(recovery.completedAt) && !normalDeliveryOperationId;
		if (resetBlocked || awaitingRemoteRecreation) {
			const repositorySessionId = await repositorySessionKey(
				ctx.cwd,
				startup.configuration.config.peerName,
			);
			if (!isCurrentStartup(generation)) return staleStartupStatus();
			remoteSessionId = repositorySessionId;
			toolClient = memoryClient;
			refreshHonchoTools();
			return statusController.current;
		}

		void completeStartup(
			ctx,
			memoryClient,
			recovery,
			generation,
			normalDeliveryOperationId,
			isFork,
			forkSourceSessionFile,
			startup.configuration.config.peerName,
		).catch(() => {
			if (!isCurrentStartup(generation)) return;
			showStatus(
				ctx,
				{
					kind: "retrying",
					reason: "Unable to refresh memory",
				},
				startup.workspace.workspaceId,
			);
		});
		return statusController.current;
	}

	pi.on("session_start", async (event, ctx) => {
		setHonchoTools(false);
		await initialize(
			ctx,
			undefined,
			event.reason === "fork",
			event.previousSessionFile,
		);
	});

	async function flushDelivery(): Promise<void> {
		await deliveryQueue?.flushWithin(FLUSH_TIMEOUT_MS);
	}

	pi.on("before_agent_start", (event, ctx) => {
		submittedPrompt = event.prompt;
		entryIdsBeforeRun = new Set(
			ctx.sessionManager.getEntries().map((entry) => entry.id),
		);
	});

	pi.on("agent_settled", (_event, ctx) => {
		const prompt = submittedPrompt;
		submittedPrompt = undefined;
		if (!prompt) return;
		const assistant = latestCompletedAssistant(
			ctx.sessionManager.getBranch(),
			entryIdsBeforeRun,
		);
		if (!assistant) return;
		const exchange = safeExchange({
			operationId: `pi-${assistant.entryId}`,
			userText: prompt,
			assistantText: assistant.text,
		});
		if (!exchange) {
			if (ctx.hasUI)
				ctx.ui.notify("Honcho did not sync a private exchange.", "warning");
			return;
		}
		if (resetBlocked || privacyDisabled) return;
		pi.appendEntry(DELIVERY_LEDGER_KEY, {
			kind: "pending",
			exchange,
		} satisfies DeliveryLedgerEntry);
		if (awaitingRemoteRecreation) {
			awaitingRemoteRecreation = false;
			void initialize(ctx, exchange.operationId);
			return;
		}
		if (deliveryQueue?.enqueue(exchange)) void deliveryQueue.flush();
	});

	pi.on("context", (event, ctx) => {
		if (privacyDisabled) return;
		const memory = cachedMemory
			? formatMemoryContext(
					cachedMemory,
					contextBudget(ctx.getContextUsage()?.percent),
				)
			: undefined;
		if (!memory) return;
		return {
			messages: [
				...event.messages,
				{
					role: "custom",
					customType: "honcho-memory",
					content: memory,
					display: false,
					timestamp: Date.now(),
				},
			],
		};
	});

	pi.on("session_before_compact", () => flushDelivery());
	pi.on("session_before_switch", () => flushDelivery());
	pi.on("session_before_fork", async (event, ctx) => {
		await flushDelivery();
		const targetEntryId =
			event.position === "at"
				? event.entryId
				: ctx.sessionManager.getEntry(event.entryId)?.parentId;
		if (!targetEntryId) return;
		const remoteMessageId = latestRemoteMessageAtFork(
			ctx.sessionManager.getBranch(),
			forkLedger(ctx.sessionManager.getEntries()),
			event.entryId,
			event.position,
		);
		let clonedSessionId: string | undefined;
		if (forkClient && remoteSessionId && remoteMessageId) {
			try {
				clonedSessionId = await forkClient.cloneSession(
					remoteSessionId,
					remoteMessageId,
				);
			} catch {
				// The local Pi fork continues with an isolated remote child session.
			}
		}
		inMemoryForkHandoffs.record(targetEntryId, clonedSessionId);
		pi.appendEntry(FORK_LEDGER_KEY, {
			kind: "fork",
			targetEntryId,
			remoteSessionId: clonedSessionId,
		} satisfies ForkLedgerEntry);
	});

	pi.on("session_shutdown", async () => {
		await flushDelivery();
		controller?.stop();
	});

	const honchoToolNames = ["honcho_search", "honcho_chat", "honcho_remember"];
	function disableCurrentProjectMemory(): void {
		disableProjectMemoryNow({
			clearRecall: () => {
				privacyDisabled = true;
				memoryGeneration += 1;
				cachedMemory = undefined;
			},
			discardPendingDelivery: () => {
				deliveryQueue?.discardPending();
				deliveryQueue = undefined;
			},
			clearRemoteClients: () => {
				forkClient = undefined;
				toolClient = undefined;
				remoteSessionId = undefined;
			},
			stopConnection: () => controller?.stop(),
			hideTools: () => setHonchoTools(false),
		});
	}

	function refreshHonchoTools(): void {
		setHonchoTools(
			controller?.current.kind === "connected" &&
				Boolean(remoteSessionId) &&
				!resetBlocked &&
				!awaitingRemoteRecreation &&
				!privacyDisabled,
		);
	}

	function setHonchoTools(enabled: boolean): void {
		const active = pi
			.getActiveTools()
			.filter((name) => !honchoToolNames.includes(name));
		pi.setActiveTools(enabled ? [...active, ...honchoToolNames] : active);
	}

	function availableToolClient():
		| { client: HonchoToolClient; sessionId: string }
		| undefined {
		return toolClient && remoteSessionId
			? { client: toolClient, sessionId: remoteSessionId }
			: undefined;
	}

	pi.registerTool({
		name: "honcho_search",
		label: "Honcho Search",
		description: "Search bounded remote project memory when it is connected.",
		parameters: Type.Object({ query: Type.String({ minLength: 1 }) }),
		async execute(_id, { query }) {
			const available = availableToolClient();
			if (!available) throw new Error("Honcho memory is unavailable");
			const results = await available.client.search(available.sessionId, query);
			return {
				content: [{ type: "text", text: results.join("\n").slice(0, 8_000) }],
				details: {},
			};
		},
	});
	pi.registerTool({
		name: "honcho_chat",
		label: "Honcho Chat",
		description: "Ask a bounded question about connected remote memory.",
		parameters: Type.Object({ query: Type.String({ minLength: 1 }) }),
		async execute(_id, { query }) {
			const available = availableToolClient();
			if (!available) throw new Error("Honcho memory is unavailable");
			const response = await available.client.chat(available.sessionId, query);
			return {
				content: [
					{
						type: "text",
						text: (response ?? "No relevant memory.").slice(0, 8_000),
					},
				],
				details: {},
			};
		},
	});
	pi.registerTool({
		name: "honcho_remember",
		label: "Honcho Remember",
		description:
			"Save a durable preference or correction only when the user explicitly requested it.",
		parameters: Type.Object({ content: Type.String({ minLength: 1 }) }),
		async execute(_id, { content }) {
			const available = availableToolClient();
			if (!available) throw new Error("Honcho memory is unavailable");
			const conclusionId = await available.client.remember(
				available.sessionId,
				content,
			);
			return {
				content: [
					{ type: "text", text: `Saved remote conclusion ${conclusionId}.` },
				],
				details: {},
			};
		},
	});

	async function setupCommand(
		_args: string,
		ctx: ExtensionContext,
	): Promise<void> {
		if (!ctx.hasUI) return;
		const workspaceId = await ctx.ui.input(
			"Honcho workspace",
			statusDetails.workspaceId ?? "pi",
		);
		if (!isValidHonchoWorkspaceId(workspaceId)) {
			ctx.ui.notify(
				"Workspace IDs must use only letters, digits, underscores, or hyphens.",
				"warning",
			);
			return;
		}
		const peerName = await ctx.ui.input(
			"Stable user peer",
			statusDetails.userPeer ?? "user",
		);
		const aiPeer = await ctx.ui.input("Pi peer", statusDetails.aiPeer ?? "pi");
		if (!workspaceId || !peerName || !aiPeer) return;
		const saved = await saveHonchoSettings({ workspaceId, peerName, aiPeer });
		ctx.ui.notify(
			saved
				? "Saved non-secret Honcho settings. Reload Pi to apply them."
				: "Could not save Honcho settings.",
			saved ? "info" : "error",
		);
	}

	pi.registerCommand("honcho-setup", {
		description: "Configure non-secret Honcho workspace and peer identities.",
		handler: setupCommand,
	});

	async function projectPolicyCommand(
		args: string,
		ctx: ExtensionContext,
	): Promise<void> {
		if (!ctx.hasUI) return;
		const commandContext: ProjectPolicyCommandContext = {
			cwd: ctx.cwd,
			isProjectTrusted: () => ctx.isProjectTrusted(),
			confirm: (title, details) => ctx.ui.confirm(title, details),
			input: (label, initial) => ctx.ui.input(label, initial),
			notify: (message, level) => ctx.ui.notify(message, level),
		};
		const store: ProjectPolicyStore = {
			path: projectPolicyPath(ctx.cwd),
			read: () => readProjectHonchoPolicyFile(ctx.cwd),
			write: (policy) => saveProjectHonchoPolicy(ctx.cwd, policy),
		};
		if (args.trim() === "disable") {
			await disableProjectPolicy(
				commandContext,
				store,
				disableCurrentProjectMemory,
			);
			return;
		}
		if (args.trim()) {
			ctx.ui.notify(
				"Use /honcho-project-policy or /honcho-project-policy disable.",
				"warning",
			);
			return;
		}
		await setupProjectPolicy(commandContext, store);
	}

	pi.registerCommand("honcho-project-policy", {
		description:
			"Create or replace this trusted folder's policy; add disable to opt out immediately.",
		handler: projectPolicyCommand,
	});

	async function forgetCommand(
		args: string,
		ctx: ExtensionContext,
	): Promise<void> {
		const target = deletionTarget(args);
		const available = availableToolClient();
		if (!target || !available || !ctx.hasUI) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					"Use /honcho-forget session or /honcho-forget conclusion <id> while connected.",
					"warning",
				);
			}
			return;
		}
		const identity = `Workspace: ${statusDetails.workspaceId}\nUser peer: ${statusDetails.userPeer}\nSession: ${available.sessionId}`;
		const label =
			target.kind === "session" ? "remote session" : `conclusion ${target.id}`;
		if (
			!(await ctx.ui.confirm(
				"Delete remote memory?",
				`${identity}\n\nDelete ${label}? This cannot be undone.`,
			))
		)
			return;
		try {
			if (target.kind === "session")
				await available.client.deleteSession(available.sessionId);
			else
				await available.client.deleteConclusion(available.sessionId, target.id);
			ctx.ui.notify(
				`Deleted ${label}. Local Pi and Hermes memory were unchanged.`,
				"info",
			);
		} catch {
			ctx.ui.notify(
				"Could not delete remote memory. It may not exist or Honcho may be rate-limited; local Pi and Hermes memory were unchanged.",
				"error",
			);
		}
	}

	pi.registerCommand("honcho-forget", {
		description: "Inspect and confirm deletion: session or conclusion <id>.",
		handler: forgetCommand,
	});

	// pi-lens-ignore: high-complexity
	function markResetUncertain(
		ctx: ExtensionContext,
		workspaceId: string,
	): void {
		try {
			pi.appendEntry(WORKSPACE_RESET_ENTRY_KEY, {
				kind: "uncertain",
				workspaceId,
			});
		} catch {
			// The in-memory block below remains the safe fallback.
			resetBlocked = true;
		}
		resetBlocked = true;
		setHonchoTools(false);
		ctx.ui.notify(
			"Reset outcome unknown; remote tools and writes are blocked until re-inspection resolves it.",
			"error",
		);
	}

	async function resetWorkspace(
		args: string,
		ctx: ExtensionContext,
	): Promise<void> {
		if (!ctx.hasUI || args.trim()) return;
		const available = availableToolClient();
		if (!available || awaitingRemoteRecreation) {
			ctx.ui.notify(
				"Honcho workspace reset is unavailable until remote memory is connected and resolved.",
				"warning",
			);
			return;
		}
		let inspection: WorkspaceInspection;
		ctx.ui.setStatus(
			STATUS_KEY,
			`Honcho: inspecting workspace… · ${statusDetails.workspaceId}`,
		);
		try {
			inspection = await available.client.inspectWorkspace();
			ctx.ui.setStatus(
				STATUS_KEY,
				`Honcho: connected · ${inspection.workspaceId}`,
			);
		} catch {
			ctx.ui.notify(
				"Workspace inspection was incomplete; no remote data was deleted.",
				"error",
			);
			return;
		}
		const confirmation = resetConfirmation(inspection.workspaceId);
		const details = `Workspace: ${inspection.workspaceId}\nPeers: ${inspection.peerIds.join(", ") || "none"}\nSessions: ${inspection.sessionCount}\nConclusions: ${inspection.conclusionCount}\n\nWARNING: shared-workspace data from other applications will also be deleted.`;
		if (!(await ctx.ui.confirm("Delete inspected remote workspace?", details)))
			return;
		const typed = await ctx.ui.input(
			`Type exactly: ${confirmation}`,
			confirmation,
		);
		if (typed !== confirmation) return;
		try {
			pi.appendEntry(WORKSPACE_RESET_ENTRY_KEY, {
				kind: "intent",
				workspaceId: inspection.workspaceId,
			});
		} catch {
			ctx.ui.notify(
				"Could not record reset intent; no remote data was deleted.",
				"error",
			);
			return;
		}
		try {
			await available.client.deleteWorkspace(inspection.workspaceId);
		} catch (error) {
			if (!deletionOutcomeIsUncertain(error)) {
				pi.appendEntry(WORKSPACE_RESET_ENTRY_KEY, {
					kind: "failed",
					workspaceId: inspection.workspaceId,
				});
				ctx.ui.notify(
					`Workspace reset failed: ${error instanceof Error ? error.message : "remote deletion was rejected"}`,
					"error",
				);
				return;
			}
			markResetUncertain(ctx, inspection.workspaceId);
			return;
		}
		try {
			pi.appendEntry(WORKSPACE_RESET_ENTRY_KEY, {
				kind: "complete",
				workspaceId: inspection.workspaceId,
			});
			resetBlocked = false;
			awaitingRemoteRecreation = true;
			deliveryQueue = undefined;
			toolClient = undefined;
			remoteSessionId = undefined;
			setHonchoTools(false);
			ctx.ui.notify(
				"Workspace reset — remote memory will be recreated on next eligible exchange.",
				"info",
			);
		} catch {
			markResetUncertain(ctx, inspection.workspaceId);
		}
	}

	pi.registerCommand("honcho-reset-workspace", {
		description:
			"Inspect and typed-confirm reset of the configured remote workspace.",
		handler: resetWorkspace,
	});

	async function statusCommand(
		_args: string,
		ctx: ExtensionContext,
	): Promise<void> {
		const status = controller?.current ?? (await initialize(ctx));
		if (ctx.hasUI) {
			statusDetails.state = describeStatus(status);
			ctx.ui.notify(formatStatusDetails(statusDetails), "info");
		}
	}

	pi.registerCommand("honcho-status", {
		description: "Show Pi Honcho connection status.",
		handler: statusCommand,
	});

	pi.registerCommand("honcho", {
		description: "Manage Honcho memory; use /honcho help for commands.",
		getArgumentCompletions: commandArgumentCompletions,
		handler: async (args, ctx) =>
			dispatchHonchoCommand(args, {
				help: async () => {
					const status = controller?.current ?? (await initialize(ctx));
					if (!ctx.hasUI) return;
					statusDetails.state = describeStatus(status);
					ctx.ui.notify(
						formatHonchoCommandHelp(formatStatusDetails(statusDetails)),
						"info",
					);
				},
				status: () => statusCommand("", ctx),
				setup: () => setupCommand("", ctx),
				projectSetup: () => projectPolicyCommand("", ctx),
				projectDisable: () => projectPolicyCommand("disable", ctx),
				forget: (forgetArgs) => forgetCommand(forgetArgs, ctx),
				workspaceReset: () => resetWorkspace("", ctx),
				invalid: () => {
					if (ctx.hasUI) {
						ctx.ui.notify(
							"Use /honcho help to see available commands.",
							"warning",
						);
					}
				},
			}),
	});
}
