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
	assert.deepEqual(parseHonchoCommand("init"), { kind: "init" });
	assert.deepEqual(parseHonchoCommand("login"), { kind: "login" });
	assert.deepEqual(parseHonchoCommand("setup"), { kind: "setup" });
	assert.deepEqual(parseHonchoCommand("enable"), { kind: "enable" });
	assert.deepEqual(parseHonchoCommand("disable"), { kind: "disable" });
	assert.deepEqual(parseHonchoCommand("session delete"), {
		kind: "session-delete",
	});
});

test("rejects invalid namespace commands", () => {
	assert.deepEqual(parseHonchoCommand("project"), { kind: "invalid" });
	assert.deepEqual(parseHonchoCommand("status now"), { kind: "invalid" });
	assert.deepEqual(parseHonchoCommand("session delete now"), {
		kind: "invalid",
	});
	assert.deepEqual(parseHonchoCommand("forget session"), { kind: "invalid" });
	assert.deepEqual(parseHonchoCommand("workspace-reset"), { kind: "invalid" });
});

test("dispatches root, help, actions, and invalid commands", async () => {
	const calls: string[] = [];
	const record = (call: string): void => {
		calls.push(call);
	};
	const operations = {
		help: async () => record("help"),
		status: async () => record("status"),
		init: async () => record("init"),
		login: async () => record("login"),
		setup: async () => record("setup"),
		enable: async () => record("enable"),
		disable: async () => record("disable"),
		sessionDelete: async () => record("session delete"),
		invalid: () => record("invalid"),
	};

	await dispatchHonchoCommand("", operations);
	await dispatchHonchoCommand("help", operations);
	await dispatchHonchoCommand("status", operations);
	await dispatchHonchoCommand("init", operations);
	await dispatchHonchoCommand("login", operations);
	await dispatchHonchoCommand("setup", operations);
	await dispatchHonchoCommand("enable", operations);
	await dispatchHonchoCommand("disable", operations);
	await dispatchHonchoCommand("session delete", operations);
	await dispatchHonchoCommand("unknown", operations);

	assert.deepEqual(calls, [
		"help",
		"help",
		"status",
		"init",
		"login",
		"setup",
		"enable",
		"disable",
		"session delete",
		"invalid",
	]);
});

test("offers command argument completions", () => {
	assert.deepEqual(commandArgumentCompletions("dis"), [
		{ value: "disable", label: "disable" },
	]);
	assert.deepEqual(commandArgumentCompletions("session d"), [
		{ value: "session delete", label: "session delete" },
	]);
	assert.equal(commandArgumentCompletions("unknown"), null);
});

test("formats concise help with current status", () => {
	assert.match(
		formatHonchoCommandHelp("Honcho: connected\nWorkspace: pi"),
		/\/honcho session delete/,
	);
	assert.match(
		formatHonchoCommandHelp("Honcho: connected\nWorkspace: pi"),
		/Honcho: connected/,
	);
	assert.doesNotMatch(
		formatHonchoCommandHelp("Honcho: connected\nWorkspace: pi"),
		/(forget|workspace-reset|conclusion)/,
	);
});
