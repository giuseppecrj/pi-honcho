export interface StatusDetails {
	state: string;
	workspaceId?: string;
	userPeer?: string;
	aiPeer?: string;
	sessionId?: string;
	credentialSource?: "environment" | "Honcho config";
	workspaceSource?: "registry" | "default";
	repositoryMemory?: "enabled" | "disabled";
}

export function formatStatusDetails(details: StatusDetails): string {
	return [
		`Honcho: ${details.state}`,
		details.workspaceId ? `Workspace: ${details.workspaceId}` : undefined,
		details.workspaceSource
			? `Workspace source: ${details.workspaceSource}`
			: undefined,
		details.userPeer ? `User peer: ${details.userPeer}` : undefined,
		details.aiPeer ? `Pi peer: ${details.aiPeer}` : undefined,
		details.sessionId ? `Session: ${details.sessionId}` : undefined,
		details.credentialSource
			? `Credentials: ${details.credentialSource}`
			: undefined,
		details.repositoryMemory
			? `Repository memory: ${details.repositoryMemory}`
			: undefined,
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");
}
