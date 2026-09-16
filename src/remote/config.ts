import { oauthTokensForHost, validOAuthAccessToken } from "./oauth.js";

/** Bounds a single blocking Honcho request, including live honcho_chat context queries. */
export const DEFAULT_TIMEOUT_MS = 20_000;
export const DEFAULT_WORKSPACE_ID = "pi";
export const DEFAULT_PEER_NAME = "user";
export const DEFAULT_AI_PEER = "pi";
export const DEFAULT_MAX_MESSAGE_LENGTH = 8_000;
export const DEFAULT_HONCHO_BASE_URL = "https://api.honcho.dev";
/** Turns between automatic memory-context injections; 1 injects on every turn. */
export const DEFAULT_CONTEXT_CADENCE_TURNS = 1;

export const HONCHO_REASONING_LEVELS = [
	"minimal",
	"low",
	"medium",
	"high",
	"max",
] as const;
export type HonchoReasoningLevel = (typeof HONCHO_REASONING_LEVELS)[number];
/** Fastest dialectic tier; used for blocking, latency-sensitive honcho_chat queries. */
export const DEFAULT_HONCHO_REASONING_LEVEL: HonchoReasoningLevel = "minimal";

export interface HonchoConnectionConfig {
	apiKey: string;
	baseUrl?: string;
	workspaceId: string;
	workspaceSource:
		| "environment"
		| "project policy"
		| "registry"
		| "Honcho config"
		| "default";
	peerName: string;
	aiPeer: string;
	timeoutMs: number;
	maxMessageLength: number;
	contextCadenceTurns: number;
	reasoningLevel: HonchoReasoningLevel;
}

export type HonchoConfiguration =
	| { kind: "configured"; config: HonchoConnectionConfig }
	| { kind: "disabled"; reason: string }
	| { kind: "unconfigured"; reason: string };

type Environment = Record<string, string | undefined>;

interface HostSettings {
	apiKey?: unknown;
	environmentUrl?: unknown;
	workspaceId?: unknown;
	peerName?: unknown;
	aiPeer?: unknown;
	contextCadence?: unknown;
	reasoningLevel?: unknown;
	timeoutMs?: unknown;
}

export const HONCHO_HOST_NAME = "pi-honcho";
/** Pre-rename host key; read only as a fallback so existing credentials remain usable. */
const LEGACY_HONCHO_HOST_NAME = "pi-honcho-memory";

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function workspaceString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function numericString(value: unknown): string | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return nonEmptyString(value);
}

export const isValidHonchoWorkspaceId = (value: unknown): value is string =>
	typeof value === "string" && /^[a-zA-Z0-9_-]+$/.test(value);

export const isValidContextCadenceTurns = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export const isValidReasoningLevel = (
	value: unknown,
): value is HonchoReasoningLevel =>
	typeof value === "string" &&
	(HONCHO_REASONING_LEVELS as readonly string[]).includes(value);

export const isValidTimeoutMs = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value > 0;

function positiveInteger(value: string | undefined, fallback: number): number {
	const parsed = Number.parseInt(value ?? "", 10);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function explicitlyDisabled(value: string | undefined): boolean {
	return value?.trim().toLowerCase() === "false" || value?.trim() === "0";
}

function settings(value: unknown): HostSettings | undefined {
	return value !== null && typeof value === "object"
		? (value as HostSettings)
		: undefined;
}

function hostSettings(configFile: unknown): HostSettings | undefined {
	if (configFile === null || typeof configFile !== "object") return undefined;
	const hosts = (configFile as { hosts?: unknown }).hosts;
	if (hosts === null || typeof hosts !== "object") return undefined;
	const record = hosts as Record<string, unknown>;
	const primary = settings(record[HONCHO_HOST_NAME]);
	const legacy = settings(record[LEGACY_HONCHO_HOST_NAME]);
	if (!primary) return legacy;
	if (!legacy) return primary;
	return {
		apiKey: nonEmptyString(primary.apiKey) ?? nonEmptyString(legacy.apiKey),
		environmentUrl:
			nonEmptyString(primary.environmentUrl) ??
			nonEmptyString(legacy.environmentUrl),
		workspaceId:
			workspaceString(primary.workspaceId) ??
			workspaceString(legacy.workspaceId),
		peerName:
			nonEmptyString(primary.peerName) ?? nonEmptyString(legacy.peerName),
		aiPeer: nonEmptyString(primary.aiPeer) ?? nonEmptyString(legacy.aiPeer),
		contextCadence:
			numericString(primary.contextCadence) ??
			numericString(legacy.contextCadence),
		reasoningLevel: isValidReasoningLevel(primary.reasoningLevel)
			? primary.reasoningLevel
			: isValidReasoningLevel(legacy.reasoningLevel)
				? legacy.reasoningLevel
				: undefined,
		timeoutMs:
			numericString(primary.timeoutMs) ?? numericString(legacy.timeoutMs),
	};
}

function resolvedWorkspace(
	env: Environment,
	host: HostSettings | undefined,
	cli: HostSettings | undefined,
	projectWorkspaceId: string | undefined,
): Pick<HonchoConnectionConfig, "workspaceId" | "workspaceSource"> {
	const environment = workspaceString(env.HONCHO_WORKSPACE_ID);
	if (environment !== undefined)
		return { workspaceId: environment, workspaceSource: "environment" };
	if (projectWorkspaceId !== undefined)
		return {
			workspaceId: projectWorkspaceId,
			workspaceSource: "project policy",
		};
	const configured =
		workspaceString(host?.workspaceId) ?? workspaceString(cli?.workspaceId);
	if (configured !== undefined)
		return { workspaceId: configured, workspaceSource: "Honcho config" };
	return { workspaceId: DEFAULT_WORKSPACE_ID, workspaceSource: "default" };
}

export function resolveHonchoWorkspace(
	env: Environment,
	configFile: unknown,
	projectWorkspaceId?: string,
): Pick<HonchoConnectionConfig, "workspaceId" | "workspaceSource"> {
	return resolvedWorkspace(
		env,
		hostSettings(configFile),
		settings(configFile),
		projectWorkspaceId,
	);
}

function invalidWorkspaceReason(
	workspaceSource: HonchoConnectionConfig["workspaceSource"],
): string {
	switch (workspaceSource) {
		case "environment":
			return "Invalid workspace ID from environment. Set HONCHO_WORKSPACE_ID to use only letters, digits, underscores, or hyphens.";
		case "project policy":
			return "Invalid workspace ID from project policy. Correct the trusted project policy workspace to use only letters, digits, underscores, or hyphens.";
		case "registry":
			return "Invalid workspace ID from the local registry.";
		case "Honcho config":
			return "Invalid workspace ID from Honcho config. Set workspaceId to use only letters, digits, underscores, or hyphens.";
		case "default":
			return "Invalid default workspace ID.";
	}
}

function preferredValue(
	envValue: unknown,
	hostValue: unknown,
	cliValue: unknown,
	fallback: string,
): string;
function preferredValue(
	envValue: unknown,
	hostValue: unknown,
	cliValue: unknown,
	fallback?: string,
): string | undefined;
function preferredValue(
	envValue: unknown,
	hostValue: unknown,
	cliValue: unknown,
	fallback?: string,
): string | undefined {
	return (
		nonEmptyString(envValue) ??
		nonEmptyString(hostValue) ??
		nonEmptyString(cliValue) ??
		fallback
	);
}

export function resolveHonchoBaseUrl(
	env: Environment,
	configFile: unknown,
): string {
	const host = hostSettings(configFile);
	const cli = settings(configFile);
	return preferredValue(
		env.HONCHO_BASE_URL,
		host?.environmentUrl,
		cli?.environmentUrl,
		DEFAULT_HONCHO_BASE_URL,
	);
}

export function resolveHonchoConfig(
	env: Environment,
	configFile: unknown,
	projectWorkspaceId?: string,
): HonchoConfiguration {
	if (explicitlyDisabled(env.HONCHO_ENABLED)) {
		return { kind: "disabled", reason: "HONCHO_ENABLED is disabled" };
	}

	const host = hostSettings(configFile);
	const cli = settings(configFile);
	const baseUrl = resolveHonchoBaseUrl(env, configFile);
	const configuredApiKey = preferredValue(
		env.HONCHO_API_KEY,
		host?.apiKey,
		cli?.apiKey,
	);
	const oauth = oauthTokensForHost(configFile, baseUrl);
	const apiKey =
		nonEmptyString(env.HONCHO_API_KEY) ??
		validOAuthAccessToken(configFile, baseUrl) ??
		configuredApiKey;
	if (!apiKey) {
		return {
			kind: "unconfigured",
			reason: oauth
				? "Honcho OAuth session expired. Run /honcho login."
				: "No Honcho API key is configured. Run /honcho login or set HONCHO_API_KEY.",
		};
	}

	const workspace = resolvedWorkspace(env, host, cli, projectWorkspaceId);
	if (!isValidHonchoWorkspaceId(workspace.workspaceId)) {
		return {
			kind: "unconfigured",
			reason: invalidWorkspaceReason(workspace.workspaceSource),
		};
	}

	return {
		kind: "configured",
		config: {
			apiKey,
			baseUrl,
			...workspace,
			peerName: preferredValue(
				env.HONCHO_PEER_NAME,
				host?.peerName,
				cli?.peerName,
				DEFAULT_PEER_NAME,
			),
			aiPeer: preferredValue(
				env.HONCHO_AI_PEER,
				host?.aiPeer,
				cli?.aiPeer,
				DEFAULT_AI_PEER,
			),
			timeoutMs: positiveInteger(
				nonEmptyString(env.HONCHO_TIMEOUT_MS) ??
					numericString(host?.timeoutMs) ??
					numericString(cli?.timeoutMs),
				DEFAULT_TIMEOUT_MS,
			),
			maxMessageLength: positiveInteger(
				env.HONCHO_MAX_MESSAGE_LENGTH,
				DEFAULT_MAX_MESSAGE_LENGTH,
			),
			contextCadenceTurns: positiveInteger(
				nonEmptyString(env.HONCHO_CONTEXT_CADENCE) ??
					numericString(host?.contextCadence) ??
					numericString(cli?.contextCadence),
				DEFAULT_CONTEXT_CADENCE_TURNS,
			),
			reasoningLevel: isValidReasoningLevel(env.HONCHO_REASONING_LEVEL)
				? env.HONCHO_REASONING_LEVEL
				: isValidReasoningLevel(host?.reasoningLevel)
					? host.reasoningLevel
					: isValidReasoningLevel(cli?.reasoningLevel)
						? cli.reasoningLevel
						: DEFAULT_HONCHO_REASONING_LEVEL,
		},
	};
}
