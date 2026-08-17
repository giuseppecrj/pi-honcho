import assert from "node:assert/strict";
import {
	access,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import localKnowledgeTools from "../src/local/index.js";

type RegisteredTool = {
	name: string;
	label: string;
	description: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	parameters: unknown;
	execute: (
		_id: string,
		input: Record<string, unknown>,
	) => Promise<{ content: Array<{ text: string }> }>;
};
type ResourceHandler = (event: {
	cwd: string;
}) => Promise<{ skillPaths?: string[] }>;

class FakePi {
	tools = new Map<string, RegisteredTool>();
	handlers = new Map<
		string,
		ResourceHandler | ((...args: unknown[]) => unknown)
	>();

	registerTool(tool: RegisteredTool): void {
		this.tools.set(tool.name, tool);
	}

	registerCommand(): void {}

	on(
		name: string,
		handler: ResourceHandler | ((...args: unknown[]) => unknown),
	): void {
		this.handlers.set(name, handler);
	}
}

async function output(
	tool: RegisteredTool,
	input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const result = await tool.execute("test", input);
	const text = result.content[0]?.text ?? "{}";
	try {
		return JSON.parse(text) as Record<string, unknown>;
	} catch {
		assert.fail(`tool returned invalid JSON: ${text}`);
	}
}

async function setup(options: { project?: boolean } = {}): Promise<{
	root: string;
	cwd: string;
	global: string;
	projects: string;
	piGlobal: string;
	pi: FakePi;
	tool: RegisteredTool;
	resources: ResourceHandler;
}> {
	const root = await mkdtemp(join(tmpdir(), "pi-honcho-skills-"));
	const cwd = join(root, "repo");
	const global = join(root, "global");
	const projects = join(root, "projects");
	const piGlobal = join(root, "pi-global");
	await mkdir(join(cwd, ".git"), { recursive: true });
	const pi = new FakePi();
	localKnowledgeTools(pi as unknown as ExtensionAPI, {
		globalSkillsDir: global,
		piGlobalSkillsDir: piGlobal,
		projectsMemoryDir: projects,
		cwd,
	});
	const tool = pi.tools.get("skill_manage");
	const resources = pi.handlers.get("resources_discover") as
		| ResourceHandler
		| undefined;
	assert.ok(tool);
	assert.ok(resources);
	if (options.project !== false) await resources({ cwd });
	return { root, cwd, global, projects, piGlobal, pi, tool, resources };
}

async function cleanup(root: string): Promise<void> {
	await rm(root, { recursive: true, force: true });
}

function bodyFields(): Record<string, unknown> {
	return {
		when_to_use: "When this workflow is needed",
		procedure_steps: ["Perform the first step", "Perform the second step"],
		pitfalls: ["Avoid the known trap"],
		verification_steps: ["Confirm the result"],
	};
}

test("default managed global skills live under pi-honcho", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-honcho-default-skills-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
	try {
		const cwd = join(root, "repo");
		await mkdir(join(cwd, ".git"), { recursive: true });
		const pi = new FakePi();
		localKnowledgeTools(pi as unknown as ExtensionAPI, {
			piGlobalSkillsDir: join(root, "pi-native-skills"),
			projectsMemoryDir: join(root, "projects-memory"),
			cwd,
		});
		const resources = pi.handlers.get("resources_discover") as
			| ResourceHandler
			| undefined;
		assert.ok(resources);
		assert.deepEqual((await resources({ cwd })).skillPaths, [
			join(root, "pi-honcho", "skills"),
			join(root, "projects-memory", "repo", "skills"),
		]);
		await access(join(root, "pi-honcho", "skills"));
		await assert.rejects(access(join(root, "pi-hermes-memory", "skills")));
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await cleanup(root);
	}
});

// Public registration seam: this must remain compatible with the established Hermes tool.
test("skill_manage keeps the established tool metadata and action fields", async () => {
	const fixture = await setup({ project: false });
	try {
		const tool = fixture.tool;
		assert.equal(tool.name, "skill_manage");
		assert.equal(tool.label, "Skill Manager");
		assert.match(tool.description, /Pi-native skills/);
		assert.match(tool.description, /Scope is required on create/);
		assert.equal(
			tool.promptSnippet,
			"Create, inspect, and update reusable procedures and patterns",
		);
		assert.ok(
			tool.promptGuidelines?.length && tool.promptGuidelines.length >= 5,
		);
		const schema = JSON.stringify(tool.parameters);
		for (const field of [
			"action",
			"name",
			"skill_id",
			"description",
			"scope",
			"section",
			"content",
			"when_to_use",
			"procedure_steps",
			"pitfalls",
			"verification_steps",
		])
			assert.match(schema, new RegExp(field));
	} finally {
		await cleanup(fixture.root);
	}
});

test("global and project scopes stay separate and project creation requires context", async () => {
	const noProject = await setup({ project: false });
	try {
		const result = await output(noProject.tool, {
			action: "create",
			name: "project-rule",
			description: "A project rule",
			scope: "project",
			content: "safe",
		});
		assert.match(String(result.error), /active project/);
	} finally {
		await cleanup(noProject.root);
	}

	const fixture = await setup();
	try {
		const global = await output(fixture.tool, {
			action: "create",
			name: "shared-rule",
			description: "A portable rule",
			scope: "global",
			content: "global body",
		});
		const project = await output(fixture.tool, {
			action: "create",
			name: "shared-rule",
			description: "A repository rule",
			scope: "project",
			content: "project body",
		});
		assert.equal(global.success, true);
		assert.equal(project.success, true);
		assert.equal(global.skillId, "global:shared-rule");
		assert.equal(project.skillId, "project:repo:shared-rule");
	} finally {
		await cleanup(fixture.root);
	}
});

test("existing extension skills are listed and viewed without migration", async () => {
	const fixture = await setup({ project: false });
	try {
		await mkdir(join(fixture.global, "existing-global"), { recursive: true });
		await writeFile(
			join(fixture.global, "existing-global", "SKILL.md"),
			`---\nname: existing-global\ndescription: Existing global skill\n---\nGlobal body\n`,
		);
		const projectRoot = join(
			fixture.projects,
			"repo",
			"skills",
			"existing-project",
		);
		await mkdir(projectRoot, { recursive: true });
		await writeFile(
			join(projectRoot, "SKILL.md"),
			`---\nname: existing-project\ndescription: Existing project skill\n---\nProject body\n`,
		);
		await fixture.resources({ cwd: fixture.cwd });
		const list = await output(fixture.tool, { action: "view" });
		assert.deepEqual(
			(list.skills as Array<{ skillId: string }>)
				.map((item) => item.skillId)
				.sort(),
			["global:existing-global", "project:repo:existing-project"],
		);
		assert.equal(
			(
				await output(fixture.tool, {
					action: "view",
					skill_id: "global:existing-global",
				})
			).body,
			"Global body",
		);
		assert.equal(
			(
				await output(fixture.tool, {
					action: "view",
					skill_id: "project:repo:existing-project",
				})
			).body,
			"Project body",
		);
		assert.equal(
			await readFile(
				join(fixture.global, "existing-global", "SKILL.md"),
				"utf8",
			).then((text) => text.includes("Global body")),
			true,
		);
	} finally {
		await cleanup(fixture.root);
	}
});

test("structured create, update, and legacy edit produce valid Pi skills", async () => {
	const fixture = await setup();
	try {
		const created = await output(fixture.tool, {
			action: "create",
			name: "structured-skill",
			description: "A structured skill",
			scope: "project",
			...bodyFields(),
		});
		assert.equal(created.success, true);
		const path = join(
			fixture.projects,
			"repo",
			"skills",
			"structured-skill",
			"SKILL.md",
		);
		const first = await readFile(path, "utf8");
		assert.match(first, /^---\nname: "structured-skill"\n.*\n---\n/s);
		for (const section of [
			"## When to Use",
			"## Procedure",
			"## Pitfalls",
			"## Verification",
		])
			assert.match(first, new RegExp(section));
		const updated = await output(fixture.tool, {
			action: "update",
			skill_id: "project:repo:structured-skill",
			description: "Updated structured skill",
			...bodyFields(),
			procedure_steps: ["Updated step"],
		});
		assert.equal(updated.success, true);
		assert.match(await readFile(path, "utf8"), /1\. Updated step/);
		const edited = await output(fixture.tool, {
			action: "edit",
			skill_id: "project:repo:structured-skill",
			content: "Legacy edit body",
		});
		assert.equal(edited.success, true);
		assert.equal(
			(
				await output(fixture.tool, {
					action: "view",
					skill_id: "project:repo:structured-skill",
				})
			).body,
			"Legacy edit body",
		);
	} finally {
		await cleanup(fixture.root);
	}
});

test("patch updates every structured section and rejects unsafe patch payloads", async () => {
	const fixture = await setup();
	try {
		await output(fixture.tool, {
			action: "create",
			name: "patchable",
			description: "Patchable skill",
			scope: "project",
			content:
				"## When to Use\nOld\n\n## Procedure\n1. Old\n\n## Pitfalls\n- Old\n\n## Verification\n1. Old",
		});
		const patches: Array<[string, string, unknown]> = [
			["When to Use", "when_to_use", "New use"],
			["Procedure", "procedure_steps", ["New procedure"]],
			["Pitfalls", "pitfalls", ["New pitfall"]],
			["Verification", "verification_steps", ["New verification"]],
		];
		for (const [section, field, value] of patches) {
			const result = await output(fixture.tool, {
				action: "patch",
				skill_id: "project:repo:patchable",
				section,
				[field]: value,
			});
			assert.equal(result.success, true);
		}
		for (const input of [
			{ section: "Procedure", content: "" },
			{ section: "Not A Section", content: "safe" },
			{ section: "Procedure\n## Injected", content: "safe" },
			{ section: "Procedure", content: "## Injected" },
			{ section: "Procedure", content: '{"steps":["drift"]}' },
			{ section: "Procedure", content: "GITHUB_TOKEN=secret-value" },
		] as const)
			assert.equal(
				(
					await output(fixture.tool, {
						action: "patch",
						skill_id: "project:repo:patchable",
						...input,
					})
				).success,
				false,
			);
	} finally {
		await cleanup(fixture.root);
	}
});

test("patch replaces a section body while preserving the following section", async () => {
	const fixture = await setup();
	try {
		await output(fixture.tool, {
			action: "create",
			name: "replaceable",
			description: "A replaceable skill",
			scope: "project",
			content: "## Procedure\nold\n\n## Verification\n1. keep",
		});
		assert.equal(
			(
				await output(fixture.tool, {
					action: "patch",
					skill_id: "project:repo:replaceable",
					section: "Procedure",
					content: "new",
				})
			).success,
			true,
		);
		assert.equal(
			(
				await output(fixture.tool, {
					action: "view",
					skill_id: "project:repo:replaceable",
				})
			).body,
			"## Procedure\nnew\n\n## Verification\n1. keep",
		);
	} finally {
		await cleanup(fixture.root);
	}
});

test("create and edit never persist secret-bearing content", async () => {
	const fixture = await setup();
	try {
		for (const action of ["create", "edit"] as const) {
			const result = await output(
				fixture.tool,
				action === "create"
					? {
							action,
							name: "secret-skill",
							description: "Secret skill",
							scope: "project",
							content: "OPENAI_API_KEY=secret-value",
						}
					: {
							action,
							skill_id: "project:repo:missing",
							content: "OPENAI_API_KEY=secret-value",
						},
			);
			assert.equal(result.success, false);
		}
		assert.equal(
			((await output(fixture.tool, { action: "view" })).skills as unknown[])
				.length,
			0,
		);
	} finally {
		await cleanup(fixture.root);
	}
});

test("extension and Pi skill conflicts give useful guidance", async () => {
	const fixture = await setup({ project: false });
	try {
		await mkdir(join(fixture.global, "duplicate"), { recursive: true });
		await writeFile(
			join(fixture.global, "duplicate", "SKILL.md"),
			`---\nname: duplicate\ndescription: Existing duplicate\n---\nbody`,
		);
		await mkdir(join(fixture.global, "debug-typescript"), { recursive: true });
		await writeFile(
			join(fixture.global, "debug-typescript", "SKILL.md"),
			`---\nname: debug-typescript\ndescription: Debug TypeScript compiler errors\n---\nbody`,
		);
		await mkdir(join(fixture.global, "debug-typescript-other"), {
			recursive: true,
		});
		await writeFile(
			join(fixture.global, "debug-typescript-other", "SKILL.md"),
			`---\nname: debug-typescript-other\ndescription: Different workflow intent\n---\nbody`,
		);
		await mkdir(fixture.piGlobal, { recursive: true });
		await writeFile(
			join(fixture.piGlobal, "direct.md"),
			`---\nname: direct\ndescription: Pi direct skill\n---\nbody`,
		);
		await mkdir(join(fixture.piGlobal, "different-directory"), {
			recursive: true,
		});
		await writeFile(
			join(fixture.piGlobal, "different-directory", "SKILL.md"),
			`---\nname: claimed\ndescription: Pi claimed skill\n---\nbody`,
		);
		const conflicts: Array<[string, string, RegExp]> = [
			["duplicate", "x", /patch|already exists/],
			[
				"debug-typescript-debug",
				"Debug TypeScript compiler errors",
				/similar|patch/,
			],
			[
				"debug-typescript-other-new",
				"A separate database workflow",
				/near-name|clearer/,
			],
			["direct", "x", /already loads|choose/],
			["claimed", "x", /already loads|choose/],
		];
		for (const [name, description, phrase] of conflicts) {
			const result = await output(fixture.tool, {
				action: "create",
				name,
				description,
				scope: "global",
				content: "safe",
			});
			assert.match(String(result.error ?? result.message ?? ""), phrase);
		}
	} finally {
		await cleanup(fixture.root);
	}
});

test("canonical ids, traversal, symlink escapes, deletion cleanup, and discovery stay safe", async () => {
	const fixture = await setup();
	try {
		for (const name of [
			"../escape",
			"/absolute",
			"Bad Name",
			"bad--name",
			"-leading",
			"trailing-",
		]) {
			assert.equal(
				(
					await output(fixture.tool, {
						action: "create",
						name,
						description: "x",
						scope: "global",
						content: "safe",
					})
				).success,
				false,
			);
		}
		const outside = join(fixture.root, "outside");
		await mkdir(outside, { recursive: true });
		await symlink(outside, join(fixture.global, "escaped"));
		assert.equal(
			(
				await output(fixture.tool, {
					action: "create",
					name: "escaped",
					description: "x",
					scope: "global",
					content: "safe",
				})
			).success,
			false,
		);
		assert.equal(
			(
				await output(fixture.tool, {
					action: "delete",
					skill_id: "global:escaped",
				})
			).success,
			false,
		);
		const created = await output(fixture.tool, {
			action: "create",
			name: "cleanup",
			description: "x",
			scope: "global",
			content: "safe",
		});
		assert.equal(created.success, true);
		assert.equal(
			(
				await output(fixture.tool, {
					action: "delete",
					skill_id: "global:cleanup",
				})
			).success,
			true,
		);
		assert.equal(
			await (await import("node:fs/promises"))
				.access(join(fixture.global, "cleanup"))
				.then(
					() => true,
					() => false,
				),
			false,
		);
		const resources = await fixture.resources({ cwd: fixture.cwd });
		assert.ok(resources.skillPaths?.includes(fixture.global));
		assert.ok(
			resources.skillPaths?.includes(join(fixture.projects, "repo", "skills")),
		);
	} finally {
		await cleanup(fixture.root);
	}
});

test("linked worktrees share the main repository project skill root", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-honcho-worktree-"));
	const main = join(root, "main-repository");
	const linked = join(root, "linked-worktree");
	const common = join(main, ".git");
	const worktreeGit = join(common, "worktrees", "linked");
	const global = join(root, "global");
	const projects = join(root, "projects");
	const piGlobal = join(root, "pi-global");
	await mkdir(join(common, "worktrees"), { recursive: true });
	await mkdir(linked, { recursive: true });
	await writeFile(join(linked, ".git"), `gitdir: ${worktreeGit}\n`);
	await mkdir(worktreeGit, { recursive: true });
	await writeFile(join(worktreeGit, "commondir"), "../..\n");
	const pi = new FakePi();
	localKnowledgeTools(pi as unknown as ExtensionAPI, {
		globalSkillsDir: global,
		piGlobalSkillsDir: piGlobal,
		projectsMemoryDir: projects,
		cwd: main,
	});
	const tool = pi.tools.get("skill_manage");
	const resources = pi.handlers.get("resources_discover") as
		| ResourceHandler
		| undefined;
	assert.ok(tool);
	assert.ok(resources);
	try {
		await resources({ cwd: main });
		await output(tool, {
			action: "create",
			name: "shared-worktree-rule",
			description: "Shared repository rule",
			scope: "project",
			content: "safe",
		});
		const mainPaths = await resources({ cwd: main });
		const linkedPaths = await resources({ cwd: linked });
		const expected = join(projects, "main-repository", "skills");
		assert.ok(mainPaths.skillPaths?.includes(expected));
		assert.deepEqual(linkedPaths.skillPaths, [global, expected]);
		assert.equal(
			(
				await output(tool, {
					action: "view",
					skill_id: "project:main-repository:shared-worktree-rule",
				})
			).success,
			true,
		);
	} finally {
		await cleanup(root);
	}
});

test("Pi project discovery does not inspect a parent outside the repository", async () => {
	const fixture = await setup();
	try {
		await mkdir(join(fixture.root, ".pi", "skills", "outside-only"), {
			recursive: true,
		});
		await writeFile(
			join(fixture.root, ".pi", "skills", "outside-only", "SKILL.md"),
			`---\nname: outside-only\ndescription: outside\n---\nbody`,
		);
		const result = await output(fixture.tool, {
			action: "create",
			name: "outside-only",
			description: "local",
			scope: "project",
			content: "safe",
		});
		assert.equal(result.success, true);
	} finally {
		await cleanup(fixture.root);
	}
});
