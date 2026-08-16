import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createTmuxTreeLauncher, installTreeEditorBootstrap } from "../src/tmux-tree-launch.ts";

function createMode(sourceFile, sessionDir) {
	return {
		sessionManager: {
			getSessionFile: () => sourceFile,
			getSessionDir: () => sessionDir,
			getCwd: () => "/work/tree-project",
		},
		getUserMessageText: (message) => message.content,
	};
}

function createFakeSessionManager(childPath, observations) {
	return class FakeSessionManager {
		constructor() {
			this.header = { type: "session", id: "child", cwd: "/work/tree-project" };
			this.entries = [];
		}

		static open(sourceFile, sessionDir) {
			observations.open = { sourceFile, sessionDir };
			const manager = new FakeSessionManager();
			manager.entries = [{ type: "message", id: "copied", parentId: null }];
			return manager;
		}

		static create(cwd, sessionDir) {
			observations.create = { cwd, sessionDir };
			return new FakeSessionManager();
		}

		newSession(options) {
			observations.newSession = options;
			this.header.parentSession = options.parentSession;
		}

		createBranchedSession(targetId) {
			observations.targetId = targetId;
			return childPath;
		}

		getSessionFile() {
			return childPath;
		}

		getHeader() {
			return this.header;
		}

		getEntries() {
			return this.entries;
		}
	};
}

function bootstrapPathFromArgs(args) {
	const value = args.find((arg) => arg.startsWith("PI_TREEX_EDITOR_BOOTSTRAP="));
	return value?.slice(value.indexOf("=") + 1);
}

test("user launch branches before the message and prefills the child editor", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-treex-launch-test-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const sourceFile = join(directory, "source.jsonl");
	const childPath = join(directory, "child.jsonl");
	await writeFile(sourceFile, "{}\n");
	const observations = {};
	const FakeSessionManager = createFakeSessionManager(childPath, observations);
	let tmuxArgs;
	const launcher = createTmuxTreeLauncher(FakeSessionManager, {
		env: { TMUX: "tmux", TMUX_PANE: "%1", KEEP_ME: "yes" },
		extensionPath: "/extensions/treex.ts",
		runTmux: (args) => {
			tmuxArgs = args;
			return { status: 0, stderr: "" };
		},
	});
	const mode = createMode(sourceFile, directory);
	const result = launcher.launch(
		mode,
		{
			id: "user-2",
			parentId: "assistant-1",
			type: "message",
			message: { role: "user", content: "edit this prompt" },
		},
		"right",
	);

	assert.equal(result.ok, true);
	assert.equal(observations.targetId, "assistant-1");
	assert.deepEqual(observations.open, { sourceFile, sessionDir: directory });
	assert.equal(tmuxArgs[0], "split-window");
	assert.equal(tmuxArgs[1], "-h");
	assert.ok(tmuxArgs.includes("KEEP_ME=yes"));
	assert.ok(!tmuxArgs.some((arg) => arg.startsWith("TMUX=")));
	assert.ok(tmuxArgs.includes("/extensions/treex.ts"));
	const bootstrapPath = bootstrapPathFromArgs(tmuxArgs);
	assert.ok(bootstrapPath);

	let sessionStart;
	installTreeEditorBootstrap(
		{
			on: (event, handler) => {
				assert.equal(event, "session_start");
				sessionStart = handler;
			},
		},
		{ PI_TREEX_EDITOR_BOOTSTRAP: bootstrapPath },
	);
	let editorText;
	sessionStart(
		{ reason: "startup" },
		{
			ui: {
				setEditorText: (text) => {
					editorText = text;
				},
			},
		},
	);
	assert.equal(editorText, "edit this prompt");
	await assert.rejects(access(bootstrapPath));
});

test("root user launch creates an empty child with parentSession", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-treex-root-test-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const sourceFile = join(directory, "source.jsonl");
	const childPath = join(directory, "child.jsonl");
	await writeFile(sourceFile, "{}\n");
	const observations = {};
	const FakeSessionManager = createFakeSessionManager(childPath, observations);
	let tmuxArgs;
	const launcher = createTmuxTreeLauncher(FakeSessionManager, {
		env: { TMUX: "tmux", TMUX_PANE: "%1" },
		runTmux: (args) => {
			tmuxArgs = args;
			return { status: 0, stderr: "" };
		},
	});
	const result = launcher.launch(
		createMode(sourceFile, directory),
		{
			id: "user-root",
			parentId: null,
			type: "message",
			message: { role: "user", content: "initial prompt" },
		},
		"window",
	);

	assert.equal(result.ok, true);
	assert.deepEqual(observations.create, { cwd: "/work/tree-project", sessionDir: directory });
	assert.deepEqual(observations.newSession, { parentSession: sourceFile });
	assert.equal(observations.targetId, undefined);
	assert.equal(tmuxArgs[0], "new-window");
	const persisted = (await readFile(childPath, "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	assert.equal(persisted[0].parentSession, sourceFile);
	assert.equal(persisted.length, 1);

	const bootstrapPath = bootstrapPathFromArgs(tmuxArgs);
	installTreeEditorBootstrap({ on: () => {} }, { PI_TREEX_EDITOR_BOOTSTRAP: bootstrapPath });
});

test("assistant launch includes the selected entry and reports tmux failure", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-treex-failure-test-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const sourceFile = join(directory, "source.jsonl");
	const childPath = join(directory, "child.jsonl");
	await writeFile(sourceFile, "{}\n");
	const observations = {};
	const FakeSessionManager = createFakeSessionManager(childPath, observations);
	const launcher = createTmuxTreeLauncher(FakeSessionManager, {
		env: { TMUX: "tmux", TMUX_PANE: "%1" },
		runTmux: () => ({ status: 1, stderr: "no pane available\nmore detail" }),
	});
	const result = launcher.launch(
		createMode(sourceFile, directory),
		{
			id: "assistant-2",
			parentId: "user-2",
			type: "message",
			message: { role: "assistant", content: [] },
		},
		"down",
	);

	assert.equal(observations.targetId, "assistant-2");
	assert.deepEqual(result, { ok: false, error: "Tree launch failed: no pane available" });
	await assert.rejects(access(childPath));
});

test("launch shortcuts require a persisted source session and tmux", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-treex-guard-test-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const missingSource = join(directory, "missing.jsonl");
	const childPath = join(directory, "child.jsonl");
	const observations = {};
	const launcher = createTmuxTreeLauncher(createFakeSessionManager(childPath, observations), { env: {} });

	assert.equal(launcher.available, false);
	assert.equal(launcher.targetForInput("\x1b[115;7u"), "down");
	assert.equal(launcher.targetForInput("\x1b[118;7u"), "right");
	assert.equal(launcher.targetForInput("\x1b[119;7u"), "window");
	assert.deepEqual(
		launcher.launch(
			createMode(missingSource, directory),
			{ id: "assistant", type: "message", message: { role: "assistant" } },
			"down",
		),
		{ ok: false, error: "Wait for the first assistant response before branching" },
	);
});
