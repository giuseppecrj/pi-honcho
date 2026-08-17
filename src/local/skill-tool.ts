import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { SkillResult, SkillStore } from "./skill-store.js";

export const SKILL_MANAGE_TOOL_NAME = "skill_manage";
export const SKILL_TOOL_DESCRIPTION = `Manage reusable procedures and patterns as Pi-native skills that survive across sessions. Skills are procedural memory — they capture HOW to do something, not just what happened.

Use create for a new skill, patch for a targeted section update, update for a full rewrite, view to inspect existing skills, and delete to remove obsolete ones. Scope is required on create: use global for transferable procedures and project for procedures tied to this repo's paths, scripts, architecture, or deploy steps.

SCOPE:
- global: transferable workflows, stored in the extension-managed global skills directory.
- project: repository-specific workflows, stored in the active project's extension-managed skills directory.

WHEN TO UPDATE:
- Prefer patch for one section and update for a full rewrite.
- Prefer structured fields for create/update/patch so the result is valid SKILL.md.
- Do not use skills for temporary task state; save only reusable procedures and patterns.`;
const PARAMETERS = Type.Object(
	{
		action: Type.String({
			enum: ["create", "view", "patch", "update", "edit", "delete"],
			description: "The skill action to perform.",
		}),
		name: Type.Optional(
			Type.String({
				description:
					"Skill name for create. Use a canonical lowercase hyphen slug.",
			}),
		),
		skill_id: Type.Optional(
			Type.String({
				description:
					"Stable skill id for view/patch/update/delete, such as global:debug-typescript-errors or project:my-repo:release-app. Legacy alias edit also accepts this field.",
			}),
		),
		description: Type.Optional(
			Type.String({
				description:
					"One-line description of when to use this skill. Required for create; optional for update/edit.",
			}),
		),
		scope: Type.Optional(
			Type.String({
				enum: ["global", "project"],
				description:
					"Required for create. Use global for transferable procedures and project for repository-specific workflows.",
			}),
		),
		section: Type.Optional(
			Type.String({
				description:
					"Required for patch. Use When to Use, Procedure, Pitfalls, or Verification.",
			}),
		),
		content: Type.Optional(
			Type.String({
				description:
					"Raw Markdown body for create/update/edit, or section body for patch. Patch content must not include section headers; JSON objects are rejected.",
			}),
		),
		when_to_use: Type.Optional(
			Type.String({
				description:
					"Structured create/update/patch body for the When to Use section.",
			}),
		),
		procedure_steps: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"Structured create/update/patch body for Procedure. Ordered concrete steps.",
			}),
		),
		pitfalls: Type.Optional(
			Type.Array(Type.String(), {
				description: "Structured create/update/patch body for Pitfalls.",
			}),
		),
		verification_steps: Type.Optional(
			Type.Array(Type.String(), {
				description: "Structured create/update/patch body for Verification.",
			}),
		),
	},
	{ additionalProperties: false },
);

type Input = {
	action: "create" | "view" | "patch" | "update" | "edit" | "delete";
	name?: string;
	skill_id?: string;
	description?: string;
	scope?: "global" | "project";
	section?: string;
	content?: string;
	when_to_use?: string;
	procedure_steps?: unknown;
	pitfalls?: unknown;
	verification_steps?: unknown;
};
function result(value: unknown): {
	content: [{ type: "text"; text: string }];
	details: unknown;
} {
	return {
		content: [{ type: "text", text: JSON.stringify(value) }],
		details: value,
	};
}
function safeStructuredText(value: string): string {
	return value
		.replace(/\r?\n/g, " ")
		.replace(/^#{1,6}\s+/, "")
		.trim();
}
function list(value: unknown): string[] {
	return Array.isArray(value)
		? value
				.filter((item): item is string => typeof item === "string")
				.map(safeStructuredText)
				.filter(Boolean)
		: [];
}
function hasStructured(input: Input): boolean {
	return Boolean(
		input.when_to_use?.trim() ||
			list(input.procedure_steps).length ||
			list(input.pitfalls).length ||
			list(input.verification_steps).length,
	);
}
function structured(input: Input): string | undefined {
	const when = safeStructuredText(input.when_to_use ?? "");
	const procedure = list(input.procedure_steps);
	const pitfalls = list(input.pitfalls);
	const verification = list(input.verification_steps);
	if (!when && !procedure.length && !pitfalls.length && !verification.length)
		return undefined;
	if (!when || !procedure.length || !verification.length) return undefined;
	return [
		"## When to Use",
		when,
		"",
		"## Procedure",
		procedure
			.map((x, i) => `${i + 1}. ${x.replace(/^\d+\.\s+/, "")}`)
			.join("\n"),
		"",
		"## Pitfalls",
		(pitfalls.length ? pitfalls : ["No notable pitfalls recorded yet."])
			.map((x) => `- ${x.replace(/^[-*]\s+/, "")}`)
			.join("\n"),
		"",
		"## Verification",
		verification
			.map((x, i) => `${i + 1}. ${x.replace(/^\d+\.\s+/, "")}`)
			.join("\n"),
	].join("\n");
}
function patchBody(input: Input): string | undefined {
	if (input.content?.trim()) return input.content.trim();
	const section = input.section
		?.trim()
		.replace(/^##\s+/, "")
		.toLowerCase();
	const values =
		section === "procedure"
			? list(input.procedure_steps)
			: section === "pitfalls"
				? list(input.pitfalls)
				: section === "verification"
					? list(input.verification_steps)
					: section === "when to use"
						? input.when_to_use?.trim()
							? [input.when_to_use.trim()]
							: []
						: [];
	if (!values.length) return undefined;
	return section === "when to use"
		? values[0]
		: values
				.map((x, i) =>
					section === "pitfalls"
						? `- ${x.replace(/^[-*]\s+/, "")}`
						: `${i + 1}. ${x.replace(/^\d+\.\s+|^[-*]\s+/, "")}`,
				)
				.join("\n");
}

export function registerSkillTool(pi: ExtensionAPI, store: SkillStore): void {
	pi.registerTool({
		name: SKILL_MANAGE_TOOL_NAME,
		label: "Skill Manager",
		description: SKILL_TOOL_DESCRIPTION,
		promptSnippet:
			"Create, inspect, and update reusable procedures and patterns",
		promptGuidelines: [
			"Use the skill_manage tool after completing complex tasks that required trial and error or multiple tool calls.",
			"Use create with explicit scope: global for transferable workflows and project for repository-specific ones.",
			"Prefer structured fields for create/update/patch so the tool renders valid SKILL.md sections.",
			"Use patch for one section and update for a full rewrite.",
			"Use view before patching or updating an existing skill.",
			"Do not use skills for temporary task state; save only reusable procedures.",
		],
		parameters: PARAMETERS,
		async execute(_id, raw) {
			const input = raw as Input;
			if (input.action === "view") {
				if (!input.skill_id)
					return result({ success: true, skills: await store.loadIndex() });
				const doc = await store.loadSkill(input.skill_id);
				return doc
					? result({ success: true, ...doc, body: doc.body.slice(0, 50_000) })
					: result({
							success: false,
							error: `Skill '${input.skill_id}' not found.`,
						});
			}
			let output: SkillResult;
			if (input.action === "create") {
				if (!input.name || !input.description || !input.scope)
					return result({
						success: false,
						error:
							"name, description, and explicit scope are required for 'create'.",
					});
				const body = input.content?.trim() || structured(input);
				if (!body)
					return result({
						success: false,
						error:
							"Either content or complete structured fields (when_to_use, procedure_steps, verification_steps) are required.",
					});
				output = await store.create(
					input.name,
					input.description,
					body,
					input.scope,
				);
			} else if (input.action === "patch") {
				if (!input.skill_id || !input.section)
					return result({
						success: false,
						error: "skill_id and section are required for 'patch'.",
					});
				const body = patchBody(input);
				if (!body)
					return result({
						success: false,
						error:
							"content or one matching structured field is required for 'patch'.",
					});
				output = await store.patch(input.skill_id, input.section, body);
			} else if (input.action === "update" || input.action === "edit") {
				if (!input.skill_id)
					return result({
						success: false,
						error: `skill_id is required for '${input.action}'.`,
					});
				const body = input.content?.trim() || structured(input) || "";
				if (hasStructured(input) && !structured(input))
					return result({
						success: false,
						error:
							"Complete structured fields are required for update/edit; use content for a free-form rewrite.",
					});
				output = await store.edit(
					input.skill_id,
					input.description ?? "",
					body,
				);
			} else if (input.action === "delete") {
				output = input.skill_id
					? await store.delete(input.skill_id)
					: { success: false, error: "skill_id is required for 'delete'." };
			} else output = { success: false, error: "Unknown skill action." };
			return result(output);
		},
	});
}
