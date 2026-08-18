export interface StatusDetails {
	state: string;
	workspaceId?: string;
	userPeer?: string;
	aiPeer?: string;
	sessionId?: string;
	credentialSource?: "environment" | "Honcho config";
	workspaceSource?: "registry" | "default";
	repositoryMemory?: "uninitialized" | "enabled" | "disabled";
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
		details.sessionId ? `Repository session: ${details.sessionId}` : undefined,
		details.credentialSource
			? `Credentials: ${details.credentialSource}`
			: undefined,
		details.repositoryMemory
			? `Repository memory: ${details.repositoryMemory}`
			: undefined,
		details.repositoryMemory === "uninitialized"
			? "Run /honcho init in a trusted repository to select a workspace."
			: undefined,
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");
}
