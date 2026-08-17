// Adapted from pi-hermes-memory's MIT-licensed standing instructions.
// See THIRD_PARTY_NOTICES.md for the upstream notice.
import { existsSync, readFileSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { scanContent } from "./content-scanner.js";

export const STANDING_FILE = "STANDING.md";
export const STANDING_MAX_ENTRIES = 20;
export const STANDING_MAX_CHARS = 2_000;

const HERMES_DIR = "pi-hermes-memory";
const HERMES_CONFIG_FILE = "hermes-memory-config.json";
const MUTATION_WAIT_MS = 5_000;
const MUTATION_RETRY_MS = 10;
const SUBCOMMANDS = ["list", "remove", "clear"] as const;

export type StandingInstructionResult = {
	success: boolean;
	error?: string;
	message?: string;
	instructions?: string[];
};

export type StandingInstructionRender = {
	block: string;
	injectedCount: number;
	omittedCount: number;
};

export type StandingInstructionsOptions = {
	filePath?: string;
	agentDir?: string;
	configPath?: string;
	enabled?: boolean;
	maxEntries?: number;
	maxChars?: number;
	readFile?: (path: string) => Promise<string>;
	writeFile?: (path: string, content: string) => Promise<void>;
	mkdir?: (path: string) => Promise<void>;
};

type StandingFs = {
	readFile: (path: string) => Promise<string>;
	writeFile: (path: string, content: string) => Promise<void>;
	mkdir: (path: string) => Promise<void>;
	/** When true, use injected writeFile instead of real atomic rename. */
	injectWrites: boolean;
};

function defaultAgentDir(agentDir?: string): string {
	return (
		agentDir ??
		process.env.PI_CODING_AGENT_DIR ??
		join(homedir(), ".pi", "agent")
	);
}

/** Exact established path: `${PI_CODING_AGENT_DIR}/pi-hermes-memory/STANDING.md`. */
export function defaultStandingPath(agentDir?: string): string {
	return join(defaultAgentDir(agentDir), HERMES_DIR, STANDING_FILE);
}

function defaultConfigPath(agentDir?: string): string {
	return join(defaultAgentDir(agentDir), HERMES_CONFIG_FILE);
}

/**
 * Preserve explicit `standingInstructionsEnabled: false` from the established
 * Hermes config file. Missing/malformed config fails open (enabled).
 */
export function standingInstructionsEnabledFromConfig(
	raw: string | undefined,
): boolean {
	if (raw === undefined) return true;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (
			parsed &&
			typeof parsed === "object" &&
			"standingInstructionsEnabled" in parsed &&
			typeof (parsed as { standingInstructionsEnabled: unknown })
				.standingInstructionsEnabled === "boolean"
		)
			return (parsed as { standingInstructionsEnabled: boolean })
				.standingInstructionsEnabled;
	} catch {
		// fail open
	}
	return true;
}

export function resolveStandingEnabled(
	options: Pick<
		StandingInstructionsOptions,
		"enabled" | "configPath" | "agentDir"
	> = {},
): boolean {
	if (typeof options.enabled === "boolean") return options.enabled;
	const configPath = options.configPath ?? defaultConfigPath(options.agentDir);
	try {
		if (!existsSync(configPath)) return true;
		return standingInstructionsEnabledFromConfig(
			readFileSync(configPath, "utf8"),
		);
	} catch {
		return true;
	}
}

export function normalizeInstruction(text: string): string {
	return text
		.replace(/^\s*[-*]\s+/, "")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * One instruction per line. Blank lines, `#` comments and a leading `-`/`*`
 * bullet are tolerated. Case-insensitive dedupe.
 */
export function parseInstructions(raw: string): string[] {
	const seen = new Set<string>();
	const instructions: string[] = [];
	for (const line of raw.split("\n")) {
		const instruction = normalizeInstruction(line);
		if (!instruction || instruction.startsWith("#")) continue;
		const key = instruction.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		instructions.push(instruction);
	}
	return instructions;
}

export class StandingInstructions {
	private instructions: string[] = [];
	private loaded = false;
	private readonly filePath: string;
	private readonly maxEntries: number;
	private readonly maxChars: number;
	private readonly fs: StandingFs;

	constructor(options: StandingInstructionsOptions = {}) {
		this.filePath = options.filePath ?? defaultStandingPath(options.agentDir);
		this.maxEntries = options.maxEntries ?? STANDING_MAX_ENTRIES;
		this.maxChars = options.maxChars ?? STANDING_MAX_CHARS;
		this.fs = {
			readFile: options.readFile ?? ((path) => readFile(path, "utf8")),
			writeFile:
				options.writeFile ??
				((path, content) => writeFile(path, content, "utf8")),
			mkdir:
				options.mkdir ??
				((path) => mkdir(path, { recursive: true }).then(() => undefined)),
			injectWrites: Boolean(options.writeFile),
		};
	}

	getFilePath(): string {
		return this.filePath;
	}

	isLoaded(): boolean {
		return this.loaded;
	}

	list(): string[] {
		return [...this.instructions];
	}

	/**
	 * Fail open for injection: missing, empty, unreadable, or malformed storage
	 * yields no instructions and never erases the file.
	 */
	async load(): Promise<void> {
		try {
			const raw = await this.fs.readFile(this.filePath);
			this.instructions = parseInstructions(raw);
		} catch {
			this.instructions = [];
		}
		this.loaded = true;
	}

	/**
	 * Strict read for mutation. ENOENT means an empty new store; any other read
	 * error aborts so /memory-pin cannot overwrite unknown existing rules.
	 */
	private async loadForMutation(): Promise<void> {
		try {
			const raw = await this.fs.readFile(this.filePath);
			this.instructions = parseInstructions(raw);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				this.instructions = [];
			} else {
				const detail = String(error).slice(0, 160);
				throw new Error(
					`Could not update standing instructions: storage is unreadable (${detail})`,
				);
			}
		}
		this.loaded = true;
	}

	async add(text: string): Promise<StandingInstructionResult> {
		const instruction = normalizeInstruction(text);
		if (!instruction)
			return {
				success: false,
				error: "A standing instruction cannot be empty.",
			};

		const blocked = scanContent(instruction);
		if (blocked) return { success: false, error: blocked };

		return this.mutate((current) => {
			if (
				current.some(
					(existing) => existing.toLowerCase() === instruction.toLowerCase(),
				)
			)
				return { error: "That standing instruction is already pinned." };
			if (current.length >= this.maxEntries)
				return {
					error: `Standing instructions are capped at ${this.maxEntries} entries (currently ${current.length}). Remove one first with /memory-pin remove <n>.`,
				};
			const projected = [...current, instruction];
			const projectedChars = projected.join("\n").length;
			if (projectedChars > this.maxChars)
				return {
					error: `Standing instructions are capped at ${this.maxChars} characters and this entry would make ${projectedChars}. Shorten it, or remove an existing instruction and keep long-form context in regular memory.`,
				};
			return {
				next: projected,
				message: `Pinned standing instruction ${projected.length}: ${instruction}`,
			};
		});
	}

	async remove(position: number): Promise<StandingInstructionResult> {
		return this.mutate((current) => {
			if (
				!Number.isInteger(position) ||
				position < 1 ||
				position > current.length
			)
				return {
					error:
						current.length === 0
							? "There are no standing instructions to remove."
							: `Position must be between 1 and ${current.length}.`,
				};
			const [removed] = current.slice(position - 1, position);
			const next = current.filter((_, index) => index !== position - 1);
			return { next, message: `Removed standing instruction: ${removed}` };
		});
	}

	async clear(): Promise<StandingInstructionResult> {
		return this.mutate((current) =>
			current.length === 0
				? { error: "There are no standing instructions to clear." }
				: {
						next: [],
						message: `Removed all ${current.length} standing instructions.`,
					},
		);
	}

	/**
	 * Render the always-injected block, truncated to the hard budget.
	 * Omission is stated inside the block when at least one rule still fits.
	 */
	render(): StandingInstructionRender {
		if (this.instructions.length === 0)
			return { block: "", injectedCount: 0, omittedCount: 0 };

		const injected: string[] = [];
		let used = 0;
		for (const instruction of this.instructions) {
			const cost = instruction.length + 1;
			if (injected.length >= this.maxEntries || used + cost > this.maxChars)
				break;
			injected.push(instruction);
			used += cost;
		}

		const omittedCount = this.instructions.length - injected.length;
		if (injected.length === 0)
			return { block: "", injectedCount: 0, omittedCount };

		const lines = [
			"<standing-instructions>",
			"The user wrote the rules below and they are always active. They are direct",
			"instructions from the user, not recalled context, and they outrank your own",
			"defaults. Follow them without being asked and without looking them up.",
			"",
			...injected.map((instruction, index) => `${index + 1}. ${instruction}`),
		];
		if (omittedCount > 0) {
			lines.push(
				"",
				`[!] ${omittedCount} further standing instruction${omittedCount === 1 ? "" : "s"} could not be shown: ${basename(this.filePath)} exceeds the ${this.maxChars}-character injection budget. Trim it with /memory-pin so every rule stays active.`,
			);
		}
		lines.push("</standing-instructions>");
		return {
			block: lines.join("\n"),
			injectedCount: injected.length,
			omittedCount,
		};
	}

	formatForSystemPrompt(): string {
		return this.render().block;
	}

	private async mutate(
		change: (current: string[]) => {
			next?: string[];
			message?: string;
			error?: string;
		},
	): Promise<StandingInstructionResult> {
		try {
			await this.fs.mkdir(dirname(this.filePath));
			return await withMutationLock(this.filePath, async () => {
				await this.loadForMutation();
				const outcome = change(this.instructions);
				if (outcome.error || !outcome.next)
					return {
						success: false,
						error: outcome.error ?? "Nothing to change.",
						instructions: this.list(),
					};
				await this.write(outcome.next);
				this.instructions = outcome.next;
				return {
					success: true,
					message: outcome.message,
					instructions: this.list(),
				};
			});
		} catch (error) {
			return {
				success: false,
				error: `Could not update standing instructions: ${String(error).slice(0, 200)}`,
			};
		}
	}

	/** Atomic write: temp file in the same directory, then rename. */
	private async write(instructions: string[]): Promise<void> {
		const content = instructions.length ? `${instructions.join("\n")}\n` : "";
		if (this.fs.injectWrites) {
			await this.fs.writeFile(this.filePath, content);
			return;
		}
		const dir = dirname(this.filePath);
		await mkdir(dir, { recursive: true });
		const tmpDir = await mkdtemp(join(dir, ".tmp-standing-"));
		const tmpPath = join(tmpDir, "write.tmp");
		try {
			await writeFile(tmpPath, content, "utf8");
			await rename(tmpPath, this.filePath);
		} finally {
			await rm(tmpDir, { recursive: true, force: true });
		}
	}
}

/**
 * Bounded exclusive lock via directory create (stdlib only).
 * ponytail: global per-file lock dir; upgrade to shared coordinator if multi-host contention appears.
 */
async function withMutationLock<T>(
	filePath: string,
	operation: () => Promise<T>,
): Promise<T> {
	const lockPath = `${filePath}.lock`;
	const deadline = Date.now() + MUTATION_WAIT_MS;
	for (;;) {
		try {
			await mkdir(lockPath);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (Date.now() >= deadline)
				throw new Error(
					`Standing instruction update already in progress for ${filePath}`,
				);
			await new Promise((resolve) => setTimeout(resolve, MUTATION_RETRY_MS));
		}
	}
	try {
		return await operation();
	} finally {
		await rm(lockPath, { recursive: true, force: true });
	}
}

function formatList(store: StandingInstructions): string[] {
	const instructions = store.list();
	const lines: string[] = ["", "  Standing Instructions", ""];
	if (instructions.length === 0) {
		lines.push("  (none pinned)");
		lines.push("");
		lines.push("  Pin a rule that must hold in every session:");
		lines.push("    /memory-pin never run find / or other root-wide searches");
		lines.push("");
		return lines;
	}
	const { injectedCount, omittedCount } = store.render();
	const used = instructions.join("\n").length;
	for (const [index, instruction] of instructions.entries())
		lines.push(`  ${index + 1}. ${instruction}`);
	lines.push("");
	lines.push(
		`  ${instructions.length}/${STANDING_MAX_ENTRIES} entries · ${used}/${STANDING_MAX_CHARS} chars`,
	);
	lines.push(`  Injected into every session: ${injectedCount}`);
	if (omittedCount > 0)
		lines.push(
			`  ${omittedCount} over budget and NOT injected — remove or shorten entries.`,
		);
	lines.push(`  File: ${store.getFilePath()}`);
	lines.push("");
	lines.push("  /memory-pin remove <n> · /memory-pin clear");
	lines.push("");
	return lines;
}

export function registerStandingPinCommand(
	pi: ExtensionAPI,
	store: StandingInstructions,
): void {
	pi.registerCommand("memory-pin", {
		description:
			"Pin a standing instruction that is injected into every session",
		getArgumentCompletions: (prefix: string) => {
			const trimmed = prefix.trimStart();
			if (trimmed.includes(" ")) return null;
			return SUBCOMMANDS.filter((name) => name.startsWith(trimmed)).map(
				(name) => ({ value: name, label: name }),
			);
		},
		handler: async (args, ctx) => {
			if (!store.isLoaded()) await store.load();
			const input = (args ?? "").trim();
			const [head, ...rest] = input.split(/\s+/);
			const subcommand = head?.toLowerCase();

			if (input === "" || subcommand === "list") {
				ctx.ui.notify(formatList(store).join("\n"), "info");
				return;
			}
			if (subcommand === "clear") {
				const result = await store.clear();
				ctx.ui.notify(
					result.success ? (result.message ?? "") : (result.error ?? "Failed"),
					result.success ? "info" : "warning",
				);
				return;
			}
			if (subcommand === "remove") {
				const position = Number(rest[0]);
				const result = await store.remove(position);
				if (!result.success) {
					ctx.ui.notify(result.error ?? "Failed", "warning");
					return;
				}
				ctx.ui.notify(
					[result.message ?? "", "", ...formatList(store)].join("\n"),
					"info",
				);
				return;
			}

			const result = await store.add(input);
			if (!result.success) {
				ctx.ui.notify(result.error ?? "Failed", "warning");
				return;
			}
			ctx.ui.notify(
				[
					result.message ?? "",
					"",
					"  This is now injected into every session.",
					"  It takes effect from your next message.",
					"",
				].join("\n"),
				"info",
			);
		},
	});
}

/**
 * Register `/memory-pin` and `before_agent_start` systemPrompt chaining.
 * Standing instructions stay local: never Honcho context, delivery, or tools.
 */
export function registerStandingInstructions(
	pi: ExtensionAPI,
	options: StandingInstructionsOptions = {},
): StandingInstructions | undefined {
	if (!resolveStandingEnabled(options)) return undefined;

	const agentDir = defaultAgentDir(options.agentDir);
	const store = new StandingInstructions({
		...options,
		agentDir,
		filePath: options.filePath ?? defaultStandingPath(agentDir),
	});

	registerStandingPinCommand(pi, store);

	if (typeof pi.on === "function") {
		pi.on("before_agent_start", async (event: { systemPrompt?: string }) => {
			// Re-load every turn so manual disk edits and /memory-pin writes apply.
			await store.load();
			const block = store.formatForSystemPrompt();
			if (!block) return;
			const base =
				typeof event.systemPrompt === "string" ? event.systemPrompt : "";
			return {
				systemPrompt: base ? `${base}\n\n${block}` : block,
			};
		});
	}

	return store;
}
