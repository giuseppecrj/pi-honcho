import assert from "node:assert/strict"; // pi-lens-ignore: find-import-file-without-extension
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveHonchoConfig } from "../src/config.js";
import { saveHonchoSettings } from "../src/config-file.js";

test("environment values override the isolated Honcho host block", () => {
	const envBaseUrl = ["https:", "", "env.example"].join("/");
	const fileBaseUrl = ["https:", "", "file.example"].join("/");
	const result = resolveHonchoConfig(
		{
			HONCHO_API_KEY: "environment-key",
			HONCHO_BASE_URL: envBaseUrl,
			HONCHO_WORKSPACE_ID: "env-workspace",
			HONCHO_PEER_NAME: "env-user",
			HONCHO_MAX_MESSAGE_LENGTH: "1234",
		},
		{
			hosts: {
				"pi-honcho": {
					apiKey: "file-key",
					environmentUrl: fileBaseUrl,
					workspaceId: "file-workspace",
					peerName: "file-user",
				},
			},
		},
	);

	assert.equal(result.kind, "configured");
	if (result.kind !== "configured") return;
	assert.deepEqual(result.config, {
		apiKey: "environment-key",
		baseUrl: "https://env.example",
		workspaceId: "env-workspace",
		workspaceSource: "environment",
		peerName: "env-user",
		aiPeer: "pi",
		timeoutMs: 3_000,
		maxMessageLength: 1_234,
	});
});

test("primary host settings override legacy fields and inherit missing values", () => {
	const result = resolveHonchoConfig(
		{},
		{
			hosts: {
				"pi-honcho": {
					environmentUrl: "https://primary.example",
					workspaceId: "primary-workspace",
					peerName: "primary-user",
				},
				"pi-honcho-memory": {
					apiKey: "legacy-key",
					environmentUrl: "https://legacy.example",
					workspaceId: "legacy-workspace",
					peerName: "legacy-user",
				},
			},
		},
	);

	assert.equal(result.kind, "configured");
	if (result.kind !== "configured") return;
	assert.equal(result.config.apiKey, "legacy-key");
	assert.equal(result.config.baseUrl, "https://primary.example");
	assert.equal(result.config.workspaceId, "primary-workspace");
	assert.equal(result.config.peerName, "primary-user");
});

test("legacy host settings remain usable when the primary host is absent", () => {
	const result = resolveHonchoConfig(
		{},
		{
			hosts: {
				"pi-honcho-memory": {
					apiKey: "legacy-key",
					workspaceId: "legacy-workspace",
					peerName: "legacy-user",
				},
			},
		},
	);

	assert.equal(result.kind, "configured");
	if (result.kind !== "configured") return;
	assert.equal(result.config.apiKey, "legacy-key");
	assert.equal(result.config.workspaceId, "legacy-workspace");
	assert.equal(result.config.peerName, "legacy-user");
});

test("environment workspace overrides a project workspace without changing credentials or peers", () => {
	const result = resolveHonchoConfig(
		{
			HONCHO_API_KEY: "environment-key",
			HONCHO_WORKSPACE_ID: "environment-workspace",
		},
		{
			hosts: {
				"pi-honcho": {
					workspaceId: "configured-workspace",
					peerName: "configured-user",
				},
			},
		},
		"project-workspace",
	);

	assert.equal(result.kind, "configured");
	if (result.kind !== "configured") return;
	assert.equal(result.config.workspaceId, "environment-workspace");
	assert.equal(result.config.workspaceSource, "environment");
	assert.equal(result.config.peerName, "configured-user");
});

test("uses the Honcho CLI's top-level credentials when no override is set", () => {
	const environmentUrl = ["https:", "", "honcho.example"].join("/");
	const result = resolveHonchoConfig(
		{},
		{
			apiKey: "cli-key",
			environmentUrl,
		},
	);

	assert.equal(result.kind, "configured");
	if (result.kind !== "configured") return;
	assert.equal(result.config.apiKey, "cli-key");
	assert.equal(result.config.baseUrl, environmentUrl);
});

test("an explicit disable wins over otherwise valid credentials", () => {
	const result = resolveHonchoConfig(
		{ HONCHO_ENABLED: "false", HONCHO_API_KEY: "key" },
		{},
	);

	assert.deepEqual(result, {
		kind: "disabled",
		reason: "HONCHO_ENABLED is disabled",
	});
});

test("missing credentials are unconfigured without exposing configuration values", () => {
	const result = resolveHonchoConfig(
		{},
		{ hosts: { "pi-honcho": { workspaceId: "pi" } } },
	);

	assert.deepEqual(result, {
		kind: "unconfigured",
		reason: "No Honcho API key is configured",
	});
});

test("setup writes only non-secret primary settings and preserves unrelated config", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-honcho-config-"));
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	process.env.HOME = root;
	process.env.USERPROFILE = root;

	try {
		const path = join(root, ".honcho", "config.json");
		await mkdir(join(root, ".honcho"), { recursive: true });
		await writeFile(
			path,
			`${JSON.stringify(
				{
					apiKey: "cli-key",
					hosts: {
						"other-client": { workspaceId: "other" },
						"pi-honcho-memory": {
							apiKey: "legacy-key",
							workspaceId: "legacy-workspace",
							peerName: "legacy-user",
							aiPeer: "legacy-ai",
						},
					},
				},
				null,
				2,
			)}\n`,
			"utf8",
		);

		assert.equal(
			await saveHonchoSettings({
				workspaceId: "setup-workspace",
				peerName: "setup-user",
				aiPeer: "setup-ai",
			}),
			true,
		);

		const saved = JSON.parse(await readFile(path, "utf8")) as {
			apiKey?: unknown;
			hosts?: Record<string, Record<string, unknown>>;
		};
		assert.equal(saved.apiKey, "cli-key");
		assert.deepEqual(saved.hosts?.["other-client"], { workspaceId: "other" });
		assert.deepEqual(saved.hosts?.["pi-honcho-memory"], {
			apiKey: "legacy-key",
			workspaceId: "legacy-workspace",
			peerName: "legacy-user",
			aiPeer: "legacy-ai",
		});
		assert.deepEqual(saved.hosts?.["pi-honcho"], {
			workspaceId: "setup-workspace",
			peerName: "setup-user",
			aiPeer: "setup-ai",
		});
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previousUserProfile;
		await rm(root, { recursive: true, force: true });
	}
});
