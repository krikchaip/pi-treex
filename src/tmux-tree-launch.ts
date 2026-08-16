import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const EDITOR_BOOTSTRAP_ENV = "PI_TREEX_EDITOR_BOOTSTRAP";
const EDITOR_BOOTSTRAP_PREFIX = "pi-treex-editor-";
const EDITOR_BOOTSTRAP_NAME = "bootstrap.json";
const TREE_LAUNCH_ITEMS = [
	{ key: "ctrl+alt+s", label: "sp", target: "down" },
	{ key: "ctrl+alt+v", label: "vsp", target: "right" },
	{ key: "ctrl+alt+w", label: "win", target: "window" },
];
const NATIVE_HELP_CAPTURE_WIDTH = 10_000;
const NATIVE_HELP_ITEMS = [
	{ label: "move" },
	{ label: "page" },
	{ label: "branch" },
	{ label: "copy" },
	{ label: "label" },
	{ label: "label time" },
	{ label: "filters", labelFirst: true },
	{ label: "cycle", labelFirst: true },
];
function isTmuxAvailable(env = process.env) {
	return Boolean(env.TMUX && env.TMUX_PANE);
}

function targetForInput(keyData) {
	return TREE_LAUNCH_ITEMS.find(({ key }) => matchesKey(keyData, key))?.target;
}

function stripAnsi(text) {
	let result = "";
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code === 15) continue;
		if (code !== 27 || text[index + 1] !== "[") {
			result += text[index];
			continue;
		}
		let end = index + 2;
		while (end < text.length) {
			const finalCode = text.charCodeAt(end);
			if (finalCode >= 0x40 && finalCode <= 0x7e) break;
			end++;
		}
		index = end;
	}
	return result;
}

function parseNativeHelpItem(text) {
	for (const item of NATIVE_HELP_ITEMS) {
		if (item.labelFirst) {
			if (text === item.label) return { key: "", ...item };
			if (text.startsWith(`${item.label} `)) return { key: text.slice(item.label.length + 1), ...item };
			continue;
		}
		if (text === item.label) return { key: "", ...item };
		if (text.endsWith(` ${item.label}`)) return { key: text.slice(0, -item.label.length - 1), ...item };
	}
	return { key: "", label: text, labelFirst: true };
}

function parseLegacyNativeHelp(text) {
	const match = text.match(
		/^(.+?): move\. (.+?): page\. (.+?): fold\/branch\. (.*?): label\. (.*?): filters \((.*?) cycle\)\. (.*?): label time$/,
	);
	if (!match) return undefined;
	return [
		{ key: match[1], label: "move" },
		{ key: match[2], label: "page" },
		{ key: match[3], label: "fold/branch" },
		{ key: match[4], label: "label" },
		{ key: match[5], label: "filters", labelFirst: true },
		{ key: match[6], label: "cycle", labelFirst: true },
		{ key: match[7], label: "label time" },
	];
}

function getNativeHelpItems(renderNativeHelp) {
	const text = renderNativeHelp(NATIVE_HELP_CAPTURE_WIDTH)
		.map((line) => stripAnsi(line).trim())
		.filter(Boolean)
		.join(" ");
	return parseLegacyNativeHelp(text) ?? text.split(" · ").map(parseNativeHelpItem);
}

function formatHint(theme, { key, label, labelFirst }) {
	if (!key) return theme.fg("muted", label);
	return labelFirst
		? theme.fg("muted", `${label} `) + theme.fg("dim", key)
		: theme.fg("dim", key) + theme.fg("muted", ` ${label}`);
}

function renderHintRows(items, width, theme) {
	const availableWidth = Math.max(1, width);
	const indent = "  ";
	const separator = theme.fg("muted", " · ");
	const hints = items.map((item) => formatHint(theme, item));
	const rows = [];
	let row = "";

	for (const hint of hints) {
		const candidate = row
			? `${row}${separator}${hint}`
			: visibleWidth(`${indent}${hint}`) <= availableWidth
				? `${indent}${hint}`
				: hint;
		if (!row || visibleWidth(candidate) <= availableWidth) {
			row = candidate;
			continue;
		}
		rows.push(...wrapTextWithAnsi(row.trimEnd(), availableWidth));
		row = visibleWidth(`${indent}${hint}`) <= availableWidth ? `${indent}${hint}` : hint;
	}
	if (row) rows.push(...wrapTextWithAnsi(row.trimEnd(), availableWidth));
	return rows;
}

export function renderTreeHelp(renderNativeHelp, width, theme, options = {}) {
	const items = getNativeHelpItems(renderNativeHelp);
	if (Array.isArray(options.treeHints)) {
		items.push(
			...options.treeHints.filter((item) => item && typeof item.key === "string" && typeof item.label === "string"),
		);
	}
	if (options.showTreeLaunchHints) {
		items.push(...TREE_LAUNCH_ITEMS);
	}
	const result = renderHintRows(items, width, theme);
	if (options.errorMessage) {
		result.push(truncateToWidth(`  ${theme.fg("error", options.errorMessage)}`, width, "…"));
	}
	return result;
}

function validatedBootstrapPath(value) {
	if (!value) return undefined;
	const path = resolve(value);
	const directory = dirname(path);
	const tempRoot = resolve(tmpdir());
	if (basename(path) !== EDITOR_BOOTSTRAP_NAME) return undefined;
	if (dirname(directory) !== tempRoot) return undefined;
	if (!basename(directory).startsWith(EDITOR_BOOTSTRAP_PREFIX)) return undefined;
	if (!directory.startsWith(`${tempRoot}${sep}`)) return undefined;
	return path;
}

function removeBootstrap(path) {
	if (!path) return;
	rmSync(dirname(path), { recursive: true, force: true });
}

function createEditorBootstrap(text) {
	if (typeof text !== "string") return undefined;
	const directory = mkdtempSync(join(tmpdir(), EDITOR_BOOTSTRAP_PREFIX));
	const path = join(directory, EDITOR_BOOTSTRAP_NAME);
	writeFileSync(path, `${JSON.stringify({ version: 1, text })}\n`, {
		encoding: "utf8",
		mode: 0o600,
		flag: "wx",
	});
	return path;
}

export function installTreeEditorBootstrap(pi, env = process.env) {
	const path = validatedBootstrapPath(env[EDITOR_BOOTSTRAP_ENV]);
	delete env[EDITOR_BOOTSTRAP_ENV];
	if (!path) return;

	let text = undefined;
	try {
		const payload = JSON.parse(readFileSync(path, "utf8"));
		if (payload?.version === 1 && typeof payload.text === "string") {
			text = payload.text;
		}
	} catch {
		// A failed child bootstrap must not prevent TreeX from loading.
	} finally {
		removeBootstrap(path);
	}
	if (text === undefined) return;

	pi.on("session_start", (event, ctx) => {
		if (event.reason === "startup") ctx.ui.setEditorText(text);
	});
}

function persistPendingSession(sessionManager) {
	const path = sessionManager.getSessionFile();
	if (!path) throw new Error("Unable to create a file-backed child session");
	if (existsSync(path)) return path;

	const header = sessionManager.getHeader();
	if (!header) throw new Error("Unable to create the child session header");
	const entries = sessionManager.getEntries();
	const contents = [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n");
	writeFileSync(path, `${contents}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
	return path;
}

function createChildSession(SessionManager, sourceFile, sessionDir, cwd, targetId) {
	if (targetId === null) {
		const child = SessionManager.create(cwd, sessionDir);
		child.newSession({ parentSession: sourceFile });
		return persistPendingSession(child);
	}

	const child = SessionManager.open(sourceFile, sessionDir);
	const childPath = child.createBranchedSession(targetId);
	if (!childPath) throw new Error("Unable to create a file-backed child session");
	return persistPendingSession(child);
}

function tmuxEnvironmentArgs(env, editorBootstrapPath) {
	const args = [];
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined || key === "TMUX" || key === "TMUX_PANE" || key === EDITOR_BOOTSTRAP_ENV) {
			continue;
		}
		args.push("-e", `${key}=${value}`);
	}
	if (editorBootstrapPath) {
		args.push("-e", `${EDITOR_BOOTSTRAP_ENV}=${editorBootstrapPath}`);
	}
	return args;
}

function resultError(result) {
	if (result.error) return result.error.message;
	const stderr = result.stderr?.trim();
	if (stderr) return stderr.split("\n")[0];
	return `tmux exited with code ${String(result.status)}`;
}

function rollbackChildSession(path) {
	try {
		unlinkSync(path);
	} catch {
		// The unique child file may already be owned by a successfully started Pi.
	}
}

export function createTmuxTreeLauncher(SessionManager, options = {}) {
	const env = options.env ?? process.env;
	const runTmux = options.runTmux ?? ((args) => spawnSync("tmux", args, { encoding: "utf8" }));

	return {
		available: isTmuxAvailable(env),
		targetForInput,
		launch(mode, entry, target) {
			const sourceFile = mode.sessionManager.getSessionFile?.();
			if (!sourceFile || !existsSync(sourceFile)) {
				return { ok: false, error: "Wait for the first assistant response before branching" };
			}

			const isUserMessage = entry.type === "message" && entry.message.role === "user";
			const targetId = isUserMessage ? entry.parentId : entry.id;
			const editorText = isUserMessage ? mode.getUserMessageText(entry.message) : undefined;
			const sessionDir = mode.sessionManager.getSessionDir();
			const cwd = mode.sessionManager.getCwd();
			let childPath = undefined;
			let bootstrapPath = undefined;

			try {
				childPath = createChildSession(SessionManager, sourceFile, sessionDir, cwd, targetId);
				bootstrapPath = createEditorBootstrap(editorText);
				const extensionArgs = options.extensionPath ? ["-e", options.extensionPath] : [];
				const piArgs = [...extensionArgs, "--session-dir", sessionDir, "--session", childPath];
				const piEntry = process.argv[1];
				const command = piEntry ? [process.execPath, piEntry, ...piArgs] : ["pi", ...piArgs];
				const result = runTmux([
					target === "window" ? "new-window" : "split-window",
					...(target === "right" ? ["-h"] : target === "down" ? ["-v"] : []),
					"-c",
					cwd,
					...tmuxEnvironmentArgs(env, bootstrapPath),
					...command,
				]);
				if (result.status !== 0 || result.error) throw new Error(resultError(result));
				return { ok: true, childPath };
			} catch (error) {
				removeBootstrap(bootstrapPath);
				if (childPath) rollbackChildSession(childPath);
				return {
					ok: false,
					error: `Tree launch failed: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
		},
	};
}
