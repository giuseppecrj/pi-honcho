import { debugTimer } from "../debug.js";
import { type FinalizedExchange, safeExchange } from "./exchange.js";

export interface HonchoExchangeClient {
	deliverExchange(
		sessionId: string,
		exchange: FinalizedExchange,
	): Promise<string[]>;
}

export interface HonchoRecoveryClient {
	reconcileOperationIds(
		sessionId: string,
		operationIds: readonly string[],
	): Promise<ReadonlyMap<string, string[]>>;
}

export interface RemoteAcknowledgement {
	operationId: string;
	messageIds: string[];
}

/**
 * Serializes remote writes without making Pi's prompt path wait for Honcho.
 * Failed writes remain queued so a later lifecycle flush can retry them with
 * the same operation ID.
 */
export class ExchangeDeliveryQueue {
	private readonly pending: Array<{
		exchange: FinalizedExchange;
		attempted: boolean;
	}> = [];
	private flushing: Promise<void> | undefined;

	constructor(
		private readonly client: HonchoExchangeClient,
		private readonly sessionId: string,
		private readonly acknowledge: (
			acknowledgement: RemoteAcknowledgement,
		) => void | Promise<void>,
		private readonly recoveryClient?: HonchoRecoveryClient,
	) {}

	enqueue(exchange: FinalizedExchange): boolean {
		return this.enqueueExchange(exchange, false);
	}

	enqueueRecovery(exchange: FinalizedExchange): boolean {
		return this.recoveryClient ? this.enqueueExchange(exchange, true) : false;
	}

	/** Drops locally queued exchanges; a request already handed to Honcho may finish. */
	discardPending(): void {
		this.pending.length = 0;
	}

	flush(): Promise<void> {
		if (this.flushing) return this.flushing;
		this.flushing = this.deliverPending().finally(() => {
			this.flushing = undefined;
		});
		return this.flushing;
	}

	flushWithin(timeoutMs: number): Promise<boolean> {
		const flush = this.flush();
		let timeout: ReturnType<typeof setTimeout> | undefined;
		return Promise.race([
			flush.then(() => true),
			new Promise<boolean>((resolve) => {
				timeout = setTimeout(() => resolve(false), timeoutMs);
				timeout.unref?.();
			}),
		]).then((completed) => {
			if (timeout) clearTimeout(timeout);
			return completed;
		});
	}

	private enqueueExchange(
		exchange: FinalizedExchange,
		attempted: boolean,
	): boolean {
		const safe = safeExchange(exchange);
		if (!safe) return false;
		if (
			!this.pending.some(
				(item) => item.exchange.operationId === safe.operationId,
			)
		) {
			this.pending.push({ exchange: safe, attempted });
		}
		return true;
	}

	private async deliverPending(): Promise<void> {
		const done = debugTimer("honcho:remote", "delivery.flush", {
			pending: this.pending.length,
		});
		let delivered = 0;
		let reconcileFetches = 0;
		// One remote history fetch per flush resolves every attempted exchange.
		let reconciled:
			| {
					requested: ReadonlySet<string>;
					messageIds: ReadonlyMap<string, string[]>;
			  }
			| undefined;
		while (this.pending.length > 0) {
			const pending = this.pending[0];
			try {
				let messageIds: string[] | undefined;
				if (pending.attempted) {
					const recoveryClient = this.recoveryClient;
					if (!recoveryClient) return;
					const operationId = pending.exchange.operationId;
					if (!reconciled?.requested.has(operationId)) {
						const operationIds = this.pending
							.filter((item) => item.attempted)
							.map((item) => item.exchange.operationId);
						reconcileFetches += 1;
						reconciled = {
							requested: new Set(operationIds),
							messageIds: await recoveryClient.reconcileOperationIds(
								this.sessionId,
								operationIds,
							),
						};
					}
					messageIds = reconciled.messageIds.get(operationId);
				}
				if (!messageIds?.length) {
					pending.attempted = true;
					messageIds = await this.client.deliverExchange(
						this.sessionId,
						pending.exchange,
					);
				}
				const acknowledged = messageIds;
				await this.acknowledge({
					operationId: pending.exchange.operationId,
					messageIds: acknowledged,
				});
				this.pending.shift();
				delivered += 1;
			} catch {
				done({ delivered, failed: this.pending.length, reconcileFetches });
				return;
			}
		}
		done({ delivered, failed: 0, reconcileFetches });
	}
}
