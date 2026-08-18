const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const DEFAULT_SCOPE = "write";
const REFRESH_SKEW_MS = 60_000;
const REQUEST_TIMEOUT_MS = 5_000;

export const HONCHO_OAUTH_CLIENT_ID = "honcho-cli";

export interface OAuthTokens {
	accessToken: string;
	refreshToken: string;
	accessExpiresAt: number;
	clientId: string;
	scope: string;
	host: string;
}

export interface DeviceAuthorization {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	verificationUriComplete?: string;
	expiresIn: number;
	interval: number;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
type Sleep = (milliseconds: number) => Promise<void>;

export type DeviceAuthorizationStart =
	| { kind: "ready"; device: DeviceAuthorization }
	| { kind: "unsupported" }
	| { kind: "failed" };

export type DeviceAuthorizationPoll =
	| { kind: "success"; tokens: OAuthTokens }
	| { kind: "denied" }
	| { kind: "expired" }
	| { kind: "failed" };

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0
		? value
		: undefined;
}

function hostUrl(value: string): URL | undefined {
	try {
		const url = new URL(value);
		const localHttp =
			url.protocol === "http:" &&
			["localhost", "127.0.0.1", "::1"].includes(url.hostname);
		if (
			(url.protocol !== "https:" && !localHttp) ||
			url.username ||
			url.password ||
			url.hash
		)
			return undefined;
		return url;
	} catch {
		return undefined;
	}
}

function normalizedHost(value: string): string | undefined {
	const url = hostUrl(value);
	return url ? url.origin : undefined;
}

function sameHost(left: string, right: string): boolean {
	return normalizedHost(left) === normalizedHost(right);
}

function endpoint(baseUrl: string, path: string): string | undefined {
	const host = normalizedHost(baseUrl);
	return host ? new URL(path, host).toString() : undefined;
}

async function jsonObject(
	response: Response,
): Promise<Record<string, unknown> | undefined> {
	try {
		const value: unknown = await response.json();
		return value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function deviceFrom(
	value: Record<string, unknown>,
): DeviceAuthorization | undefined {
	const deviceCode = nonEmptyString(value.device_code);
	const userCode = nonEmptyString(value.user_code);
	const verificationUri = nonEmptyString(value.verification_uri);
	const expiresIn = positiveInteger(value.expires_in);
	const interval = positiveInteger(value.interval);
	if (!deviceCode || !userCode || !verificationUri || !expiresIn || !interval)
		return undefined;
	const verifiedUri = hostUrl(verificationUri);
	if (verifiedUri?.protocol !== "https:") return undefined;
	const verificationUriComplete = nonEmptyString(
		value.verification_uri_complete,
	);
	const completeUri = verificationUriComplete
		? hostUrl(verificationUriComplete)
		: undefined;
	if (verificationUriComplete && completeUri?.protocol !== "https:")
		return undefined;
	return {
		deviceCode,
		userCode,
		verificationUri: verifiedUri.toString(),
		verificationUriComplete: completeUri?.toString(),
		expiresIn,
		interval,
	};
}

function tokensFrom(
	value: Record<string, unknown>,
	previous: Pick<OAuthTokens, "refreshToken" | "clientId" | "scope" | "host">,
	now: number,
): OAuthTokens | undefined {
	const accessToken = nonEmptyString(value.access_token);
	const expiresIn = positiveInteger(value.expires_in);
	if (!accessToken || !expiresIn) return undefined;
	return {
		accessToken,
		refreshToken: nonEmptyString(value.refresh_token) ?? previous.refreshToken,
		accessExpiresAt: now + expiresIn * 1_000,
		clientId: previous.clientId,
		scope: nonEmptyString(value.scope) ?? previous.scope,
		host: previous.host,
	};
}

function requestOptions(parameters: URLSearchParams): RequestInit {
	return {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: parameters,
	};
}

function request(
	fetch: Fetch,
	url: string,
	init?: RequestInit,
): Promise<Response> {
	return fetch(url, {
		...init,
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
}

export function oauthTokensForHost(
	configFile: unknown,
	baseUrl: string | undefined,
): OAuthTokens | undefined {
	if (!baseUrl || !configFile || typeof configFile !== "object")
		return undefined;
	const oauth = (configFile as { oauth?: unknown }).oauth;
	if (!oauth || typeof oauth !== "object") return undefined;
	const record = oauth as Record<string, unknown>;
	const accessToken = nonEmptyString(record.accessToken);
	const refreshToken = nonEmptyString(record.refreshToken) ?? "";
	const accessExpiresAt =
		typeof record.accessExpiresAt === "number" &&
		Number.isFinite(record.accessExpiresAt)
			? record.accessExpiresAt
			: 0;
	const clientId = nonEmptyString(record.clientId);
	const scope = nonEmptyString(record.scope) ?? DEFAULT_SCOPE;
	const host = nonEmptyString(record.host);
	if (!accessToken || !clientId || !host || !sameHost(host, baseUrl))
		return undefined;
	return { accessToken, refreshToken, accessExpiresAt, clientId, scope, host };
}

export function validOAuthAccessToken(
	configFile: unknown,
	baseUrl: string | undefined,
	now = Date.now(),
): string | undefined {
	const oauth = oauthTokensForHost(configFile, baseUrl);
	return oauth && oauth.accessExpiresAt > now + REFRESH_SKEW_MS
		? oauth.accessToken
		: undefined;
}

export async function beginDeviceAuthorization(
	baseUrl: string,
	fetch: Fetch = globalThis.fetch,
): Promise<DeviceAuthorizationStart> {
	const metadataUrl = endpoint(
		baseUrl,
		"/.well-known/oauth-authorization-server",
	);
	const deviceUrl = endpoint(baseUrl, "/oauth/device_authorization");
	if (!metadataUrl || !deviceUrl) return { kind: "unsupported" };
	try {
		// pi-lens-ignore: ssrf — URL derives from the validated configured Honcho host.
		const metadataResponse = await request(fetch, metadataUrl);
		if (
			!metadataResponse.ok ||
			(metadataResponse.url && !sameHost(metadataResponse.url, baseUrl))
		)
			return { kind: "unsupported" };
		const metadata = await jsonObject(metadataResponse);
		const grants = metadata?.grant_types_supported;
		if (!Array.isArray(grants) || !grants.includes(DEVICE_GRANT_TYPE))
			return { kind: "unsupported" };
		const response = await request(
			fetch,
			deviceUrl,
			requestOptions(
				new URLSearchParams({
					client_id: HONCHO_OAUTH_CLIENT_ID,
					scope: DEFAULT_SCOPE,
					source: HONCHO_OAUTH_CLIENT_ID,
				}),
			),
		);
		if (!response.ok) return { kind: "failed" };
		const device = await jsonObject(response);
		const parsed = device && deviceFrom(device);
		return parsed ? { kind: "ready", device: parsed } : { kind: "failed" };
	} catch {
		return { kind: "failed" };
	}
}

function defaultSleep(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function pollDeviceAuthorization(
	baseUrl: string,
	device: DeviceAuthorization,
	options: {
		fetch?: Fetch;
		sleep?: Sleep;
		now?: () => number;
	} = {},
): Promise<DeviceAuthorizationPoll> {
	const tokenUrl = endpoint(baseUrl, "/oauth/token");
	if (!tokenUrl) return { kind: "failed" };
	const fetch = options.fetch ?? globalThis.fetch;
	const sleep = options.sleep ?? defaultSleep;
	const now = options.now ?? Date.now;
	let interval = device.interval * 1_000;
	const deadline = now() + device.expiresIn * 1_000;
	const previous = {
		refreshToken: "",
		clientId: HONCHO_OAUTH_CLIENT_ID,
		scope: DEFAULT_SCOPE,
		host: normalizedHost(baseUrl) ?? baseUrl,
	};
	while (now() < deadline) {
		await sleep(interval);
		if (now() >= deadline) break;
		try {
			// pi-lens-ignore: ssrf — URL derives from the validated configured Honcho host.
			const response = await request(
				fetch,
				tokenUrl,
				requestOptions(
					new URLSearchParams({
						grant_type: DEVICE_GRANT_TYPE,
						device_code: device.deviceCode,
						client_id: HONCHO_OAUTH_CLIENT_ID,
					}),
				),
			);
			const body = await jsonObject(response);
			if (response.ok) {
				const tokens = body && tokensFrom(body, previous, now());
				return tokens ? { kind: "success", tokens } : { kind: "failed" };
			}
			switch (body?.error) {
				case "authorization_pending":
					continue;
				case "slow_down":
					interval += 5_000;
					continue;
				case "access_denied":
					return { kind: "denied" };
				case "expired_token":
					return { kind: "expired" };
				default:
					return { kind: "failed" };
			}
		} catch {
			return { kind: "failed" };
		}
	}
	return { kind: "expired" };
}

export async function refreshOAuthTokens(
	oauth: OAuthTokens,
	fetch: Fetch = globalThis.fetch,
	now = Date.now,
): Promise<OAuthTokens | undefined> {
	const tokenUrl = endpoint(oauth.host, "/oauth/token");
	if (!oauth.refreshToken || !tokenUrl) return undefined;
	try {
		// pi-lens-ignore: ssrf — URL derives from the validated, host-bound OAuth grant.
		const response = await request(
			fetch,
			tokenUrl,
			requestOptions(
				new URLSearchParams({
					grant_type: "refresh_token",
					refresh_token: oauth.refreshToken,
					client_id: oauth.clientId,
				}),
			),
		);
		if (!response.ok) return undefined;
		const body = await jsonObject(response);
		return body ? tokensFrom(body, oauth, now()) : undefined;
	} catch {
		return undefined;
	}
}
