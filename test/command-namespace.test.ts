import assert from "node:assert/strict";
import test from "node:test";
import {
	commandArgumentCompletions,
	dispatchHonchoCommand,
	formatHonchoCommandHelp,
	parseHonchoCommand,
} from "../src/remote/command-namespace.js";

test("parses namespace commands and keeps action arguments", () => {
	assert.deepEqual(parseHonchoCommand(""), { kind: "help" });
	assert.deepEqual(parseHonchoCommand("help"), { kind: "help" });
	assert.deepEqual(parseHonchoCommand("status"), { kind: "status" });
	assert.deepEqual(parseHonchoCommand("setup"), { kind: "setup" });
	assert.deepEqual(parseHonchoCommand("project setup"), {
		kind: "project-setup",
	});
	assert.deepEqual(parseHonchoCommand("project disable"), {
		kind: "project-disable",
	});
	assert.deepEqual(parseHonchoCommand("forget conclusion conclusion-1"), {
		kind: "forget",
		args: "conclusion conclusion-1",
	});
	assert.deepEqual(parseHonchoCommand("workspace-reset"), {
		kind: "workspace-reset",
	});
});

test("rejects invalid namespace commands", () => {
	assert.deepEqual(parseHonchoCommand("project"), { kind: "invalid" });
	assert.deepEqual(parseHonchoCommand("status now"), { kind: "invalid" });
	assert.deepEqual(parseHonchoCommand("workspace-reset now"), {
		kind: "invalid",
	});
});

test("dispatches root, help, actions, and invalid commands", async () => {
	const calls: string[] = [];
	const record = (call: string): void => {
		calls.push(call);
	};
	const operations = {
		help: async () => record("help"),
		status: async () => record("status"),
		setup: async () => record("setup"),
		projectSetup: async () => record("project setup"),
		projectDisable: async () => record("project disable"),
		forget: async (args: string) => record(`forget ${args}`),
		workspaceReset: async () => record("workspace reset"),
		invalid: () => record("invalid"),
	};

	await dispatchHonchoCommand("", operations);
	await dispatchHonchoCommand("help", operations);
	await dispatchHonchoCommand("status", operations);
	await dispatchHonchoCommand("setup", operations);
	await dispatchHonchoCommand("project setup", operations);
	await dispatchHonchoCommand("project disable", operations);
	await dispatchHonchoCommand("forget session", operations);
	await dispatchHonchoCommand("workspace-reset", operations);
	await dispatchHonchoCommand("unknown", operations);

	assert.deepEqual(calls, [
		"help",
		"help",
		"status",
		"setup",
		"project setup",
		"project disable",
		"forget session",
		"workspace reset",
		"invalid",
	]);
});

test("offers command argument completions", () => {
	assert.deepEqual(commandArgumentCompletions("project d"), [
		{ value: "project disable", label: "project disable" },
	]);
	assert.deepEqual(commandArgumentCompletions("for"), [
		{ value: "forget", label: "forget" },
	]);
	assert.equal(commandArgumentCompletions("unknown"), null);
});

test("formats concise help with current status", () => {
	assert.match(
		formatHonchoCommandHelp("Honcho: connected\nWorkspace: pi"),
		/\/honcho project disable/,
	);
	assert.match(
		formatHonchoCommandHelp("Honcho: connected\nWorkspace: pi"),
		/Honcho: connected/,
	);
});
