import { resolve } from "node:path";

export interface HonchoRegistry {
	version: 1;
	identity: {
		userPeer: string;
		aiPeer: string;
	};
	repositories: Record<string, RepositoryMemoryEntry>;
}

export interface RepositoryMemoryEntry {
	workspaceId: string;
	enabled: boolean;
}

export function initialRegistry(): HonchoRegistry {
	return {
		version: 1,
		identity: { userPeer: "user", aiPeer: "pi" },
		repositories: {},
	};
}

export function canonicalRepositoryKey(cwd: string, origin?: string): string {
	if (!origin) return `directory:${resolve(cwd)}`;
	const normalized = origin
		.trim()
		.replace(/^git@([^:]+):/, "$1/")
		.replace(/^(?:https?|ssh|git):\/\/(?:git@)?/, "")
		.replace(/\.git\/?$/, "");
	const [host, ...path] = normalized.split("/");
	return `origin:${host?.toLowerCase()}/${path.join("/")}`;
}

export function resolveRepositoryEntry(
	registry: HonchoRegistry,
	repositoryKey: string,
): RepositoryMemoryEntry | undefined {
	return registry.repositories[repositoryKey];
}

export function updateRepositoryEntry(
	registry: HonchoRegistry,
	repositoryKey: string,
	entry: RepositoryMemoryEntry,
): HonchoRegistry {
	return {
		...registry,
		repositories: { ...registry.repositories, [repositoryKey]: entry },
	};
}
