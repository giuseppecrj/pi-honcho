export type HonchoCommand =
	| { kind: "help" }
	| { kind: "status" }
	| { kind: "init" }
	| { kind: "setup" }
	| { kind: "enable" }
	| { kind: "disable" }
	| { kind: "session-delete" }
	| { kind: "invalid" };

export interface HonchoCommandOperations {
	help(): Promise<void>;
	status(): Promise<void>;
	init(): Promise<void>;
	setup(): Promise<void>;
	enable(): Promise<void>;
	disable(): Promise<void>;
	sessionDelete(): Promise<void>;
	invalid(): void;
}

const commandNames = [
	"status",
	"init",
	"setup",
	"enable",
	"disable",
	"session delete",
] as const;

export function parseHonchoCommand(args: string): HonchoCommand {
	const input = args.trim();
	if (!input || input === "help") return { kind: "help" };
	if (input === "status") return { kind: "status" };
	if (input === "init") return { kind: "init" };
	if (input === "setup") return { kind: "setup" };
	if (input === "enable") return { kind: "enable" };
	if (input === "disable") return { kind: "disable" };
	if (input === "session delete") return { kind: "session-delete" };
	return { kind: "invalid" };
}

export async function dispatchHonchoCommand(
	args: string,
	operations: HonchoCommandOperations,
): Promise<void> {
	const command = parseHonchoCommand(args);
	switch (command.kind) {
		case "help":
			return operations.help();
		case "status":
			return operations.status();
		case "init":
			return operations.init();
		case "setup":
			return operations.setup();
		case "enable":
			return operations.enable();
		case "disable":
			return operations.disable();
		case "session-delete":
			return operations.sessionDelete();
		case "invalid":
			operations.invalid();
			return;
		default:
			return;
	}
}

export function commandArgumentCompletions(prefix: string) {
	const normalized = prefix.trimStart();
	const matches = commandNames.filter((name) => name.startsWith(normalized));
	return matches.length > 0
		? matches.map((value) => ({ value, label: value }))
		: null;
}

export function formatHonchoCommandHelp(status: string): string {
	return [
		"Honcho commands:",
		"/honcho status — show connection and repository status",
		"/honcho init — select or create this repository's workspace",
		"/honcho setup — change stable user and Pi identities",
		"/honcho enable — enable initialized repository memory",
		"/honcho disable — immediately stop this repository's memory",
		"/honcho session delete — delete the active repository session",
		"",
		status,
	].join("\n");
}
