import { readFile } from "node:fs/promises"; // pi-lens-ignore: find-import-file-without-extension
import { dirname, join, relative, resolve } from "node:path";

import { isValidHonchoWorkspaceId } from "./config.js";

const POLICY_FILE = join(".pi", "honcho-memory.json");
const MAX_WORKSPACE_ID_LENGTH = 128;

type WorkspaceSource = "configuration" | "project policy";

export interface ProjectHonchoPolicy {
	enabled: boolean;
	workspaceId?: string;
	workspaceSource: WorkspaceSource;
	policyPath?: string;
	reason?: string;
}

function disabled(
	path: string,
	reason: string,
	workspaceId?: string,
): ProjectHonchoPolicy {
	return {
		enabled: false,
		...(workspaceId ? { workspaceId } : {}),
		workspaceSource: "project policy",
		policyPath: path,
		reason,
	};
}

function workspaceId(value: unknown): string | undefined {
	return isValidHonchoWorkspaceId(value) &&
		value.length <= MAX_WORKSPACE_ID_LENGTH
		? value
		: undefined;
}

export function isValidProjectHonchoPolicy(policy: unknown): boolean {
	if (!policy || typeof policy !== "object" || Array.isArray(policy))
		return false;
	const entries = Object.entries(policy);
	if (entries.some(([key]) => key !== "enabled" && key !== "workspace"))
		return false;
	const enabled = (policy as { enabled?: unknown }).enabled;
	if (typeof enabled !== "boolean") return false;
	const workspace = (policy as { workspace?: unknown }).workspace;
	const resolvedWorkspace = workspaceId(workspace);
	return workspace === undefined ? !enabled : Boolean(resolvedWorkspace);
}

/** Resolves one trusted project's non-secret policy without reading its filesystem. */
export function resolveProjectHonchoPolicy(
	trusted: boolean,
	policy: unknown,
	path: string,
): ProjectHonchoPolicy {
	if (!trusted) return { enabled: true, workspaceSource: "configuration" };
	if (!policy || typeof policy !== "object" || Array.isArray(policy))
		return disabled(path, "Project policy must be a JSON object");

	const entries = Object.entries(policy);
	if (entries.some(([key]) => key !== "enabled" && key !== "workspace"))
		return disabled(path, "Project policy contains unsupported fields");
	const enabled = (policy as { enabled?: unknown }).enabled;
	if (typeof enabled !== "boolean")
		return disabled(path, "Project policy must set enabled to true or false");
	const workspace = (policy as { workspace?: unknown }).workspace;
	const resolvedWorkspace = workspaceId(workspace);
	if (workspace !== undefined && !resolvedWorkspace)
		return disabled(
			path,
			`Project policy workspace must use only letters, digits, underscores, or hyphens and be at most ${MAX_WORKSPACE_ID_LENGTH} characters`,
		);
	if (enabled && !resolvedWorkspace)
		return disabled(path, "Enabled project policy must provide a workspace");
	return enabled
		? {
				enabled: true,
				workspaceId: resolvedWorkspace,
				workspaceSource: "project policy",
				policyPath: path,
			}
		: disabled(path, "Disabled by trusted project policy", resolvedWorkspace);
}

async function readPolicy(path: string): Promise<unknown | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as unknown;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function policyDirectories(cwd: string, gitRoot?: string): string[] {
	if (!gitRoot) return [cwd];
	const root = resolve(gitRoot);
	const current = resolve(cwd);
	if (relative(root, current).startsWith("..")) return [cwd];
	const directories: string[] = [];
	for (let directory = current; ; directory = dirname(directory)) {
		directories.unshift(directory);
		if (directory === root) break;
	}
	return directories;
}

/**
 * Discovers trusted policy scopes. Git repositories inherit root-to-leaf;
 * outside Git only an explicit current-directory policy is considered.
 */
export async function discoverProjectHonchoPolicy(
	cwd: string,
	trusted: boolean,
	gitRoot: (cwd: string) => Promise<string | undefined>,
): Promise<ProjectHonchoPolicy> {
	if (!trusted) return { enabled: true, workspaceSource: "configuration" };
	const directories = policyDirectories(cwd, await gitRoot(cwd));
	let effective: ProjectHonchoPolicy = {
		enabled: true,
		workspaceSource: "configuration",
	};
	for (const directory of directories) {
		const path = join(directory, POLICY_FILE);
		try {
			const policy = await readPolicy(path);
			if (policy === undefined) continue;
			const resolution = resolveProjectHonchoPolicy(true, policy, path);
			if (!resolution.enabled) return resolution;
			effective = resolution;
		} catch {
			return disabled(
				path,
				"Project policy could not be read or parsed as JSON",
			);
		}
	}
	return effective;
}

/** Compatibility helper for legacy callers resolving one in-memory policy. */
export function projectHonchoEnabled(
	trusted: boolean,
	policy: unknown,
): boolean {
	return resolveProjectHonchoPolicy(trusted, policy, "project policy").enabled;
}
