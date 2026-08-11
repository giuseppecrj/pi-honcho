import { type FinalizedExchange, safeExchange } from "./exchange.js";

export interface HonchoExchangeClient {
	deliverExchange(
		sessionId: string,
		exchange: FinalizedExchange,
	): Promise<string[]>;
}

export interface HonchoRecoveryClient {
	reconcileOperationId(
		sessionId: string,
		operationId: string,
	): Promise<string[]>;
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
		while (this.pending.length > 0) {
			const pending = this.pending[0];
			try {
				let messageIds: string[] | undefined;
				if (pending.attempted) {
					const recoveryClient = this.recoveryClient;
					if (!recoveryClient) return;
					messageIds = await recoveryClient.reconcileOperationId(
						this.sessionId,
						pending.exchange.operationId,
					);
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
			} catch {
				return;
			}
		}
	}
}
