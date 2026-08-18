import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"; // pi-lens-ignore: find-import-file-without-extension
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { HONCHO_HOST_NAME, isValidHonchoWorkspaceId } from "./config.js";
import {
	discoverProjectHonchoPolicy,
	isValidProjectHonchoPolicy,
} from "./project-policy.js";
import { type HonchoRegistry, initialRegistry } from "./registry.js";

const execFileAsync = promisify(execFile);

async function loadJson(path: string): Promise<unknown> {
	try {
		const content = await readFile(path, "utf8");
		const parsed: unknown = JSON.parse(content);
		return parsed !== null && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

function configPath(): string {
	return join(homedir(), ".honcho", "config.json");
}

function registryPath(): string {
	return join(
		process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
		"honcho-memory.json",
	);
}

export async function loadHonchoConfigFile(): Promise<unknown> {
	return loadJson(configPath());
}

function isRegistry(value: unknown): value is HonchoRegistry {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const registry = value as Partial<HonchoRegistry>;
	return (
		registry.version === 1 &&
		Boolean(registry.identity) &&
		typeof registry.identity?.userPeer === "string" &&
		Boolean(registry.identity.userPeer.trim()) &&
		typeof registry.identity?.aiPeer === "string" &&
		Boolean(registry.identity.aiPeer.trim()) &&
		Boolean(registry.repositories) &&
		Object.values(registry.repositories ?? {}).every(
			(entry) =>
				Boolean(entry) &&
				typeof entry.workspaceId === "string" &&
				isValidHonchoWorkspaceId(entry.workspaceId) &&
				typeof entry.enabled === "boolean",
		)
	);
}

export async function loadHonchoRegistry(): Promise<
	HonchoRegistry | undefined
> {
	try {
		const registry: unknown = JSON.parse(
			await readFile(registryPath(), "utf8"),
		);
		return isRegistry(registry) ? registry : undefined;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT"
			? initialRegistry()
			: undefined;
	}
}

export async function saveHonchoRegistry(
	registry: HonchoRegistry,
): Promise<boolean> {
	return isRegistry(registry) && writeJsonAtomically(registryPath(), registry);
}

export async function repositoryOrigin(
	cwd: string,
): Promise<string | undefined> {
	try {
		const { stdout } = await execFileAsync(
			"git",
			["config", "--get", "remote.origin.url"],
			{
				cwd,
			},
		);
		return stdout.trim() || undefined;
	} catch {
		return undefined;
	}
}

async function gitRoot(cwd: string): Promise<string | undefined> {
	try {
		const { stdout } = await execFileAsync(
			"git",
			["rev-parse", "--show-toplevel"],
			{
				cwd,
			},
		);
		return stdout.trim() || undefined;
	} catch {
		return undefined;
	}
}

export function loadProjectHonchoPolicy(cwd: string, trusted: boolean) {
	return discoverProjectHonchoPolicy(cwd, trusted, gitRoot);
}

export async function readProjectHonchoPolicyFile(
	cwd: string,
): Promise<unknown | undefined> {
	try {
		return JSON.parse(
			await readFile(join(cwd, ".pi", "honcho-memory.json"), "utf8"),
		) as unknown;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		return null;
	}
}

async function writeJsonAtomically(
	path: string,
	value: object,
): Promise<boolean> {
	const directory = dirname(path);
	const temporaryPath = join(directory, `.${process.pid}.${randomUUID()}.tmp`);
	try {
		await mkdir(directory, { recursive: true });
		await writeFile(
			temporaryPath,
			`${JSON.stringify(value, null, 2)}\n`,
			"utf8",
		);
		await rename(temporaryPath, path);
		return true;
	} catch {
		await rm(temporaryPath, { force: true }).catch(() => undefined);
		return false;
	}
}

export async function saveProjectHonchoPolicy(
	cwd: string,
	policy: { enabled: boolean; workspace?: string },
): Promise<string | undefined> {
	if (!isValidProjectHonchoPolicy(policy)) return undefined;
	const path = join(cwd, ".pi", "honcho-memory.json");
	return (await writeJsonAtomically(path, policy)) ? path : undefined;
}

export async function saveHonchoSettings(settings: {
	workspaceId: string;
	peerName?: string;
	aiPeer?: string;
}): Promise<boolean> {
	if (!isValidHonchoWorkspaceId(settings.workspaceId)) return false;
	try {
		const existing = await loadHonchoConfigFile();
		const config = existing && typeof existing === "object" ? existing : {};
		const hosts =
			"hosts" in config && config.hosts && typeof config.hosts === "object"
				? config.hosts
				: {};
		const hostRecord = hosts as Record<string, unknown>;
		const priorHost = hostRecord[HONCHO_HOST_NAME];
		const host = priorHost && typeof priorHost === "object" ? priorHost : {};
		const next = {
			...config,
			hosts: {
				...hosts,
				[HONCHO_HOST_NAME]: {
					...host,
					workspaceId: settings.workspaceId,
					...(settings.peerName ? { peerName: settings.peerName } : {}),
					...(settings.aiPeer ? { aiPeer: settings.aiPeer } : {}),
				},
			},
		};
		return writeJsonAtomically(configPath(), next);
	} catch {
		return false;
	}
}
