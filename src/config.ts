export const DEFAULT_TIMEOUT_MS = 3_000;
export const DEFAULT_WORKSPACE_ID = "pi";
export const DEFAULT_PEER_NAME = "user";
export const DEFAULT_AI_PEER = "pi";
export const DEFAULT_MAX_MESSAGE_LENGTH = 8_000;

export interface HonchoConnectionConfig {
	apiKey: string;
	baseUrl?: string;
	workspaceId: string;
	workspaceSource:
		| "environment"
		| "project policy"
		| "Honcho config"
		| "default";
	peerName: string;
	aiPeer: string;
	timeoutMs: number;
	maxMessageLength: number;
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
}

export const HONCHO_HOST_NAME = "pi-honcho";
/** Pre-rename host key; read only as a fallback so existing credentials remain usable. */
const LEGACY_HONCHO_HOST_NAME = "pi-honcho-memory";

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

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
			nonEmptyString(primary.workspaceId) ?? nonEmptyString(legacy.workspaceId),
		peerName:
			nonEmptyString(primary.peerName) ?? nonEmptyString(legacy.peerName),
		aiPeer: nonEmptyString(primary.aiPeer) ?? nonEmptyString(legacy.aiPeer),
	};
}

function resolvedWorkspace(
	env: Environment,
	host: HostSettings | undefined,
	cli: HostSettings | undefined,
	projectWorkspaceId: string | undefined,
): Pick<HonchoConnectionConfig, "workspaceId" | "workspaceSource"> {
	const environment = nonEmptyString(env.HONCHO_WORKSPACE_ID);
	if (environment)
		return { workspaceId: environment, workspaceSource: "environment" };
	if (projectWorkspaceId)
		return {
			workspaceId: projectWorkspaceId,
			workspaceSource: "project policy",
		};
	const configured =
		nonEmptyString(host?.workspaceId) ?? nonEmptyString(cli?.workspaceId);
	if (configured)
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

export type DeletionTarget =
	| { kind: "session" }
	| { kind: "conclusion"; id: string };

export function deletionTarget(input: string): DeletionTarget | undefined {
	if (input.trim() === "session") return { kind: "session" };
	const match = input.trim().match(/^conclusion\s+(\S+)$/);
	return match ? { kind: "conclusion", id: match[1] } : undefined;
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
	const apiKey = preferredValue(env.HONCHO_API_KEY, host?.apiKey, cli?.apiKey);
	if (!apiKey) {
		return { kind: "unconfigured", reason: "No Honcho API key is configured" };
	}

	return {
		kind: "configured",
		config: {
			apiKey,
			baseUrl: preferredValue(
				env.HONCHO_BASE_URL,
				host?.environmentUrl,
				cli?.environmentUrl,
			),
			...resolvedWorkspace(env, host, cli, projectWorkspaceId),
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
			timeoutMs: DEFAULT_TIMEOUT_MS,
			maxMessageLength: positiveInteger(
				env.HONCHO_MAX_MESSAGE_LENGTH,
				DEFAULT_MAX_MESSAGE_LENGTH,
			),
		},
	};
}
