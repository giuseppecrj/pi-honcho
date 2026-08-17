export interface ProjectMemoryPrivacyBoundary {
	clearRecall(): void;
	discardPendingDelivery(): void;
	clearRemoteClients(): void;
	stopConnection(): void;
	hideTools(): void;
}

/**
 * Applies an immediate local privacy boundary. Remote work already accepted by
 * Honcho can finish, but no cached recall, queued delivery, or tools survive.
 */
export function disableProjectMemoryNow(
	boundary: ProjectMemoryPrivacyBoundary,
): void {
	boundary.clearRecall();
	boundary.discardPendingDelivery();
	boundary.clearRemoteClients();
	boundary.stopConnection();
	boundary.hideTools();
}
