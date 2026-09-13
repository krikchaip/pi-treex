import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY_BIN = join(REPOSITORY_ROOT, "node_modules", ".bin");
const PI_COMMAND = process.env.PI_TREEX_E2E_PI_COMMAND ?? "pi";
const TMUX_COMMAND = process.env.PI_TREEX_E2E_TMUX_COMMAND ?? "tmux";
const STARTUP_TIMEOUT_MS = 8_000;
const TRANSITION_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 100;

function delay(milliseconds) {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function withoutParentTmux(environment = process.env) {
	const { TMUX: _tmux, TMUX_PANE: _tmuxPane, ...result } = environment;
	if (result.PATH) {
		result.PATH = result.PATH.split(delimiter)
			.filter((entry) => resolve(entry) !== REPOSITORY_BIN)
			.join(delimiter);
	}
	return result;
}

function commandFailure(command, args, result) {
	const details = [
		`${command} ${args.join(" ")}`,
		`exit: ${String(result.status)}`,
		result.error ? `error: ${result.error.message}` : "",
		result.stdout ? `stdout:\n${result.stdout}` : "",
		result.stderr ? `stderr:\n${result.stderr}` : "",
	]
		.filter(Boolean)
		.join("\n");
	return new Error(details);
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		encoding: "utf8",
		timeout: options.timeout ?? 5_000,
		env: options.env ?? process.env,
		...options,
	});
	if (result.status !== 0 || result.error) throw commandFailure(command, args, result);
	return result.stdout;
}

function sessionFixture(cwd) {
	const timestamp = "2026-09-13T16:00:00.000Z";
	const usage = {
		input: 260,
		output: 45,
		cacheRead: 0,
		cacheWrite: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	return [
		{ type: "session", version: 3, id: "treex-real-tui-e2e", timestamp, cwd },
		{
			type: "message",
			id: "user-root",
			parentId: null,
			timestamp,
			message: { role: "user", content: "Plan the release checklist", timestamp: 1_789_315_201_000 },
		},
		{
			type: "message",
			id: "assistant-root",
			parentId: "user-root",
			timestamp,
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Check tests, package metadata, and release notes." }],
				provider: "openai-codex",
				model: "gpt-5.6-sol",
				usage,
				stopReason: "stop",
				timestamp: 1_789_315_202_000,
			},
		},
		{
			type: "message",
			id: "user-main",
			parentId: "assistant-root",
			timestamp,
			message: { role: "user", content: "Focus on package metadata first", timestamp: 1_789_315_203_000 },
		},
		{
			type: "message",
			id: "assistant-main",
			parentId: "user-main",
			timestamp,
			message: {
				role: "assistant",
				content: [{ type: "text", text: "The package name and version are ready for review." }],
				provider: "openai-codex",
				model: "gpt-5.6-sol",
				usage,
				stopReason: "stop",
				timestamp: 1_789_315_204_000,
			},
		},
		{
			type: "message",
			id: "user-branch",
			parentId: "assistant-root",
			timestamp,
			message: {
				role: "user",
				content:
					"Focus on tests first and include a detailed deterministic validation plan that is intentionally long enough to exercise the expanded preview drawer.",
				timestamp: 1_789_315_205_000,
			},
		},
		{
			type: "message",
			id: "assistant-branch",
			parentId: "user-branch",
			timestamp,
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "PRIVATE_THINKING_MUST_NOT_APPEAR_IN_TREE_DETAIL" },
					{
						type: "text",
						text: "Run lint, unit tests, and the live terminal scenario. Confirm the tree remains open after a tmux launch shortcut.",
					},
				],
				provider: "openai-codex",
				model: "gpt-5.6-sol",
				usage,
				stopReason: "stop",
				timestamp: 1_789_315_206_000,
			},
		},
	]
		.map((entry) => JSON.stringify(entry))
		.join("\n");
}

function treeRegion(pane) {
	const marker = pane.indexOf("Session Tree");
	return marker === -1 ? pane : pane.slice(marker);
}

function paneFailure(message, pane) {
	return `${message}\n--- captured pane ---\n${pane}\n--- end pane ---`;
}

function assertIncludes(pane, expected, message = `expected pane to include ${JSON.stringify(expected)}`) {
	assert.ok(pane.includes(expected), paneFailure(message, pane));
}

function assertExcludes(pane, unwanted, message = `expected pane to exclude ${JSON.stringify(unwanted)}`) {
	assert.ok(!pane.includes(unwanted), paneFailure(message, pane));
}

async function waitFor(readValue, predicate, description, timeout = TRANSITION_TIMEOUT_MS) {
	const deadline = Date.now() + timeout;
	let lastValue;
	while (Date.now() < deadline) {
		lastValue = readValue();
		if (predicate(lastValue)) return lastValue;
		await delay(POLL_INTERVAL_MS);
	}
	throw new Error(
		typeof lastValue === "string"
			? paneFailure(`timed out waiting for ${description}`, lastValue)
			: `timed out waiting for ${description}; last value: ${JSON.stringify(lastValue)}`,
	);
}

test("TreeX preserves its personal behavior in a real Pi TUI", { timeout: 20_000 }, async (t) => {
	const extensionPath = resolve(process.env.PI_TREEX_E2E_EXTENSION_PATH ?? join(REPOSITORY_ROOT, "treex.ts"));
	assert.ok(existsSync(extensionPath), `extension does not exist: ${extensionPath}`);

	const testRoot = await mkdtemp(join(tmpdir(), "pi-treex-real-tui-e2e-"));
	const testId = `treex-e2e-${process.pid}-${testRoot.slice(-6)}`;
	// Unix socket paths are short (about 100 bytes on macOS), so keep the socket directly under /tmp.
	const socketPath = join("/tmp", `${testId}.sock`);
	const session = testId;
	const configDir = join(testRoot, "config");
	const fixturePath = join(testRoot, "session.jsonl");
	const tmuxConfigPath = join(testRoot, "tmux.conf");
	const tuiLogPath = join(testRoot, "tui.log");
	const rawPaneLogPath = join(testRoot, "pane.log");
	const tmuxEnvironment = withoutParentTmux();
	let serverStarted = false;

	const tmux = (args, options = {}) =>
		run(TMUX_COMMAND, ["-S", socketPath, ...args], { env: tmuxEnvironment, ...options });
	const diagnosticLog = (path) => {
		if (!existsSync(path)) return "(missing)";
		return readFileSync(path, "utf8").slice(-10_000);
	};
	const capturePane = (target) => {
		try {
			return tmux(["capture-pane", "-p", "-t", target]);
		} catch (error) {
			error.message += `\n--- PI_TUI_WRITE_LOG ---\n${diagnosticLog(tuiLogPath)}\n--- raw pane log ---\n${diagnosticLog(rawPaneLogPath)}\n--- end diagnostic logs ---`;
			throw error;
		}
	};
	const paneIds = (windowTarget) =>
		tmux(["list-panes", "-t", windowTarget, "-F", "#{pane_id}"]).trim().split("\n").filter(Boolean);
	const paneDimensions = (paneTarget) => {
		const [width, height] = tmux(["display-message", "-p", "-t", paneTarget, "#{pane_width}\t#{pane_height}"])
			.trim()
			.split("\t")
			.map(Number);
		return { width, height };
	};
	const windowRows = () =>
		tmux(["list-windows", "-t", session, "-F", "#{window_index}\t#{window_id}"])
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((row) => {
				const [index, id] = row.split("\t");
				return { index: Number(index), id };
			});

	t.after(async () => {
		if (serverStarted) {
			spawnSync(TMUX_COMMAND, ["-S", socketPath, "kill-server"], {
				encoding: "utf8",
				timeout: 3_000,
				env: tmuxEnvironment,
			});
		}
		await rm(socketPath, { force: true });
		await rm(testRoot, { recursive: true, force: true });
	});

	await writeFile(fixturePath, `${sessionFixture(REPOSITORY_ROOT)}\n`);
	await writeFile(
		tmuxConfigPath,
		["set -g default-terminal tmux-256color", "set -g extended-keys on", "set -as terminal-features ',*:extkeys'"].join(
			"\n",
		),
	);
	await writeFile(tuiLogPath, "");
	await writeFile(rawPaneLogPath, "");
	await mkdir(configDir, { recursive: true });
	await writeFile(
		join(configDir, "settings.json"),
		`${JSON.stringify({ tuiMode: "fullscreen", defaultProjectTrust: "always", quietStartup: true })}\n`,
	);
	await writeFile(join(configDir, "keybindings.json"), `${JSON.stringify({ "app.session.tree": "f6" })}\n`);

	const launchEnvironment = {
		PI_CODING_AGENT_DIR: configDir,
		PI_OFFLINE: "1",
		PI_TUI_WRITE_LOG: tuiLogPath,
		TERM: "xterm-256color",
		COLORTERM: "truecolor",
		COLUMNS: "100",
		LINES: "60",
	};
	const launchEnvironmentArgs = Object.entries(launchEnvironment).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
	tmux([
		"-f",
		tmuxConfigPath,
		"new-session",
		"-d",
		"-s",
		session,
		"-x",
		"100",
		"-y",
		"60",
		"-c",
		REPOSITORY_ROOT,
		...launchEnvironmentArgs,
		PI_COMMAND,
		"--offline",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--no-context-files",
		"-e",
		extensionPath,
		"--session",
		fixturePath,
		"--tui-mode",
		"fullscreen",
	]);
	serverStarted = true;

	const originalPane = tmux(["display-message", "-p", "-t", `${session}:0.0`, "#{pane_id}"]).trim();
	const originalWindow = tmux(["display-message", "-p", "-t", originalPane, "#{window_id}"]).trim();
	tmux(["pipe-pane", "-o", "-t", originalPane, `cat >> ${JSON.stringify(rawPaneLogPath)}`]);
	await waitFor(
		() => capturePane(originalPane),
		(pane) => pane.includes("Run lint, unit tests") && pane.includes("pi-treex"),
		"Pi editor readiness",
		STARTUP_TIMEOUT_MS,
	);

	tmux(["send-keys", "-t", originalPane, "-l", "/tree"]);
	tmux(["send-keys", "-t", originalPane, "Enter"]);
	let pane = await waitFor(
		() => capturePane(originalPane),
		(value) => value.includes("Session Tree") && value.includes("ctrl+alt+s sp") && value.includes("Ctrl+R full"),
		"TreeX picker readiness",
	);
	let region = treeRegion(pane);
	assertIncludes(region, "CURRENT", "current-row direction metadata is absent");
	assertIncludes(region, "Run lint, unit tests", "collapsed assistant detail is absent");
	assertExcludes(region, "PRIVATE_THINKING_MUST_NOT_APPEAR_IN_TREE_DETAIL", "collapsed detail leaked thinking");

	tmux(["send-keys", "-t", originalPane, "C-r"]);
	pane = await waitFor(
		() => capturePane(originalPane),
		(value) => treeRegion(value).includes("Esc/Ctrl+R collapse"),
		"expanded detail",
	);
	region = treeRegion(pane);
	assertIncludes(region, "Run lint, unit tests", "expanded assistant detail is absent");
	assertExcludes(region, "PRIVATE_THINKING_MUST_NOT_APPEAR_IN_TREE_DETAIL", "expanded detail leaked thinking");
	tmux(["send-keys", "-t", originalPane, "C-r"]);

	tmux(["resize-window", "-t", originalWindow, "-x", "50", "-y", "40"]);
	pane = await waitFor(
		() => capturePane(originalPane),
		(value) => value.includes("ctrl+alt+s sp") && value.includes("ctrl+alt+v vsp") && value.includes("ctrl+alt+w win"),
		"narrow TreeX hints",
	);
	region = treeRegion(pane);
	assertIncludes(region, "Ctrl+R", "narrow detail review hint is absent");
	tmux(["resize-window", "-t", originalWindow, "-x", "100", "-y", "60"]);

	tmux(["send-keys", "-t", originalPane, "F6"]);
	await waitFor(
		() => capturePane(originalPane),
		(value) => !value.includes("Session Tree"),
		"configured tree hotkey to close the picker",
	);
	tmux(["send-keys", "-t", originalPane, "F6"]);
	await waitFor(
		() => capturePane(originalPane),
		(value) => value.includes("Session Tree"),
		"configured tree hotkey to reopen the picker",
	);

	for (const { shortcut, direction } of [
		{ shortcut: "\u001b[115;7u", direction: "down" },
		{ shortcut: "\u001b[118;7u", direction: "right" },
	]) {
		const before = new Set(paneIds(originalWindow));
		const dimensionsBefore = paneDimensions(originalPane);
		tmux(["send-keys", "-t", originalPane, "-l", shortcut]);
		const after = await waitFor(
			() => paneIds(originalWindow),
			(ids) => ids.length === before.size + 1,
			`tmux pane creation for ${JSON.stringify(shortcut)}`,
		);
		const childPane = after.find((id) => !before.has(id));
		assert.ok(childPane, `new pane was not identifiable for ${JSON.stringify(shortcut)}`);
		const originalDimensions = paneDimensions(originalPane);
		const childDimensions = paneDimensions(childPane);
		if (direction === "down") {
			assert.equal(childDimensions.width, dimensionsBefore.width, "Ctrl+Alt+S did not create a full-width split");
			assert.ok(childDimensions.height < dimensionsBefore.height, "Ctrl+Alt+S did not split below the picker");
			assert.ok(
				Math.abs(originalDimensions.height - childDimensions.height) <= 1,
				"Ctrl+Alt+S did not divide the window into equal-height panes",
			);
		} else {
			assert.equal(childDimensions.height, dimensionsBefore.height, "Ctrl+Alt+V did not create a full-height split");
			assert.ok(childDimensions.width < dimensionsBefore.width, "Ctrl+Alt+V did not split right of the picker");
			assert.ok(
				Math.abs(originalDimensions.width - childDimensions.width) <= 1,
				"Ctrl+Alt+V did not divide the window into equal-width panes",
			);
		}
		assertIncludes(capturePane(originalPane), "Session Tree", "successful pane launch closed the TreeX picker");
		tmux(["kill-pane", "-t", childPane]);
	}

	const windowsBefore = windowRows();
	const originalWindowRow = windowsBefore.find((row) => row.id === originalWindow);
	assert.ok(originalWindowRow, `original window ${originalWindow} is absent: ${JSON.stringify(windowsBefore)}`);
	tmux(["send-keys", "-t", originalPane, "-l", "\u001b[119;7u"]);
	const windowsAfter = await waitFor(
		windowRows,
		(rows) => rows.length === windowsBefore.length + 1,
		"tmux window creation",
	);
	const priorWindowIds = new Set(windowsBefore.map((row) => row.id));
	const childWindow = windowsAfter.find((row) => !priorWindowIds.has(row.id));
	assert.ok(childWindow, `new window was not identifiable: ${JSON.stringify(windowsAfter)}`);
	assert.equal(
		childWindow.index,
		originalWindowRow.index + 1,
		`new TreeX window was not inserted after the current window: ${JSON.stringify(windowsAfter)}`,
	);
	assertIncludes(capturePane(originalPane), "Session Tree", "successful window launch closed the TreeX picker");
});
