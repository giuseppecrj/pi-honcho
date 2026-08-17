import { basename, join, resolve } from "node:path";

import { isValidHonchoWorkspaceId } from "./config.js";
import { isValidProjectHonchoPolicy } from "./project-policy.js";

export interface ProjectPolicyCommandContext {
	cwd: string;
	isProjectTrusted(): boolean;
	confirm(title: string, details: string): Promise<boolean>;
	input(label: string, initial?: string): Promise<string | undefined>;
	notify(message: string, level: "info" | "warning" | "error"): void;
}

export interface ProjectPolicyStore {
	path: string;
	read(): Promise<unknown | undefined>;
	write(policy: {
		enabled: boolean;
		workspace?: string;
	}): Promise<string | undefined>;
}

export function projectPolicyPath(cwd: string): string {
	return join(cwd, ".pi", "honcho-memory.json");
}

export function projectPolicyWorkspaceSuggestion(cwd: string): string {
	return basename(resolve(cwd));
}

function isInvalidPolicy(policy: unknown | undefined): boolean {
	return policy !== undefined && !isValidProjectHonchoPolicy(policy);
}

function allowReplacement(
	ctx: ProjectPolicyCommandContext,
	store: ProjectPolicyStore,
	existing: unknown | undefined,
): Promise<boolean> {
	if (isInvalidPolicy(existing)) {
		return ctx.confirm(
			"Recover invalid Honcho policy?",
			`The existing policy at ${store.path} is invalid. Replace it with a valid non-secret policy?`,
		);
	}
	if (existing !== undefined) {
		return ctx.confirm(
			"Replace existing Honcho policy?",
			`Replace the existing policy at ${store.path}?`,
		);
	}
	return Promise.resolve(true);
}

function requireTrust(ctx: ProjectPolicyCommandContext): boolean {
	if (ctx.isProjectTrusted()) return true;
	ctx.notify("Trust this project before writing its Honcho policy.", "warning");
	return false;
}

function savedMessage(path: string, action: string): string {
	return `${action} ${path}. Start a fresh conversation, then use /honcho-status to verify the effective project policy.`;
}

export async function setupProjectPolicy(
	ctx: ProjectPolicyCommandContext,
	store: ProjectPolicyStore,
): Promise<void> {
	if (!requireTrust(ctx)) return;
	const workspace = await ctx.input(
		"Honcho workspace",
		projectPolicyWorkspaceSuggestion(ctx.cwd),
	);
	if (!isValidHonchoWorkspaceId(workspace)) {
		ctx.notify(
			"Workspace IDs must use only letters, digits, underscores, or hyphens.",
			"warning",
		);
		return;
	}
	if (
		!(await ctx.confirm(
			"Save enabled Honcho policy?",
			`Workspace: ${workspace}\nTarget: ${store.path}`,
		))
	)
		return;
	const existing = await store.read();
	if (!(await allowReplacement(ctx, store, existing))) return;
	const path = await store.write({
		enabled: true,
		workspace,
	});
	if (!path) {
		ctx.notify("Could not save a valid non-secret project policy.", "error");
		return;
	}
	ctx.notify(savedMessage(path, "Saved enabled Honcho policy at"), "info");
}

export async function disableProjectPolicy(
	ctx: ProjectPolicyCommandContext,
	store: ProjectPolicyStore,
	disableNow: () => void,
): Promise<void> {
	if (!requireTrust(ctx)) return;
	if (
		!(await ctx.confirm(
			"Disable Honcho memory for this project?",
			`This immediately stops recall and future remote delivery.\nTarget: ${store.path}`,
		))
	)
		return;
	const existing = await store.read();
	if (!(await allowReplacement(ctx, store, existing))) return;
	const workspace =
		existing &&
		typeof existing === "object" &&
		isValidProjectHonchoPolicy(existing) &&
		typeof (existing as { workspace?: unknown }).workspace === "string"
			? (existing as { workspace: string }).workspace
			: undefined;
	const path = await store.write({
		enabled: false,
		...(workspace ? { workspace } : {}),
	});
	if (!path) {
		ctx.notify("Could not save a valid non-secret project policy.", "error");
		return;
	}
	disableNow();
	ctx.notify(
		savedMessage(path, "Disabled Honcho memory with policy at"),
		"info",
	);
}
