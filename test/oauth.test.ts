import assert from "node:assert/strict"; // pi-lens-ignore: find-import-file-without-extension
import test from "node:test";

import {
	beginDeviceAuthorization,
	pollDeviceAuthorization,
	refreshOAuthTokens,
} from "../src/remote/oauth.js";

type MockResponse = {
	body: unknown;
	status?: number;
};

function mockFetch(...responses: MockResponse[]) {
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
		requests.push({ url, init });
		const response = responses.shift();
		if (!response) throw new Error("Unexpected request");
		return new Response(JSON.stringify(response.body), {
			status: response.status ?? 200,
		});
	};
	return { fetch, requests };
}

test("starts a device authorization only when the configured host advertises it", async () => {
	const { fetch, requests } = mockFetch(
		{
			body: {
				grant_types_supported: ["urn:ietf:params:oauth:grant-type:device_code"],
			},
		},
		{
			body: {
				device_code: "device-code",
				user_code: "user-code",
				verification_uri: "https://honcho.dev/activate",
				expires_in: 600,
				interval: 5,
			},
		},
	);

	const result = await beginDeviceAuthorization(
		"https://api.honcho.dev",
		fetch,
	);

	assert.deepEqual(result, {
		kind: "ready",
		device: {
			deviceCode: "device-code",
			userCode: "user-code",
			verificationUri: "https://honcho.dev/activate",
			verificationUriComplete: undefined,
			expiresIn: 600,
			interval: 5,
		},
	});
	assert.equal(
		requests[0]?.url,
		"https://api.honcho.dev/.well-known/oauth-authorization-server",
	);
	assert.equal(
		requests[1]?.url,
		"https://api.honcho.dev/oauth/device_authorization",
	);
	assert.equal(
		requests[1]?.init?.body?.toString(),
		"client_id=honcho-cli&scope=write&source=honcho-cli",
	);
});

test("fails closed when device authorization is unsupported", async () => {
	const { fetch } = mockFetch({ body: { grant_types_supported: [] } });

	assert.deepEqual(
		await beginDeviceAuthorization("https://api.honcho.dev", fetch),
		{ kind: "unsupported" },
	);
});

test("polls after the server interval, slows down, and returns host-bound tokens", async () => {
	const { fetch } = mockFetch(
		{ body: { error: "authorization_pending" }, status: 400 },
		{ body: { error: "slow_down" }, status: 400 },
		{
			body: {
				access_token: "access-token",
				refresh_token: "refresh-token",
				expires_in: 3_600,
				scope: "write",
			},
		},
	);
	const delays: number[] = [];
	const result = await pollDeviceAuthorization(
		"https://api.honcho.dev",
		{
			deviceCode: "device-code",
			userCode: "user-code",
			verificationUri: "https://honcho.dev/activate",
			expiresIn: 600,
			interval: 5,
		},
		{
			fetch,
			sleep: async (milliseconds) => {
				delays.push(milliseconds);
			},
			now: () => 0,
		},
	);

	assert.deepEqual(delays, [5_000, 5_000, 10_000]);
	assert.deepEqual(result, {
		kind: "success",
		tokens: {
			accessToken: "access-token",
			refreshToken: "refresh-token",
			accessExpiresAt: 3_600_000,
			clientId: "honcho-cli",
			scope: "write",
			host: "https://api.honcho.dev",
		},
	});
});

test("refresh retains a non-rotated refresh token", async () => {
	const { fetch, requests } = mockFetch({
		body: { access_token: "new-access-token", expires_in: 3_600 },
	});
	const result = await refreshOAuthTokens(
		{
			accessToken: "old-access-token",
			refreshToken: "old-refresh-token",
			accessExpiresAt: 0,
			clientId: "honcho-cli",
			scope: "write",
			host: "https://api.honcho.dev",
		},
		fetch,
		() => 0,
	);

	assert.deepEqual(result, {
		accessToken: "new-access-token",
		refreshToken: "old-refresh-token",
		accessExpiresAt: 3_600_000,
		clientId: "honcho-cli",
		scope: "write",
		host: "https://api.honcho.dev",
	});
	assert.equal(requests[0]?.url, "https://api.honcho.dev/oauth/token");
	assert.equal(
		requests[0]?.init?.body?.toString(),
		"grant_type=refresh_token&refresh_token=old-refresh-token&client_id=honcho-cli",
	);
});
