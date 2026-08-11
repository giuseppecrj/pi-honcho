import type { HonchoConfiguration } from "./config.js";

export const DEFAULT_RETRY_DELAY_MS = 30_000;

export type HonchoMemoryStatus =
	| { kind: "disabled"; reason: string }
	| { kind: "unconfigured"; reason: string }
	| { kind: "connecting" }
	| { kind: "connected" }
	| { kind: "retrying"; reason: string };

export interface HonchoMemoryClient {
	checkConnection(): Promise<void>;
}

export class HonchoStatusController {
	current: HonchoMemoryStatus;
	private retryTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private readonly configuration: HonchoConfiguration,
		private readonly createClient: () => HonchoMemoryClient,
		private readonly onStatus: (status: HonchoMemoryStatus) => void,
		private readonly retryDelayMs = DEFAULT_RETRY_DELAY_MS,
	) {
		this.current =
			configuration.kind === "configured"
				? { kind: "connecting" }
				: configuration;
	}

	start(): void {
		if (this.configuration.kind !== "configured") {
			this.publish(this.configuration);
			return;
		}

		this.clearRetry();
		this.publish({ kind: "connecting" });
		void this.probe();
	}

	private async probe(): Promise<void> {
		try {
			await this.createClient().checkConnection();
			this.publish({ kind: "connected" });
		} catch {
			this.publish({ kind: "retrying", reason: "Unable to reach Honcho" });
			this.retryTimer = setTimeout(() => this.start(), this.retryDelayMs);
			this.retryTimer.unref?.();
		}
	}

	stop(): void {
		this.clearRetry();
	}

	private clearRetry(): void {
		if (this.retryTimer !== undefined) {
			clearTimeout(this.retryTimer);
			this.retryTimer = undefined;
		}
	}

	private publish(status: HonchoMemoryStatus): void {
		this.current = status;
		this.onStatus(status);
	}
}
