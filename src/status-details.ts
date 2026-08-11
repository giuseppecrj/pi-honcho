export interface StatusDetails {
	state: string;
	workspaceId?: string;
	userPeer?: string;
	aiPeer?: string;
	sessionId?: string;
	credentialSource?: "environment" | "Honcho config";
	workspaceSource?:
		| "environment"
		| "project policy"
		| "Honcho config"
		| "default"
		| "configuration";
	projectPolicy?: string;
	projectPolicyPath?: string;
	projectPolicyReason?: string;
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
		details.projectPolicy
			? `Project policy: ${details.projectPolicy}`
			: undefined,
		details.projectPolicyPath
			? `Policy path: ${details.projectPolicyPath}`
			: undefined,
		details.projectPolicyReason
			? `Policy reason: ${details.projectPolicyReason}`
			: undefined,
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");
}
