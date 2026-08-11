export type HonchoCommand =
	| { kind: "help" }
	| { kind: "status" }
	| { kind: "setup" }
	| { kind: "project-setup" }
	| { kind: "project-disable" }
	| { kind: "forget"; args: string }
	| { kind: "workspace-reset" }
	| { kind: "invalid" };

export interface HonchoCommandOperations {
	help(): Promise<void>;
	status(): Promise<void>;
	setup(): Promise<void>;
	projectSetup(): Promise<void>;
	projectDisable(): Promise<void>;
	forget(args: string): Promise<void>;
	workspaceReset(): Promise<void>;
	invalid(): void;
}

const commandNames = [
	"status",
	"setup",
	"project setup",
	"project disable",
	"forget",
	"workspace-reset",
] as const;

export function parseHonchoCommand(args: string): HonchoCommand {
	const input = args.trim();
	if (!input || input === "help") return { kind: "help" };
	if (input === "status") return { kind: "status" };
	if (input === "setup") return { kind: "setup" };
	if (input === "project setup") return { kind: "project-setup" };
	if (input === "project disable") return { kind: "project-disable" };
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
		case "setup":
			return operations.setup();
		case "project-setup":
			return operations.projectSetup();
		case "project-disable":
			return operations.projectDisable();
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
		"/honcho status — show connection and project-policy status",
		"/honcho setup — configure workspace and peer identities",
		"/honcho project setup — create this folder's policy",
		"/honcho project disable — immediately opt this folder out",
		"/honcho forget session|conclusion <id> — delete remote memory",
		"/honcho workspace-reset — reset the configured remote workspace",
		"",
		status,
	].join("\n");
}
