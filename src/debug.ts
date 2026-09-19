// Environment-gated provenance logging for pi-honcho. This is a TUI extension, so entries
// are appended to a log file instead of stdout/stderr, and the logger must
// never throw. Log only non-sensitive metadata: counts, durations, booleans,
// IDs, and paths — never prompts, memory content, instructions, or tokens.
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type DebugMeta = Record<string, string | number | boolean | undefined>;

const noop = (): void => {};

let preparedDir: string | undefined;

export function debugEnabled(): boolean {
	const value = process.env.HONCHO_DEBUG;
	return value === "1" || value === "true";
}

function debugLogPath(): string {
	const custom = process.env.HONCHO_DEBUG_FILE?.trim();
	if (custom) return custom;
	const agentDir =
		process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	return join(agentDir, "pi-honcho", "debug.log");
}

export function debugLog(
	component: string,
	event: string,
	meta?: DebugMeta,
): void {
	if (!debugEnabled()) return;
	try {
		const path = debugLogPath();
		const dir = dirname(path);
		if (preparedDir !== dir) {
			mkdirSync(dir, { recursive: true });
			preparedDir = dir;
		}
		let line = `${new Date().toISOString()} [${component}] ${event}`;
		if (meta) {
			for (const [key, value] of Object.entries(meta))
				if (value !== undefined) line += ` ${key}=${value}`;
		}
		appendFileSync(path, `${line}\n`);
	} catch {
		// Debug logging must never break the extension.
	}
}

/** Logs `<event>.begin` now and `<event>.done ms=<delta>` when invoked. */
export function debugTimer(
	component: string,
	event: string,
	beginMeta?: DebugMeta,
): (meta?: DebugMeta) => void {
	if (!debugEnabled()) return noop;
	const start = Date.now();
	debugLog(component, `${event}.begin`, beginMeta);
	return (meta) =>
		debugLog(component, `${event}.done`, { ms: Date.now() - start, ...meta });
}
