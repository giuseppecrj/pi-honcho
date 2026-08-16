import assert from "node:assert/strict"; // pi-lens-ignore: find-import-file-without-extension
import test from "node:test";

import {
	disableProjectPolicy,
	type ProjectPolicyCommandContext,
	type ProjectPolicyStore,
	setupProjectPolicy,
} from "../src/project-policy-command.js";

function context(overrides: Partial<ProjectPolicyCommandContext> = {}) {
	const confirmations: Array<{ title: string; details: string }> = [];
	const notifications: Array<{ message: string; level: string }> = [];
	return {
		cwd: "/work/example",
		isProjectTrusted: () => true,
		confirm: async (title: string, details: string) => {
			confirmations.push({ title, details });
			return true;
		},
		input: async () => "example",
		notify: (message: string, level: string) =>
			notifications.push({ message, level }),
		confirmations,
		notifications,
		...overrides,
	};
}

function store(existing: unknown | undefined): ProjectPolicyStore & {
	writes: Array<{ enabled: boolean; workspace?: string }>;
} {
	const writes: Array<{ enabled: boolean; workspace?: string }> = [];
	return {
		path: "/work/example/.pi/honcho-memory.json",
		read: async () => existing,
		write: async (policy) => {
			writes.push(policy);
			return "/work/example/.pi/honcho-memory.json";
		},
		writes,
	};
}

test("setup requires trust, proposes the directory basename, confirms replacement, and reports its target", async () => {
	const ctx = context({ input: async (_label, initial) => initial });
	const policyStore = store({ enabled: true, workspace: "previous" });

	await setupProjectPolicy(ctx, policyStore);

	assert.deepEqual(policyStore.writes, [
		{ enabled: true, workspace: "example" },
	]);
	assert.match(
		ctx.confirmations[0].details,
		/\/work\/example\/\.pi\/honcho-memory\.json/,
	);
	assert.match(ctx.confirmations[1].title, /Replace existing/i);
	assert.match(ctx.notifications[0].message, /Start a fresh conversation/i);
});

test("setup rejects an invalid workspace before confirmation or write", async () => {
	const ctx = context({ input: async () => "invalid.workspace" });
	const policyStore = store(undefined);

	await setupProjectPolicy(ctx, policyStore);

	assert.deepEqual(ctx.confirmations, []);
	assert.deepEqual(policyStore.writes, []);
	assert.equal(ctx.notifications[0].level, "warning");
	assert.match(
		ctx.notifications[0].message,
		/letters, digits, underscores, or hyphens/,
	);
});

test("setup ignores untrusted projects", async () => {
	const ctx = context({ isProjectTrusted: () => false });

	await setupProjectPolicy(ctx, store(undefined));

	assert.equal(ctx.notifications[0].level, "warning");
});

test("setup requires explicit recovery before replacing an invalid policy", async () => {
	const ctx = context({
		confirm: async (title) => !/Recover invalid/i.test(title),
	});
	const policyStore = store({ enabled: true });

	await setupProjectPolicy(ctx, policyStore);

	assert.deepEqual(policyStore.writes, []);
});

test("disable confirms, retains a valid workspace, and immediately applies the local privacy barrier", async () => {
	let disabled = 0;
	const ctx = context();
	const policyStore = store({ enabled: true, workspace: "project-memory" });

	await disableProjectPolicy(ctx, policyStore, () => {
		disabled += 1;
	});

	assert.deepEqual(policyStore.writes, [
		{ enabled: false, workspace: "project-memory" },
	]);
	assert.equal(disabled, 1);
	assert.match(ctx.notifications[0].message, /honcho-memory\.json/);
});

test("disable needs recovery confirmation before replacing an invalid policy", async () => {
	let disabled = 0;
	const ctx = context({
		confirm: async (title) => !/Recover invalid/i.test(title),
	});

	await disableProjectPolicy(ctx, store({ enabled: true }), () => {
		disabled += 1;
	});

	assert.equal(disabled, 0);
});
