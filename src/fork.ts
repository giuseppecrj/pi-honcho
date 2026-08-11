import { deliveryLedger } from "./delivery-ledger.js";

/** Stable Pi custom-entry protocol keys; do not rename. */
export const FORK_LEDGER_KEY = "pi-honcho-memory.fork";
export const SESSION_MAPPING_KEY = "pi-honcho-memory.session";

export type ForkLedgerEntry =
	| { kind: "acknowledged"; operationId: string; messageIds: string[] }
	| {
			kind: "fork";
			targetEntryId: string;
			remoteSessionId?: string;
	  };

export interface ForkSessionEntry {
	id: string;
	type?: string;
	customType?: string;
	data?: unknown;
	timestamp?: string;
}

export interface ForkStartup {
	repositorySessionId: string;
	piSessionId: string;
	isFork: boolean;
	branch: ForkSessionEntry[];
	sourceEntries?: ForkSessionEntry[];
	handoffs: InMemoryForkHandoffs;
}

export class InMemoryForkHandoffs {
	private readonly sessionIds = new Map<string, string | undefined>();

	record(targetEntryId: string, remoteSessionId: string | undefined): void {
		this.sessionIds.set(targetEntryId, remoteSessionId);
	}

	consume(targetEntryId: string): string | undefined {
		const remoteSessionId = this.sessionIds.get(targetEntryId);
		this.sessionIds.delete(targetEntryId);
		return remoteSessionId;
	}
}

export function isolatedRemoteSessionId(
	repositorySessionId: string,
	piSessionId: string,
): string {
	return `${repositorySessionId}-fork-${piSessionId}`;
}

export function forkLedger(entries: ForkSessionEntry[]): ForkLedgerEntry[] {
	const ledger: ForkLedgerEntry[] = [
		...deliveryLedger(entries).acknowledgements,
	];
	for (const entry of entries) {
		if (entry.type !== "custom") continue;
		if (entry.customType === FORK_LEDGER_KEY && isForkEntry(entry.data))
			ledger.push(entry.data);
	}
	return ledger;
}

export function resolveRemoteSessionForStartup({
	repositorySessionId,
	piSessionId,
	isFork,
	branch,
	sourceEntries,
	handoffs,
}: ForkStartup): string {
	if (!isFork) return sessionMapping(branch) ?? repositorySessionId;
	let targetEntryId: string | undefined;
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		if (branch[index]?.type !== "label") {
			targetEntryId = branch[index]?.id;
			break;
		}
	}
	const clonedSessionId = targetEntryId
		? resolveForkRemoteSession(forkLedger(sourceEntries ?? []), targetEntryId)
		: undefined;
	if (clonedSessionId) return clonedSessionId;
	if (targetEntryId) {
		const inMemorySessionId = handoffs.consume(targetEntryId);
		if (inMemorySessionId) return inMemorySessionId;
	}
	return isolatedRemoteSessionId(repositorySessionId, piSessionId);
}

export function resolveForkRemoteSession(
	ledger: ForkLedgerEntry[],
	targetEntryId: string,
): string | undefined {
	for (let index = ledger.length - 1; index >= 0; index -= 1) {
		const entry = ledger[index];
		if (entry?.kind === "fork" && entry.targetEntryId === targetEntryId)
			return entry.remoteSessionId;
	}
	return undefined;
}

export function latestRemoteMessageAtFork(
	branch: ForkSessionEntry[],
	ledger: ForkLedgerEntry[],
	entryId: string,
	position: "before" | "at",
): string | undefined {
	const forkIndex = branch.findIndex((entry) => entry.id === entryId);
	if (forkIndex < 0) return undefined;
	const includedEntries = new Set(
		branch
			.slice(0, position === "at" ? forkIndex + 1 : forkIndex)
			.map((entry) => entry.id),
	);
	for (let index = ledger.length - 1; index >= 0; index -= 1) {
		const entry = ledger[index];
		if (entry?.kind !== "acknowledged") continue;
		const piEntryId = entry.operationId.startsWith("pi-")
			? entry.operationId.slice(3)
			: entry.operationId;
		if (includedEntries.has(piEntryId)) return entry.messageIds.at(-1);
	}
	return undefined;
}

function sessionMapping(entries: ForkSessionEntry[]): string | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (
			entry?.type === "custom" &&
			entry.customType === SESSION_MAPPING_KEY &&
			isSessionMapping(entry.data)
		)
			return entry.data.remoteSessionId;
	}
	return undefined;
}

function isForkEntry(value: unknown): value is ForkLedgerEntry {
	return (
		value !== null &&
		typeof value === "object" &&
		"kind" in value &&
		value.kind === "fork" &&
		"targetEntryId" in value &&
		typeof value.targetEntryId === "string" &&
		(!("remoteSessionId" in value) || typeof value.remoteSessionId === "string")
	);
}

function isSessionMapping(
	value: unknown,
): value is { remoteSessionId: string } {
	return (
		value !== null &&
		typeof value === "object" &&
		"remoteSessionId" in value &&
		typeof value.remoteSessionId === "string"
	);
}
