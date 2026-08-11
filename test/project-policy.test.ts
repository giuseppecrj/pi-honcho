import assert from "node:assert/strict"; // pi-lens-ignore: find-import-file-without-extension
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { saveProjectHonchoPolicy } from "../src/config-file.js";
import {
	discoverProjectHonchoPolicy,
	projectHonchoEnabled,
	resolveProjectHonchoPolicy,
} from "../src/project-policy.js";

const policyFile = ".pi/honcho-memory.json";

async function writePolicy(directory: string, policy: string): Promise<string> {
	const path = join(directory, policyFile);
	await mkdir(join(directory, ".pi"), { recursive: true });
	await writeFile(path, policy);
	return path;
}

test("writes project policies atomically at the reported target", async () => {
	const root = await mkdtemp(join(tmpdir(), "honcho-policy-"));
	const path = await saveProjectHonchoPolicy(root, {
		enabled: true,
		workspace: "project-memory",
	});

	const target = join(root, ".pi", "honcho-memory.json");
	assert.equal(path, target);
	assert.equal(
		await readFile(target, "utf8"),
		'{\n  "enabled": true,\n  "workspace": "project-memory"\n}\n',
	);
	assert.deepEqual(
		(await readdir(join(root, ".pi"))).filter((name) => name.endsWith(".tmp")),
		[],
	);
});

test("a trusted project requires an explicit enabled policy with a workspace", () => {
	assert.deepEqual(
		resolveProjectHonchoPolicy(
			true,
			{ enabled: true, workspace: "work" },
			"/repo/.pi/honcho-memory.json",
		),
		{
			enabled: true,
			workspaceId: "work",
			workspaceSource: "project policy",
			policyPath: "/repo/.pi/honcho-memory.json",
		},
	);
	assert.deepEqual(
		resolveProjectHonchoPolicy(
			true,
			{ enabled: false, workspace: "retained" },
			"/repo/.pi/honcho-memory.json",
		),
		{
			enabled: false,
			workspaceId: "retained",
			workspaceSource: "project policy",
			policyPath: "/repo/.pi/honcho-memory.json",
			reason: "Disabled by trusted project policy",
		},
	);
	assert.equal(projectHonchoEnabled(true, { enabled: false }), false);
});

test("untrusted projects ignore their policy", () => {
	assert.deepEqual(
		resolveProjectHonchoPolicy(
			false,
			{ enabled: false },
			"/repo/.pi/honcho-memory.json",
		),
		{
			enabled: true,
			workspaceSource: "configuration",
		},
	);
	assert.equal(projectHonchoEnabled(false, { enabled: false }), true);
});

test("malformed project policies fail closed with an actionable reason", () => {
	for (const policy of [
		{},
		{ enabled: true },
		{ enabled: true, workspace: "" },
		{ enabled: true, workspace: "x".repeat(129) },
		{ enabled: true, workspace: "work", apiKey: "secret" },
	]) {
		const resolution = resolveProjectHonchoPolicy(
			true,
			policy,
			"/repo/.pi/honcho-memory.json",
		);
		assert.equal(resolution.enabled, false);
		assert.match(resolution.reason ?? "", /policy/i);
	}
});

test("nested Git policies inherit opt-outs while the closest enabled scope selects its workspace", async () => {
	const root = await mkdtemp(join(tmpdir(), "honcho-policy-"));
	const nested = join(root, "packages", "app");
	await mkdir(nested, { recursive: true });
	const rootPolicy = await writePolicy(
		root,
		'{"enabled":true,"workspace":"root"}',
	);
	const nestedPolicy = await writePolicy(
		nested,
		'{"enabled":true,"workspace":"nested"}',
	);

	const enabled = await discoverProjectHonchoPolicy(
		nested,
		true,
		async () => root,
	);
	assert.deepEqual(enabled, {
		enabled: true,
		workspaceId: "nested",
		workspaceSource: "project policy",
		policyPath: nestedPolicy,
	});

	await writeFile(rootPolicy, '{"enabled":false,"workspace":"retained"}');
	const disabled = await discoverProjectHonchoPolicy(
		nested,
		true,
		async () => root,
	);
	assert.deepEqual(disabled, {
		enabled: false,
		workspaceId: "retained",
		workspaceSource: "project policy",
		policyPath: rootPolicy,
		reason: "Disabled by trusted project policy",
	});
});

test("malformed discovered policies fail closed", async () => {
	const root = await mkdtemp(join(tmpdir(), "honcho-policy-"));
	const path = await writePolicy(root, "{");

	assert.deepEqual(
		await discoverProjectHonchoPolicy(root, true, async () => root),
		{
			enabled: false,
			workspaceSource: "project policy",
			policyPath: path,
			reason: "Project policy could not be read or parsed as JSON",
		},
	);
});

test("non-Git directories consider only their own explicit policy", async () => {
	const parent = await mkdtemp(join(tmpdir(), "honcho-policy-"));
	const child = join(parent, "child");
	await mkdir(child);
	await writePolicy(parent, '{"enabled":false}');
	const childPolicy = await writePolicy(
		child,
		'{"enabled":true,"workspace":"current"}',
	);

	assert.deepEqual(
		await discoverProjectHonchoPolicy(child, true, async () => undefined),
		{
			enabled: true,
			workspaceId: "current",
			workspaceSource: "project policy",
			policyPath: childPolicy,
		},
	);
});
