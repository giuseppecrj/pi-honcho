import assert from "node:assert/strict"; // pi-lens-ignore: find-import-file-without-extension
import test from "node:test";

import { HonchoStatusController } from "../src/remote/status.js";

const config = {
	apiKey: "test-key",
	workspaceId: "pi",
	workspaceSource: "default" as const,
	peerName: "user",
	aiPeer: "pi",
	timeoutMs: 3_000,
	maxMessageLength: 8_000,
};

async function settle(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

test("starts non-blockingly while the client probe is pending", async () => {
	let releaseProbe: (() => void) | undefined;
	const controller = new HonchoStatusController(
		{ kind: "configured", config },
		() => ({
			checkConnection: async () =>
				new Promise<void>((resolve) => {
					releaseProbe = resolve;
				}),
		}),
		() => undefined,
	);

	controller.start();

	assert.equal(controller.current.kind, "connecting");
	assert.ok(releaseProbe);
	releaseProbe();
	await settle();
	assert.equal(controller.current.kind, "connected");
});

test("reports connected only after the client probe succeeds", async () => {
	const statuses: string[] = [];
	const controller = new HonchoStatusController(
		{ kind: "configured", config },
		() => ({ checkConnection: async () => undefined }),
		(status) => statuses.push(status.kind),
	);

	controller.start();
	await settle();

	assert.deepEqual(statuses, ["connecting", "connected"]);
	assert.equal(controller.current.kind, "connected");
});

test("reports retrying instead of throwing when the client probe fails", async () => {
	const controller = new HonchoStatusController(
		{ kind: "configured", config },
		() => ({
			checkConnection: async () => Promise.reject(new Error("network down")),
		}),
		() => undefined,
		60_000,
	);

	controller.start();
	await settle();

	assert.deepEqual(controller.current, {
		kind: "retrying",
		reason: "Unable to reach Honcho",
	});
	controller.stop();
});

test("does not construct a remote client when configuration is disabled", () => {
	let created = false;
	const controller = new HonchoStatusController(
		{ kind: "disabled", reason: "HONCHO_ENABLED is disabled" },
		() => {
			created = true;
			return { checkConnection: async () => undefined };
		},
		() => undefined,
	);

	controller.start();

	assert.equal(created, false);
	assert.deepEqual(controller.current, {
		kind: "disabled",
		reason: "HONCHO_ENABLED is disabled",
	});
});
