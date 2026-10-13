/** Stable Pi custom-entry protocol key; do not rename. */
export const WORKSPACE_RESET_ENTRY_KEY = "pi-honcho-memory.reset";

export type WorkspaceResetEntry =
	| { kind: "intent"; workspaceId: string }
	| { kind: "complete"; workspaceId: string }
	| { kind: "uncertain"; workspaceId: string }
	| { kind: "failed"; workspaceId: string };

export interface TimedResetEntry {
	data: WorkspaceResetEntry;
	timestamp: string;
}

export function isWorkspaceResetEntry(
	value: unknown,
): value is WorkspaceResetEntry {
	if (!value || typeof value !== "object") return false;
	const entry = value as { kind?: unknown; workspaceId?: unknown };
	return (
		typeof entry.workspaceId === "string" &&
		["intent", "complete", "uncertain", "failed"].includes(
			typeof entry.kind === "string" ? entry.kind : "",
		)
	);
}

export function resetConfirmation(workspaceId: string): string {
	return `DELETE ${workspaceId}`;
}

/**
 * Breaks ties between reset entries that share the latest timestamp. Startup
 * reads session files in directory order, not Pi's activity order, so a tie
 * must resolve the same way for every input order. It resolves
 * conservatively: an unresolved reset (`intent`/`uncertain`) blocks delivery
 * over `complete`, and `complete` gates recall until recreation over
 * `failed`. Ranking applies only among equal timestamps; a newer entry always
 * wins.
 */
const RESET_TIE_RANK: Record<WorkspaceResetEntry["kind"], number> = {
	failed: 0,
	complete: 1,
	intent: 2,
	uncertain: 2,
};

function supersedes(entry: TimedResetEntry, current: TimedResetEntry): boolean {
	return (
		entry.timestamp > current.timestamp ||
		(entry.timestamp === current.timestamp &&
			RESET_TIE_RANK[entry.data.kind] > RESET_TIE_RANK[current.data.kind])
	);
}

export function resetRecovery(
	workspaceId: string,
	entries: readonly TimedResetEntry[],
): { blocked: boolean; completedAt?: string } {
	const latest = entries
		.filter((entry) => entry.data.workspaceId === workspaceId)
		.reduce<TimedResetEntry | undefined>(
			(current, entry) =>
				!current || supersedes(entry, current) ? entry : current,
			undefined,
		);
	if (!latest) return { blocked: false };
	if (latest.data.kind === "complete") {
		return { blocked: false, completedAt: latest.timestamp };
	}
	if (latest.data.kind === "failed") return { blocked: false };
	return { blocked: true };
}

export function deletionOutcomeIsUncertain(error: unknown): boolean {
	if (!error || typeof error !== "object" || !("status" in error)) return true;
	const { status } = error as { status?: unknown };
	return typeof status !== "number" || status === 429 || status >= 500;
}
