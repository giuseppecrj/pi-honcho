import type { Dirent } from "node:fs";
import {
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	rmdir,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
} from "node:path";

import { scanContent } from "./content-scanner.js";

const SLUG = /^[a-z0-9](?:[a-z0-9]|-(?!-))*[a-z0-9]?$/;
const SECTIONS = new Set([
	"when to use",
	"procedure",
	"pitfalls",
	"verification",
]);

export type SkillScope = "global" | "project";
export type SkillIndex = {
	skillId: string;
	scope: SkillScope;
	fileName: string;
	path: string;
	projectName?: string;
	name: string;
	description: string;
	created: string;
	updated: string;
};
export type SkillDocument = SkillIndex & { body: string; version: number };
export type SkillResult = {
	success: boolean;
	error?: string;
	message?: string;
	fileName?: string;
	skillId?: string;
	scope?: SkillScope;
	path?: string;
	conflictType?: "duplicate" | "similar" | "name-collision";
	similarSkillIds?: string[];
	suggestedAction?: "patch" | "update" | "rename";
};

type Location = {
	skillId: string;
	scope: SkillScope;
	slug: string;
	path: string;
	projectName?: string;
};
export type SkillStoreOptions = {
	globalSkillsDir?: string;
	piGlobalSkillsDir?: string;
	projectsMemoryDir?: string;
	projectName?: string | null;
	projectSkillsDir?: string | null;
	cwd?: string;
};

const agentRoot = () =>
	resolve(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"));

export function validSkillSlug(slug: string): boolean {
	return (
		slug.length >= 1 &&
		slug.length <= 64 &&
		SLUG.test(slug) &&
		!slug.includes("/") &&
		!slug.includes("\\")
	);
}

function slugify(input: string): string {
	return input
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-{2,}/g, "-")
		.slice(0, 64);
}

function skillId(
	scope: SkillScope,
	slug: string,
	project?: string | null,
): string {
	return scope === "global"
		? `global:${slug}`
		: `project:${project ?? ""}:${slug}`;
}

function parseId(
	id: string,
): { scope: SkillScope; slug: string; project?: string } | undefined {
	if (id.startsWith("global:")) {
		const slug = id.slice(7);
		return validSkillSlug(slug) && id === `global:${slug}`
			? { scope: "global", slug }
			: undefined;
	}
	if (!id.startsWith("project:")) return undefined;
	const rest = id.slice(8);
	const index = rest.indexOf(":");
	const project = rest.slice(0, index);
	const slug = rest.slice(index + 1);
	return index > 0 &&
		index === rest.lastIndexOf(":") &&
		project.length > 0 &&
		validSkillSlug(slug) &&
		!project.includes("/") &&
		!project.includes("\\")
		? { scope: "project", project, slug }
		: undefined;
}

function parseFrontmatter(
	raw: string,
): { meta: Record<string, string>; body: string } | undefined {
	const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
	if (!match) return undefined;
	const meta: Record<string, string> = {};
	for (const line of match[1].split(/\r?\n/)) {
		const index = line.indexOf(":");
		if (index <= 0) continue;
		let value = line.slice(index + 1).trim();
		if (value.startsWith('"') && value.endsWith('"')) {
			try {
				value = JSON.parse(value) as string;
			} catch {
				return undefined;
			}
		}
		meta[line.slice(0, index).trim()] = value;
	}
	if (!validSkillSlug(meta.name ?? "") || !meta.description?.trim())
		return undefined;
	return { meta, body: match[2].trim() };
}

function yaml(value: string): string {
	return JSON.stringify(value);
}
function documentText(
	doc: Pick<
		SkillDocument,
		"name" | "description" | "version" | "created" | "updated" | "body"
	>,
): string {
	return [
		"---",
		`name: ${yaml(doc.name)}`,
		`description: ${yaml(doc.description)}`,
		`version: ${doc.version}`,
		`created: ${yaml(doc.created)}`,
		`updated: ${yaml(doc.updated)}`,
		"---",
		doc.body.trim(),
		"",
	].join("\n");
}
function tokens(text: string): Set<string> {
	return new Set(
		text
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, " ")
			.split(/\s+/)
			.filter((x) => x.length > 1),
	);
}
function similarity(a: string, b: string): number {
	const left = tokens(a);
	const right = tokens(b);
	if (!left.size || !right.size) return 0;
	let common = 0;
	for (const token of left) if (right.has(token)) common++;
	return common / new Set([...left, ...right]).size;
}
function inside(root: string, target: string): boolean {
	const rel = relative(root, target);
	return (
		rel === "" ||
		(rel !== ".." &&
			!rel.startsWith(`..${requireSeparator()}`) &&
			!isAbsolute(rel))
	);
}
function requireSeparator(): string {
	return process.platform === "win32" ? "\\" : "/";
}

export function normalizePatch(
	section: string,
	raw: string,
): { content: string } | { error: string } {
	const original = section.trim();
	const name = original
		.replace(/^##\s+/, "")
		.trim()
		.toLowerCase();
	if (!SECTIONS.has(name) || original.includes("\n") || /[#:]$/.test(name))
		return {
			error:
				"section must be one of When to Use, Procedure, Pitfalls, or Verification.",
		};
	let content = raw.trim();
	if (!content) return { error: "New content is required for patch." };
	if (content.startsWith("{"))
		return {
			error:
				"Patch content must be Markdown or a JSON string array, not a JSON object.",
		};
	if (content.startsWith("[")) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(content);
		} catch {
			return { error: "Patch JSON arrays must be valid." };
		}
		if (
			!Array.isArray(parsed) ||
			parsed.some((item) => typeof item !== "string")
		)
			return { error: "Patch JSON arrays must contain only strings." };
		const items = parsed.map((item) => item.trim()).filter(Boolean);
		if (!items.length)
			return { error: "Patch content must contain non-empty strings." };
		content =
			name === "when to use"
				? items.join("\n\n")
				: items
						.map((item, i) =>
							name === "pitfalls"
								? `- ${item.replace(/^[-*]\s+/, "")}`
								: `${i + 1}. ${item.replace(/^\d+\.\s+|^[-*]\s+/, "")}`,
						)
						.join("\n");
	}
	if (/^#{1,6}\s+\S/m.test(content))
		return {
			error: "Patch content must not include Markdown section headers.",
		};
	return { content };
}

async function resolveWorktreeCommonDir(
	worktreeRoot: string,
	dotGitFile: string,
): Promise<string | null> {
	let pointer: string;
	try {
		pointer = await readFile(dotGitFile, "utf8");
	} catch {
		return null;
	}
	const match = /^gitdir:\s*(.+)$/m.exec(pointer);
	if (!match) return null;
	const gitDir = resolve(worktreeRoot, match[1].trim());
	try {
		const commonDir = (
			await readFile(join(gitDir, "commondir"), "utf8")
		).trim();
		if (commonDir) return resolve(gitDir, commonDir);
	} catch {
		/* Fall back to the conventional linked-worktree layout below. */
	}
	const parent = dirname(gitDir);
	return basename(parent) === "worktrees" ? dirname(parent) : null;
}

async function gitRoot(cwd: string): Promise<string | null> {
	let current = resolve(cwd);
	while (true) {
		const dotGit = join(current, ".git");
		try {
			const metadata = await lstat(dotGit);
			if (metadata.isDirectory()) return current;
			if (metadata.isFile()) {
				const commonDir = await resolveWorktreeCommonDir(current, dotGit);
				if (!commonDir) return current;
				return basename(commonDir) === ".git" ? dirname(commonDir) : commonDir;
			}
		} catch {
			/* continue */
		}
		const parent = dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

async function projectFromCwd(cwd: string): Promise<string | null> {
	const resolved = resolve(cwd);
	const home = resolve(homedir());
	if (resolved === home || resolved === "/") return null;
	const root = await gitRoot(resolved);
	return basename(root ?? resolved) || null;
}

export class SkillStore {
	private global: string;
	private piGlobal: string;
	private projectsRoot: string;
	private projectName: string | null;
	private projectSkills: string | null;
	private readonly projectSkillsOverride: string | null;
	private cwd: string;

	constructor(options: SkillStoreOptions = {}) {
		const root = agentRoot();
		this.global = resolve(
			options.globalSkillsDir ?? join(root, "pi-hermes-memory", "skills"),
		);
		this.piGlobal = resolve(options.piGlobalSkillsDir ?? join(root, "skills"));
		this.projectsRoot = resolve(
			options.projectsMemoryDir ?? join(root, "projects-memory"),
		);
		this.projectName = options.projectName ?? null;
		this.cwd = options.cwd ?? process.cwd();
		this.projectSkillsOverride = options.projectSkillsDir
			? resolve(options.projectSkillsDir)
			: null;
		this.projectSkills =
			this.projectSkillsOverride ??
			(this.projectName
				? join(this.projectsRoot, this.projectName, "skills")
				: null);
	}

	getGlobalSkillsDir(): string {
		return this.global;
	}
	getProjectSkillsDir(): string | null {
		return this.projectSkills;
	}
	getProjectName(): string | null {
		return this.projectName;
	}
	async setProjectFromCwd(cwd: string): Promise<void> {
		this.cwd = cwd;
		this.projectName = await projectFromCwd(cwd);
		this.projectSkills =
			this.projectSkillsOverride ??
			(this.projectName
				? join(this.projectsRoot, this.projectName, "skills")
				: null);
	}
	async ensureRoots(): Promise<void> {
		await mkdir(this.global, { recursive: true });
		if (this.projectSkills)
			await mkdir(this.projectSkills, { recursive: true });
	}

	private root(scope: SkillScope): string | null {
		return scope === "global" ? this.global : this.projectSkills;
	}
	private async safePath(
		root: string,
		slug: string,
		forWrite = false,
	): Promise<string> {
		if (!validSkillSlug(slug))
			throw new Error(
				"Skill id must contain a canonical lowercase hyphen slug.",
			);
		const rootResolved = resolve(root);
		const rootReal = await realpath(root).catch(() => rootResolved);
		const target = join(root, slug, "SKILL.md");
		if (!inside(rootResolved, resolve(target)))
			throw new Error("Skill path escapes its configured root.");
		const canonicalTarget = join(rootReal, slug, "SKILL.md");
		if (!inside(rootReal, canonicalTarget))
			throw new Error("Skill path escapes its configured root.");
		try {
			const actual = await realpath(target);
			if (!inside(rootReal, actual))
				throw new Error("Skill path escapes its configured root.");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		if (forWrite) {
			const parent = dirname(target);
			const parentReal = await realpath(parent).catch(() => rootReal);
			if (!inside(rootReal, parentReal))
				throw new Error("Skill path escapes its configured root.");
		}
		return target;
	}

	private async scan(
		root: string,
		scope: SkillScope,
		project?: string,
	): Promise<Location[]> {
		const results: Location[] = [];
		const walk = async (dir: string): Promise<void> => {
			let entries: Dirent<string>[];
			try {
				entries = await readdir(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries.sort((a, b) =>
				a.name.localeCompare(b.name),
			)) {
				if (entry.name.startsWith(".")) continue;
				const path = join(dir, entry.name);
				if (!entry.isDirectory()) continue;
				const file = join(path, "SKILL.md");
				try {
					const stat = await lstat(file);
					if (stat.isFile() && validSkillSlug(entry.name))
						results.push({
							skillId: skillId(scope, entry.name, project),
							scope,
							slug: entry.name,
							path: file,
							projectName: project,
						});
				} catch {
					/* no skill file */
				}
				await walk(path);
			}
		};
		await walk(root);
		return results;
	}

	private async locations(scope?: SkillScope): Promise<Location[]> {
		const result: Location[] = [];
		if (!scope || scope === "global")
			result.push(...(await this.scan(this.global, "global")));
		if (
			(!scope || scope === "project") &&
			this.projectSkills &&
			this.projectName
		)
			result.push(
				...(await this.scan(this.projectSkills, "project", this.projectName)),
			);
		return result;
	}
	private async location(id: string): Promise<Location | undefined> {
		const parsed = parseId(id);
		if (
			!parsed ||
			(parsed.scope === "project" && parsed.project !== this.projectName)
		)
			return undefined;
		return (await this.locations(parsed.scope)).find(
			(item) => item.skillId === id,
		);
	}
	private async read(location: Location): Promise<SkillDocument | null> {
		try {
			const parsed = parseFrontmatter(await readFile(location.path, "utf8"));
			if (!parsed) return null;
			const { meta, body } = parsed;
			return {
				...location,
				fileName: "SKILL.md",
				name: meta.name,
				description: meta.description.trim(),
				version: Number.parseInt(meta.version ?? "1", 10) || 1,
				created: meta.created ?? "",
				updated: meta.updated ?? "",
				body,
			};
		} catch {
			return null;
		}
	}
	async loadIndex(scope?: SkillScope): Promise<SkillIndex[]> {
		const docs = await Promise.all(
			(await this.locations(scope)).map((x) => this.read(x)),
		);
		return docs
			.filter((x): x is SkillDocument => Boolean(x))
			.map(({ body: _body, version: _version, ...index }) => index)
			.slice(0, 500);
	}
	async loadSkill(id: string): Promise<SkillDocument | null> {
		const location = await this.location(id);
		return location ? this.read(location) : null;
	}

	private async piSkillPaths(cwd?: string): Promise<string[]> {
		const paths = [this.piGlobal, join(agentRoot(), ".agents", "skills")];
		let current = resolve(cwd ?? process.cwd());
		const repositoryRoot = await gitRoot(current);
		while (true) {
			paths.push(
				join(current, ".pi", "skills"),
				join(current, ".agents", "skills"),
			);
			if (repositoryRoot ? current === repositoryRoot : current === "/") break;
			const parent = dirname(current);
			if (parent === current) break;
			current = parent;
		}
		return paths;
	}
	private async piSkillFiles(
		root: string,
		allowRootMarkdown: boolean,
	): Promise<string[]> {
		const files: string[] = [];
		const walk = async (directory: string, isRoot: boolean): Promise<void> => {
			let entries: Dirent<string>[];
			try {
				entries = await readdir(directory, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				if (entry.name.startsWith(".")) continue;
				const path = join(directory, entry.name);
				if (entry.isDirectory()) await walk(path, false);
				else if (
					entry.isFile() &&
					(entry.name === "SKILL.md" ||
						(isRoot && allowRootMarkdown && entry.name.endsWith(".md")))
				)
					files.push(path);
			}
		};
		await walk(root, true);
		return files;
	}
	private async piClaims(
		slug: string,
		cwd?: string,
	): Promise<string | undefined> {
		for (const root of await this.piSkillPaths(cwd)) {
			const allowRootMarkdown =
				resolve(root) === resolve(this.piGlobal) ||
				root.endsWith(join(".pi", "skills"));
			for (const path of await this.piSkillFiles(root, allowRootMarkdown)) {
				const parsed = parseFrontmatter(
					await readFile(path, "utf8").catch(() => ""),
				);
				if (parsed?.meta.name === slug) return path;
			}
		}
		return undefined;
	}
	private async conflict(
		slug: string,
		description: string,
		scope: SkillScope,
	): Promise<SkillResult | undefined> {
		const existing = (await this.locations(scope)).find((x) => x.slug === slug);
		if (existing)
			return {
				success: false,
				error: `Skill '${slug}' already exists (${existing.skillId}). Use 'patch' or 'update'.`,
				conflictType: "duplicate",
				similarSkillIds: [existing.skillId],
				suggestedAction: "patch",
			};
		if (scope === "global") {
			const claimed = await this.piClaims(slug, this.cwd);
			if (claimed)
				return {
					success: false,
					error: `Pi already loads a skill named '${slug}' from ${claimed}; choose another name.`,
					conflictType: "name-collision",
					suggestedAction: "rename",
				};
			const globals = (await this.loadIndex("global")).filter(
				(x) =>
					similarity(slug.replaceAll("-", " "), x.name.replaceAll("-", " ")) >=
					0.7,
			);
			for (const item of globals) {
				const descriptionSimilarity = similarity(description, item.description);
				if (descriptionSimilarity >= 0.75)
					return {
						success: false,
						error: `A similar global skill already exists (${item.skillId}); patch or update it.`,
						conflictType: "similar",
						similarSkillIds: [item.skillId],
						suggestedAction: "patch",
					};
				return {
					success: false,
					error: `A near-name global skill already exists (${item.skillId}); choose a clearer name.`,
					conflictType: "name-collision",
					similarSkillIds: [item.skillId],
					suggestedAction: "rename",
				};
			}
		} else {
			const claimed = await this.piClaims(slug, this.cwd);
			if (claimed)
				return {
					success: false,
					error: `Pi already loads a project skill named '${slug}' from ${claimed}; choose another name.`,
					conflictType: "name-collision",
					suggestedAction: "rename",
				};
		}
		const candidates = (await this.loadIndex(scope)).filter(
			(x) =>
				similarity(slug.replaceAll("-", " "), x.name.replaceAll("-", " ")) >=
				0.7,
		);
		for (const item of candidates) {
			const descriptionSimilarity = similarity(description, item.description);
			return descriptionSimilarity >= 0.75
				? {
						success: false,
						error: `A similar ${scope} skill already exists (${item.skillId}); patch or update it.`,
						conflictType: "similar",
						similarSkillIds: [item.skillId],
						suggestedAction: "patch",
					}
				: {
						success: false,
						error: `A near-name ${scope} skill already exists (${item.skillId}); choose a clearer name.`,
						conflictType: "name-collision",
						similarSkillIds: [item.skillId],
						suggestedAction: "rename",
					};
		}
		return undefined;
	}
	private async atomic(path: string, content: string): Promise<void> {
		const dir = dirname(path);
		await mkdir(dir, { recursive: true });
		const temp = join(
			dir,
			`.${basename(path)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		try {
			const file = await open(temp, "wx", 0o600);
			try {
				await file.writeFile(content, "utf8");
				await file.sync();
			} finally {
				await file.close();
			}
			await rename(temp, path);
		} catch (error) {
			await rm(temp, { force: true });
			throw error;
		}
	}
	private result(doc: SkillDocument, message: string): SkillResult {
		return {
			success: true,
			message,
			fileName: doc.fileName,
			skillId: doc.skillId,
			scope: doc.scope,
			path: doc.path,
		};
	}

	async create(
		name: string,
		description: string,
		body: string,
		scope: SkillScope,
	): Promise<SkillResult> {
		const slug = slugify(name);
		if (!validSkillSlug(slug) || slug !== name.trim().toLowerCase())
			return {
				success: false,
				error:
					"Skill name must be 1-64 lowercase letters, numbers, and single hyphens.",
			};
		if (!description.trim() || !body.trim())
			return {
				success: false,
				error: "Skill description and body are required.",
			};
		const root = this.root(scope);
		if (!root)
			return {
				success: false,
				error: "Project skills require an active project.",
			};
		const conflict = await this.conflict(slug, description, scope);
		if (conflict) return conflict;
		const scanner = scanContent(`${name}\n${description}\n${body}`);
		if (scanner) return { success: false, error: scanner };
		try {
			const path = await this.safePath(root, slug, true);
			const now = new Date().toISOString().slice(0, 10);
			await this.atomic(
				path,
				documentText({
					name: slug,
					description: description.trim(),
					version: 1,
					created: now,
					updated: now,
					body: body.trim(),
				}),
			);
			return {
				success: true,
				message: `Skill '${name}' created as a ${scope} skill.`,
				fileName: "SKILL.md",
				skillId: skillId(scope, slug, this.projectName),
				scope,
				path,
			};
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : "Skill write failed.",
			};
		}
	}

	async patch(id: string, section: string, raw: string): Promise<SkillResult> {
		const normalized = normalizePatch(section, raw);
		if ("error" in normalized)
			return { success: false, error: normalized.error };
		const scanner = scanContent(normalized.content);
		if (scanner) return { success: false, error: scanner };
		const doc = await this.loadSkill(id);
		if (!doc) return { success: false, error: `Skill '${id}' not found.` };
		const name = section
			.trim()
			.replace(/^##\s+/, "")
			.trim();
		const lines = doc.body.split("\n");
		const output: string[] = [];
		let found = false;
		for (let i = 0; i < lines.length; i++) {
			const header = lines[i].match(/^##\s+(.+?)\s*$/);
			if (header?.[1].toLowerCase() === name.toLowerCase()) {
				found = true;
				output.push(`## ${name}`, normalized.content);
				i++;
				while (i < lines.length && !/^##\s+/.test(lines[i])) i++;
				if (i < lines.length) {
					if (output.at(-1) !== "") output.push("");
					output.push(lines[i]);
				}
			} else output.push(lines[i]);
		}
		if (!found) output.push("", `## ${name}`, normalized.content);
		return this.writeUpdated(doc, output.join("\n").trim());
	}
	async edit(
		id: string,
		description: string,
		body: string,
	): Promise<SkillResult> {
		const doc = await this.loadSkill(id);
		if (!doc) return { success: false, error: `Skill '${id}' not found.` };
		const nextDescription = description.trim() || doc.description;
		const nextBody = body.trim() || doc.body;
		if (!description.trim() && !body.trim())
			return {
				success: false,
				error: "At least one of description or body is required.",
			};
		const scanner = scanContent(`${nextDescription}\n${nextBody}`);
		if (scanner) return { success: false, error: scanner };
		return this.writeUpdated(doc, nextBody, nextDescription);
	}
	private async writeUpdated(
		doc: SkillDocument,
		body: string,
		description = doc.description,
	): Promise<SkillResult> {
		const root = this.root(doc.scope);
		if (!root)
			return {
				success: false,
				error: "Project skills require an active project.",
			};
		try {
			const target = await this.safePath(
				root,
				parseId(doc.skillId)?.slug ?? "",
				true,
			);
			if (resolve(target) !== resolve(doc.path))
				return {
					success: false,
					error: "Skill path does not match its configured root.",
				};
			const updated = {
				...doc,
				description,
				body,
				version: doc.version + 1,
				updated: new Date().toISOString().slice(0, 10),
			};
			await this.atomic(target, documentText(updated));
			return this.result(
				{ ...doc, ...updated, path: target },
				`Skill '${doc.name}' updated.`,
			);
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : "Skill write failed.",
			};
		}
	}
	async delete(id: string): Promise<SkillResult> {
		const doc = await this.loadSkill(id);
		if (!doc) return { success: false, error: `Skill '${id}' not found.` };
		const parsed = parseId(id);
		const root = parsed ? this.root(parsed.scope) : null;
		if (!root)
			return {
				success: false,
				error: "Project skills require an active project.",
			};
		try {
			const target = await this.safePath(root, parsed?.slug ?? "");
			if (resolve(target) !== resolve(doc.path))
				return {
					success: false,
					error: "Skill path does not match its configured root.",
				};
			await rm(target);
			await rmdir(dirname(target)).catch(() => {});
			return this.result(doc, `Skill '${doc.name}' deleted.`);
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : "Skill delete failed.",
			};
		}
	}
}
