export type HonchoCommand =
	| { kind: "help" }
	| { kind: "status" }
	| { kind: "init" }
	| { kind: "setup" }
	| { kind: "enable" }
	| { kind: "disable" }
	| { kind: "forget"; args: string }
	| { kind: "workspace-reset" }
	| { kind: "invalid" };

export interface HonchoCommandOperations {
	help(): Promise<void>;
	status(): Promise<void>;
	init(): Promise<void>;
	setup(): Promise<void>;
	enable(): Promise<void>;
	disable(): Promise<void>;
	forget(args: string): Promise<void>;
	workspaceReset(): Promise<void>;
	invalid(): void;
}

const commandNames = [
	"status",
	"init",
	"setup",
	"enable",
	"disable",
	"forget",
	"workspace-reset",
] as const;

export function parseHonchoCommand(args: string): HonchoCommand {
	const input = args.trim();
	if (!input || input === "help") return { kind: "help" };
	if (input === "status") return { kind: "status" };
	if (input === "init") return { kind: "init" };
	if (input === "setup") return { kind: "setup" };
	if (input === "enable") return { kind: "enable" };
	if (input === "disable") return { kind: "disable" };
	if (input === "workspace-reset") return { kind: "workspace-reset" };
	if (input.startsWith("forget ")) {
		return { kind: "forget", args: input.slice("forget ".length) };
	}
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
		case "forget":
			return operations.forget(command.args);
		case "workspace-reset":
			return operations.workspaceReset();
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
		"/honcho forget session|conclusion <id> — delete remote memory",
		"/honcho workspace-reset — reset the configured remote workspace",
		"",
		status,
	].join("\n");
}
