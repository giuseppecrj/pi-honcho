import { type FinalizedExchange, safeExchange } from "./exchange.js";

/** Stable Pi custom-entry protocol key; do not rename. */
export const DELIVERY_LEDGER_KEY = "pi-honcho-memory.delivery";

export type DeliveryLedgerEntry =
	| { kind: "pending"; exchange: FinalizedExchange }
	| { kind: "acknowledged"; operationId: string; messageIds: string[] };

export interface DeliveryLedgerSessionEntry {
	type?: string;
	customType?: string;
	data?: unknown;
	timestamp?: string;
}

export interface DeliveryLedgerRecovery {
	completedAt?: string;
}

export interface DeliveryLedger {
	acknowledgedOperationIds: Set<string>;
	acknowledgements: Extract<DeliveryLedgerEntry, { kind: "acknowledged" }>[];
	replayableExchanges: FinalizedExchange[];
}

export function deliveryLedger(
	entries: readonly DeliveryLedgerSessionEntry[],
	recovery: DeliveryLedgerRecovery = {},
): DeliveryLedger {
	const records = entries.flatMap((entry) => {
		if (
			entry.type !== "custom" ||
			entry.customType !== DELIVERY_LEDGER_KEY ||
			!isDeliveryLedgerEntry(entry.data)
		)
			return [];
		return [{ data: entry.data, timestamp: entry.timestamp }];
	});
	const acknowledgements = records.flatMap(({ data }) =>
		data.kind === "acknowledged" ? [data] : [],
	);
	const acknowledgedOperationIds = new Set(
		acknowledgements.map((acknowledgement) => acknowledgement.operationId),
	);
	const replayedOperationIds = new Set<string>();
	const completedAt = isTimestamp(recovery.completedAt)
		? Date.parse(recovery.completedAt)
		: undefined;
	const replayableExchanges = records.flatMap(({ data, timestamp }) => {
		if (
			data.kind !== "pending" ||
			!isTimestamp(timestamp) ||
			acknowledgedOperationIds.has(data.exchange.operationId) ||
			(completedAt !== undefined && Date.parse(timestamp) <= completedAt) ||
			replayedOperationIds.has(data.exchange.operationId)
		)
			return [];
		replayedOperationIds.add(data.exchange.operationId);
		return [data.exchange];
	});
	return { acknowledgedOperationIds, acknowledgements, replayableExchanges };
}

function isDeliveryLedgerEntry(value: unknown): value is DeliveryLedgerEntry {
	if (!value || typeof value !== "object" || !("kind" in value)) return false;
	if (value.kind === "acknowledged")
		return (
			"operationId" in value &&
			typeof value.operationId === "string" &&
			"messageIds" in value &&
			Array.isArray(value.messageIds) &&
			value.messageIds.every((id) => typeof id === "string")
		);
	if (value.kind !== "pending" || !("exchange" in value)) return false;
	const exchange = value.exchange as Partial<FinalizedExchange>;
	return (
		typeof exchange?.operationId === "string" &&
		Boolean(exchange.operationId.trim()) &&
		typeof exchange.userText === "string" &&
		Boolean(exchange.userText.trim()) &&
		typeof exchange.assistantText === "string" &&
		Boolean(exchange.assistantText.trim()) &&
		Boolean(safeExchange(exchange as FinalizedExchange))
	);
}

function isTimestamp(value: unknown): value is string {
	return typeof value === "string" && !Number.isNaN(Date.parse(value));
}
