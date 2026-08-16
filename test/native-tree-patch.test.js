import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { visibleWidth } from "@earendil-works/pi-tui";

import {
	AssistantMessageComponent,
	BashExecutionComponent,
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	CustomMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
} from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/index.js";
import { TreeSelectorComponent } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tree-selector.js";
import { installTreeXNativePatches } from "../src/treex-component.ts";
import treexExtension from "../treex.ts";

const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
const TREE_HELP_HINTS_KEY = Symbol.for("pi:tree-help-hints");

function createTheme() {
	return {
		fg: (_name, text) => text,
		bg: (_name, text) => text,
		bold: (text) => text,
		italic: (text) => text,
	};
}

function createStyledTheme() {
	return {
		fg: (_name, text) => `\u001b[31m${text}\u001b[39m`,
		bg: (_name, text) => `\u001b[44m${text}\u001b[49m`,
		bold: (text) => `\u001b[1m${text}\u001b[22m`,
		italic: (text) => `\u001b[3m${text}\u001b[23m`,
	};
}

function createHintTheme() {
	const colors = {
		dim: "\u001b[38;2;102;102;102m",
		muted: "\u001b[38;2;128;128;128m",
	};
	return {
		fg: (name, text) => (colors[name] ? `${colors[name]}${text}\u001b[39m` : text),
		bg: (_name, text) => text,
		bold: (text) => text,
		italic: (text) => text,
	};
}

function createInteractiveModeClass() {
	return class InteractiveMode {
		constructor(rows = 24) {
			this.ui = {
				terminal: { rows },
				setFocus: (focus) => {
					this.focus = focus;
				},
				requestRender: () => {},
			};
			this.editor = { name: "editor" };
			this.editorContainer = {
				clear: () => {
					this.cleared = true;
				},
				addChild: (child) => {
					this.child = child;
				},
			};
			this.sessionManager = {
				getLeafId: () => "branch-5",
				getCwd: () => process.cwd(),
			};
		}

		getRegisteredToolDefinition() {
			return undefined;
		}

		getMarkdownThemeWithSettings() {
			return {};
		}

		getUserMessageText(message) {
			if (message.role !== "user") return "";
			if (typeof message.content === "string") return message.content;
			return message.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("");
		}

		showSelector(create) {
			const done = () => {
				this.editorContainer.clear();
				this.editorContainer.addChild(this.editor);
				this.ui.setFocus(this.editor);
			};

			const { component, focus } = create(done);
			this.editorContainer.clear();
			this.editorContainer.addChild(component);
			this.ui.setFocus(focus);
			this.ui.requestRender();
		}
	};
}

function makeNode(id, parentId, text, children = []) {
	return {
		entry: {
			id,
			parentId,
			timestamp: "2024-01-01T00:00:00.000Z",
			type: "message",
			message: {
				role: "user",
				content: text,
			},
		},
		children,
	};
}

function makeMessageNode(id, parentId, message, children = []) {
	return {
		entry: {
			id,
			parentId,
			timestamp: "2024-01-01T00:00:00.000Z",
			type: "message",
			message,
		},
		children,
	};
}

function collectEntries(tree) {
	const entries = [];
	const stack = [...tree].reverse();

	while (stack.length > 0) {
		const node = stack.pop();
		entries.push(node.entry);
		for (let index = node.children.length - 1; index >= 0; index--) {
			stack.push(node.children[index]);
		}
	}

	return entries;
}

function getBranchEntries(tree, entryId) {
	const entries = collectEntries(tree);
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const branch = [];
	let currentId = entryId;

	while (currentId) {
		const entry = byId.get(currentId);
		if (!entry) break;
		branch.push(entry);
		currentId = entry.parentId;
	}

	return branch.reverse();
}

function createTree() {
	const branch8 = makeNode("branch-8", "branch-7", "branch message 8");
	const branch7 = makeNode("branch-7", "branch-6", "branch message 7", [branch8]);
	const branch6 = makeNode("branch-6", "branch-5", "branch message 6", [branch7]);
	const branch5 = makeNode("branch-5", "branch-4", "selected branch message", [branch6]);
	const branch4 = makeNode("branch-4", "branch-3", "branch message 4", [branch5]);
	const branch3 = makeNode("branch-3", "branch-2", "branch message 3", [branch4]);
	const branch2 = makeNode("branch-2", "branch-1", "branch message 2", [branch3]);
	const branch1 = makeNode("branch-1", "branch", "branch message 1", [branch2]);
	const branch = makeNode("branch", "root", "branch start", [branch1]);
	const sibling = makeNode("sibling", "root", "sibling branch");
	const root = makeNode("root", null, "root", [branch, sibling]);
	return [root];
}

function createToolResultTree() {
	const toolResult = makeMessageNode("tool-result", "assistant-tool-call", {
		role: "toolResult",
		toolCallId: "call-bash-1",
		toolName: "bash",
		content: [{ type: "text", text: "line 1\nline 2" }],
		isError: false,
	});
	const assistantToolCall = makeMessageNode(
		"assistant-tool-call",
		"user-root",
		{
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call-bash-1",
					name: "bash",
					arguments: { command: "echo hello" },
				},
			],
			stopReason: "toolUse",
		},
		[toolResult],
	);
	const userRoot = makeNode("user-root", null, "run the command", [assistantToolCall]);
	return [userRoot];
}

function createBashExecutionTree() {
	const bash = makeMessageNode("bash-detail", "user-root", {
		role: "bashExecution",
		command: "npm test",
		output: "line 1\nline 2",
		exitCode: 0,
		cancelled: false,
	});
	const userRoot = makeNode("user-root", null, "run tests", [bash]);
	return [userRoot];
}

function createAssistantDetailTree() {
	const assistant = makeMessageNode("assistant-detail", "user-root", {
		role: "assistant",
		content: [{ type: "text", text: "Hello\n\nI am the assistant\nAnd I'm here to help you" }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-test",
		usage: {
			input: 12000,
			output: 345,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 12345,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		stopReason: "stop",
		timestamp: 1704067200000,
	});
	const userRoot = makeNode("user-root", null, "say hello", [assistant]);
	return [userRoot];
}

function createNativeComponents({
	assistantMessageComponent = AssistantMessageComponent,
	bashExecutionComponent = BashExecutionComponent,
	branchSummaryMessageComponent = BranchSummaryMessageComponent,
	compactionSummaryMessageComponent = CompactionSummaryMessageComponent,
	customMessageComponent = CustomMessageComponent,
	toolExecutionComponent = ToolExecutionComponent,
	userMessageComponent = UserMessageComponent,
} = {}) {
	return {
		assistantMessageComponent,
		bashExecutionComponent,
		branchSummaryMessageComponent,
		compactionSummaryMessageComponent,
		customMessageComponent,
		toolExecutionComponent,
		userMessageComponent,
	};
}

function renderWrappedTree({
	tree = createTree(),
	leafId = "branch-5",
	initialSelectedId,
	filterMode,
	keybindings = { matches: () => false },
	nativeComponents = createNativeComponents(),
	theme = createTheme(),
	modelRegistry = { find: () => undefined },
	modelRuntime = { getModel: () => undefined },
	outputPad = 1,
	rows = 24,
	treeHelpHints = [],
	width = 80,
} = {}) {
	globalThis[THEME_KEY] = theme;

	const InteractiveMode = createInteractiveModeClass();
	installTreeXNativePatches(InteractiveMode, nativeComponents);

	const mode = new InteractiveMode(rows);
	mode.keybindings = keybindings;
	mode.outputPad = outputPad;
	const entries = collectEntries(tree);
	mode.sessionManager.getEntries = () => entries;
	mode.sessionManager.getBranch = (entryId = leafId) => getBranchEntries(tree, entryId);
	mode.session = {
		sessionManager: mode.sessionManager,
		modelRegistry,
		modelRuntime,
	};

	const selector = new TreeSelectorComponent(
		tree,
		leafId,
		rows,
		() => {},
		() => {},
		() => {},
		initialSelectedId,
		filterMode,
	);
	selector[TREE_HELP_HINTS_KEY] = treeHelpHints;

	mode.showSelector(() => ({ component: selector, focus: selector }));
	return { mode, selector, lines: mode.child.render(width) };
}

function simulateWrappedTreeHelp(selector) {
	const helpLines = ["extra help one", "extra help two", "extra help three", "extra help four"];
	const renderNativeSelector = selector.render.bind(selector);
	selector.render = (width) => {
		const lines = renderNativeSelector(width);
		lines.splice(4, 0, ...helpLines);
		return lines;
	};
	return helpLines;
}

function findLine(lines, text) {
	return lines.find((line) => line.includes(text));
}

test("native tree patch can be removed and reinstalled", () => {
	const InteractiveMode = createInteractiveModeClass();
	const originalShowSelector = InteractiveMode.prototype.showSelector;
	const nativeComponents = createNativeComponents();

	const firstUnpatch = installTreeXNativePatches(InteractiveMode, nativeComponents);
	assert.notEqual(InteractiveMode.prototype.showSelector, originalShowSelector);

	firstUnpatch();
	assert.equal(InteractiveMode.prototype.showSelector, originalShowSelector);

	const secondUnpatch = installTreeXNativePatches(InteractiveMode, nativeComponents);
	assert.notEqual(InteractiveMode.prototype.showSelector, originalShowSelector);

	secondUnpatch();
	assert.equal(InteractiveMode.prototype.showSelector, originalShowSelector);
});

test("native tree patch wraps the real tree selector and renders without crashing", () => {
	const { mode, selector, lines } = renderWrappedTree();
	const wrapper = mode.child;
	const detailHeader = findLine(lines, "DEPTH");

	assert.notEqual(wrapper, selector);
	assert.equal(mode.focus, wrapper);
	assert.notEqual(lines[0], "");
	assert.ok(lines[0].includes("─"));
	assert.ok(findLine(lines, "depth 3"));
	assert.ok(lines.some((line) => line.includes("selected branch message")));
	assert.ok(lines.some((line) => line.includes("CURRENT")));
	assert.match(detailHeader ?? "", /\d+\/\d+ · DEPTH \d+ · CURRENT\s+│\s+USER/);
	assert.ok(findLine(lines, "selected branch message")?.startsWith("◆ "));
});

test("sticky-left removes the final indentation level on narrow terminals", () => {
	const { mode, lines: wideLines } = renderWrappedTree();
	const narrowLines = mode.child.render(40);
	const narrowCurrentLine = findLine(narrowLines, "selected branch message");
	const wideCurrentLine = findLine(wideLines, "selected branch message");

	assert.ok(narrowCurrentLine);
	assert.ok(wideCurrentLine);
	assert.equal(narrowCurrentLine.indexOf("• user:"), 2);
	assert.equal(wideCurrentLine.indexOf("• user:"), 5);
});

test("selector chrome is measured before placing the sticky-left status", () => {
	const { mode, selector } = renderWrappedTree();
	const wrappedHelpLines = simulateWrappedTreeHelp(selector);
	const lines = mode.child.render(80);
	const stickyStatusIndex = lines.findIndex((line) => line.includes("depth 3"));
	const firstTreeRowIndex = lines.findIndex((line) => line.includes("branch message 2"));

	for (const helpLine of wrappedHelpLines) {
		assert.ok(lines.includes(helpLine));
	}
	assert.equal(stickyStatusIndex + 1, firstTreeRowIndex);
	assert.ok(lines.some((line) => line.includes("Type to search:")));
});

test("expanded detail layout accounts for wrapped selector chrome", () => {
	const { mode, selector } = renderWrappedTree();
	simulateWrappedTreeHelp(selector);
	mode.child.handleInput("\x12");
	const lines = mode.child.render(80);

	assert.equal(lines.length, mode.ui.terminal.rows);
	assert.ok(lines.some((line) => line.includes("FULL USER MESSAGE")));
});

test("tree status is folded into the detail header", () => {
	const { lines } = renderWrappedTree({ filterMode: "no-tools" });
	const detailHeader = findLine(lines, "DEPTH");

	const detailHeaderIndex = lines.findIndex((line) => line.includes("DEPTH"));

	assert.match(detailHeader ?? "", /\d+\/\d+ · \[no-tools\] · DEPTH \d+/);
	assert.ok(!lines.some((line) => line.trim().startsWith("(") && line.includes("[no-tools]")));
	assert.ok(lines[detailHeaderIndex - 1]?.includes("─"));
});

test("current row gets an accent marker when it is visible but not selected", () => {
	const { lines } = renderWrappedTree({ initialSelectedId: "branch-6" });
	const currentLine = findLine(lines, "selected branch message");
	const detailHeader = findLine(lines, "DEPTH");

	assert.ok(currentLine?.startsWith("◆ "));
	assert.ok(currentLine?.includes("│     • user: selected branch message"));
	assert.ok(lines.some((line) => line.includes("↑ CURRENT")));
	assert.match(detailHeader ?? "", /DEPTH \d+ · ↑ CURRENT\s+│/);
});

test("detail pane shows when current is below the selected row", () => {
	const { lines } = renderWrappedTree({ initialSelectedId: "branch-4" });
	const detailHeader = findLine(lines, "DEPTH");

	assert.ok(lines.some((line) => line.includes("↓ CURRENT")));
	assert.match(detailHeader ?? "", /DEPTH \d+ · ↓ CURRENT\s+│/);
});

test("current row marker stays visible when its surrounding branch is folded", () => {
	const { mode } = renderWrappedTree();
	const treeList = mode.child.treeList;

	treeList.foldedNodes.add("branch-4");
	treeList.applyFilter();

	const lines = mode.child.render(80);
	const currentLine = findLine(lines, "branch message 4");

	assert.ok(!lines.some((line) => line.includes("selected branch message")));
	assert.ok(currentLine?.startsWith("◆ "));
	assert.ok(currentLine?.includes("branch message 4"));
});

test("current row marker is hidden when search filters out the current row", () => {
	const { mode } = renderWrappedTree({ initialSelectedId: "branch-4" });
	const treeList = mode.child.treeList;

	treeList.searchQuery = "branch message 4";
	treeList.applyFilter();

	const lines = mode.child.render(80);
	const detailHeader = findLine(lines, "DEPTH");

	assert.ok(!lines.some((line) => line.startsWith("◆ ")));
	assert.match(detailHeader ?? "", /DEPTH \d+ · ↓ CURRENT\s+│/);
});

test("tool result detail pane prioritizes result lines over the tool command", () => {
	const { lines } = renderWrappedTree({
		tree: createToolResultTree(),
		leafId: "tool-result",
		initialSelectedId: "tool-result",
		filterMode: "all",
		theme: createStyledTheme(),
	});

	assert.ok(!lines.some((line) => line.includes("$ echo hello")));
	assert.ok(lines.some((line) => line.includes("line 1")));
	assert.ok(lines.some((line) => line.includes("line 2")));
});

test("bash preview shows output without command/status chrome", () => {
	const { lines, mode } = renderWrappedTree({
		tree: createBashExecutionTree(),
		leafId: "bash-detail",
		initialSelectedId: "bash-detail",
		filterMode: "all",
	});

	assert.ok(lines.some((line) => line.includes("line 1")));
	assert.ok(lines.some((line) => line.includes("line 2")));
	assert.ok(!lines.some((line) => line.includes("$ npm test")));

	mode.child.handleInput("\x12");
	const expandedLines = mode.child.render(80);
	assert.ok(expandedLines.some((line) => line.includes("$ npm test")));
});

test("assistant detail uses ModelRuntime context and removes blank lines", () => {
	const { lines } = renderWrappedTree({
		tree: createAssistantDetailTree(),
		leafId: "assistant-detail",
		initialSelectedId: "assistant-detail",
		filterMode: "all",
		modelRuntime: {
			getModel(provider, modelId) {
				if (provider === "openai" && modelId === "gpt-test") {
					return { contextWindow: 100000 };
				}
				return undefined;
			},
		},
	});

	assert.ok(lines.some((line) => line.includes("12.3%/100k")));
	assert.ok(lines.some((line) => line.includes("Hello")));
	assert.ok(lines.some((line) => line.includes("I am the assistant")));
	assert.ok(lines.some((line) => line.includes("And I'm here to help you")));
});

test("detail pane resolves model context through ModelRuntime", () => {
	const { lines } = renderWrappedTree({
		tree: createAssistantDetailTree(),
		leafId: "assistant-detail",
		initialSelectedId: "assistant-detail",
		filterMode: "all",
		modelRegistry: null,
		modelRuntime: {
			getModel(provider, modelId) {
				if (provider === "openai" && modelId === "gpt-test") {
					return { contextWindow: 100000 };
				}
				return undefined;
			},
		},
	});

	assert.ok(lines.some((line) => line.includes("12.3%/100k")));
});

test("detail pane falls back to legacy model registry", () => {
	const { lines } = renderWrappedTree({
		tree: createAssistantDetailTree(),
		leafId: "assistant-detail",
		initialSelectedId: "assistant-detail",
		filterMode: "all",
		modelRuntime: null,
		modelRegistry: {
			find(provider, modelId) {
				if (provider === "openai" && modelId === "gpt-test") {
					return { contextWindow: 100000 };
				}
				return undefined;
			},
		},
	});

	assert.ok(lines.some((line) => line.includes("12.3%/100k")));
});

test("custom entry string data renders as human text", () => {
	const tree = [
		{
			entry: {
				id: "custom-human",
				parentId: null,
				timestamp: "2024-01-01T00:00:00.000Z",
				type: "custom",
				customType: "note",
				data: "first line\nsecond line",
			},
			children: [],
		},
	];

	const { lines } = renderWrappedTree({
		tree,
		leafId: "custom-human",
		initialSelectedId: "custom-human",
		filterMode: "all",
	});

	const rendered = lines.join("\n");
	assert.match(rendered, /first line/);
	assert.match(rendered, /second line/);
	assert.doesNotMatch(rendered, /\\n/);
});

test("detail pane shows an inline review hint when content is truncated", () => {
	const truncatedTree = [
		makeMessageNode("long-assistant", null, {
			role: "assistant",
			content: [{ type: "text", text: "one\ntwo\nthree\nfour" }],
			stopReason: "stop",
		}),
	];
	const shortTree = [
		makeMessageNode("short-assistant", null, {
			role: "assistant",
			content: [{ type: "text", text: "one\ntwo\nthree" }],
			stopReason: "stop",
		}),
	];

	const { lines: truncatedLines } = renderWrappedTree({
		tree: truncatedTree,
		leafId: "long-assistant",
		initialSelectedId: "long-assistant",
		filterMode: "all",
	});
	const { lines: shortLines } = renderWrappedTree({
		tree: shortTree,
		leafId: "short-assistant",
		initialSelectedId: "short-assistant",
		filterMode: "all",
	});

	assert.ok(truncatedLines.some((line) => line.includes("Ctrl+R full")));
	assert.ok(!shortLines.some((line) => line.includes("Ctrl+R full")));
});

test("ctrl+r toggles a full detail drawer", () => {
	const tree = [
		makeMessageNode("long-assistant", null, {
			role: "assistant",
			content: [{ type: "text", text: "one\ntwo\nthree\nfour" }],
			stopReason: "stop",
		}),
	];
	const { mode } = renderWrappedTree({
		tree,
		leafId: "long-assistant",
		initialSelectedId: "long-assistant",
		filterMode: "all",
	});

	mode.child.handleInput("\x12");

	assert.equal(mode.focus, mode.child);
	assert.equal(mode.child.expandedDetail.expanded, true);
	const expandedLines = mode.child.render(60);
	assert.ok(expandedLines.some((line) => line.includes("FULL ASSISTANT MESSAGE")));
	assert.ok(expandedLines.some((line) => line.includes("one")));
	assert.ok(expandedLines.some((line) => line.includes("two")));
	assert.ok(expandedLines.some((line) => line.includes("three")));
	assert.ok(expandedLines.some((line) => line.includes("four")));
	assert.ok(expandedLines.some((line) => line.includes("Esc/Ctrl+R collapse")));

	mode.child.handleInput("\x1b");
	assert.equal(mode.child.expandedDetail.expanded, false);
});

test("detail pane pluralizes relative time metadata", () => {
	const cases = [
		{ ageMs: 3 * 60 * 1000, expected: "3 MINS AGO", unexpected: "3 MIN AGO" },
		{ ageMs: 3 * 60 * 60 * 1000, expected: "3 HRS AGO", unexpected: "3 HR AGO" },
		{ ageMs: 3 * 24 * 60 * 60 * 1000, expected: "3 DAYS AGO", unexpected: "3 DAY AGO" },
		{ ageMs: 3 * 30 * 24 * 60 * 60 * 1000, expected: "3 MOS AGO", unexpected: "3 MO AGO" },
		{ ageMs: 2 * 12 * 30 * 24 * 60 * 60 * 1000, expected: "2 YRS AGO", unexpected: "2 YR AGO" },
	];

	for (const { ageMs, expected, unexpected } of cases) {
		const tree = [makeNode("recent-root", null, "recent message")];
		tree[0].entry.timestamp = new Date(Date.now() - ageMs).toISOString();

		const { lines } = renderWrappedTree({
			tree,
			leafId: "recent-root",
			initialSelectedId: "recent-root",
			filterMode: "all",
		});

		assert.ok(lines.some((line) => line.includes(expected)));
		assert.ok(!lines.some((line) => line.includes(unexpected)));
	}
});

test("detail message components receive pi's configured output padding", () => {
	const constructorOutputPads = [];
	class TrackingUserMessageComponent {
		constructor(_text, _theme, outputPad) {
			constructorOutputPads.push(["user", outputPad]);
		}

		render() {
			return ["tracked user message"];
		}
	}

	class TrackingAssistantMessageComponent {
		constructor(_message, _hideThinking, _theme, _hiddenThinkingLabel, outputPad) {
			constructorOutputPads.push(["assistant", outputPad]);
		}

		render() {
			return ["tracked assistant message"];
		}
	}

	renderWrappedTree({
		nativeComponents: createNativeComponents({ userMessageComponent: TrackingUserMessageComponent }),
		outputPad: 3,
	});
	renderWrappedTree({
		tree: createAssistantDetailTree(),
		leafId: "assistant-detail",
		initialSelectedId: "assistant-detail",
		nativeComponents: createNativeComponents({
			assistantMessageComponent: TrackingAssistantMessageComponent,
		}),
		outputPad: 3,
	});

	assert.deepEqual(constructorOutputPads, [
		["user", 3],
		["assistant", 3],
	]);
});

test("detail pane can render user messages with native styling", () => {
	const { lines } = renderWrappedTree({
		tree: createAssistantDetailTree(),
		leafId: "assistant-detail",
		initialSelectedId: "user-root",
		theme: createStyledTheme(),
	});

	assert.ok(lines.some((line) => line.includes("\u001b[44m")));
	assert.ok(lines.some((line) => line.includes("say hello")));
});

test("configured tree hotkey toggles the picker closed", () => {
	const matches = [];
	const { mode } = renderWrappedTree({
		keybindings: {
			matches: (keyData, action) => {
				matches.push([keyData, action]);
				return keyData === "configured-tree-key" && action === "app.session.tree";
			},
		},
	});

	mode.child.handleInput("configured-tree-key");

	assert.equal(mode.child, mode.editor);
	assert.deepEqual(matches, [["configured-tree-key", "app.session.tree"]]);
});

test("tmux launch hints render and a successful launch closes the picker", () => {
	let launched;
	const treeLauncher = {
		available: true,
		targetForInput: (keyData) => (keyData === "\x1b[115;7u" ? "down" : undefined),
		launch: (mode, entry, target) => {
			launched = { mode, entry, target };
			return { ok: true };
		},
	};
	const tree = [makeNode("user-root", null, "initial prompt")];
	const { mode, lines } = renderWrappedTree({
		tree,
		leafId: "user-root",
		initialSelectedId: "user-root",
		nativeComponents: { ...createNativeComponents(), treeLauncher },
	});

	assert.ok(lines.some((line) => line.includes("ctrl+alt+s sp")));
	assert.ok(lines.some((line) => line.includes("ctrl+alt+v vsp")));
	assert.ok(lines.some((line) => line.includes("ctrl+alt+w win")));
	const wrapper = mode.child;
	wrapper.expandedDetail.toggle();
	wrapper.handleInput("\x1b[115;7u");
	assert.equal(launched.entry.id, "user-root");
	assert.equal(launched.target, "down");
	assert.equal(mode.child, mode.editor);
});

test("builtin and tmux key hints share one semantic line and color", () => {
	const treeLauncher = {
		available: true,
		targetForInput: () => undefined,
	};
	const { lines } = renderWrappedTree({
		nativeComponents: { ...createNativeComponents(), treeLauncher },
		theme: createHintTheme(),
		width: 300,
	});
	const builtinHintLine = lines.find((line) => line.includes("↑/↓"));
	const launchHintLine = lines.find((line) => line.includes("ctrl+alt+s"));

	assert.ok(launchHintLine?.includes("cycle"));
	assert.ok(builtinHintLine?.includes("\u001b[38;2;102;102;102m↑/↓\u001b[39m"), JSON.stringify(builtinHintLine));
	assert.ok(builtinHintLine?.includes("\u001b[38;2;128;128;128m move\u001b[39m"));
	assert.ok(launchHintLine?.includes("\u001b[38;2;102;102;102mctrl+alt+s\u001b[39m"));
	assert.ok(launchHintLine?.includes("\u001b[38;2;128;128;128m sp\u001b[39m"));
});

test("tree delete hint renders between builtin and tmux hints", () => {
	const treeLauncher = {
		available: true,
		targetForInput: () => undefined,
	};
	const { mode, lines } = renderWrappedTree({
		nativeComponents: { ...createNativeComponents(), treeLauncher },
		treeHelpHints: [{ key: "option+d", label: "delete" }],
		width: 300,
	});
	const rendered = lines.join("\n");

	assert.ok(rendered.indexOf("cycle") < rendered.indexOf("option+d delete"));
	assert.ok(rendered.indexOf("option+d delete") < rendered.indexOf("ctrl+alt+s sp"));
	const narrowRendered = mode.child.render(44).join("\n");
	assert.ok(narrowRendered.includes("option+d delete"));
	assert.ok(narrowRendered.includes("ctrl+alt+w win"));
});

test("tmux launch hints wrap within a narrow picker", () => {
	const treeLauncher = {
		available: true,
		targetForInput: () => undefined,
	};
	const { mode } = renderWrappedTree({
		nativeComponents: { ...createNativeComponents(), treeLauncher },
		width: 44,
	});
	const lines = mode.child.render(44);
	const rendered = lines.join("\n");

	assert.ok(lines.every((line) => visibleWidth(line) <= 44));
	assert.ok(lines.length <= mode.ui.terminal.rows);
	assert.ok(rendered.includes("ctrl+alt+s sp"));
	assert.ok(rendered.includes("ctrl+alt+v vsp"));
	assert.ok(rendered.includes("ctrl+alt+w win"));
});

test("tmux launch hints stay visible on a short terminal", () => {
	const treeLauncher = {
		available: true,
		targetForInput: () => undefined,
	};
	const { mode, lines } = renderWrappedTree({
		nativeComponents: { ...createNativeComponents(), treeLauncher },
		rows: 16,
		width: 100,
	});
	const rendered = lines.join("\n");

	assert.ok(lines.length <= mode.ui.terminal.rows);
	assert.ok(rendered.includes("ctrl+alt+s sp"));
	assert.ok(rendered.includes("ctrl+alt+v vsp"));
	assert.ok(rendered.includes("ctrl+alt+w win"));
});

test("tmux launch failure stays in the picker with an inline error", () => {
	const treeLauncher = {
		available: true,
		targetForInput: (keyData) => (keyData === "\x1b[118;7u" ? "right" : undefined),
		launch: () => ({ ok: false, error: "Tree launch failed: no pane available" }),
	};
	const { mode } = renderWrappedTree({
		nativeComponents: { ...createNativeComponents(), treeLauncher },
	});
	const wrapper = mode.child;

	wrapper.handleInput("\x1b[118;7u");
	assert.equal(mode.child, wrapper);
	assert.ok(wrapper.render(80).some((line) => line.includes("Tree launch failed: no pane available")));

	wrapper.handleInput("x");
	assert.ok(!wrapper.render(80).some((line) => line.includes("Tree launch failed: no pane available")));
});

test("tmux launch hints stay hidden outside tmux", () => {
	const { lines } = renderWrappedTree({
		nativeComponents: {
			...createNativeComponents(),
			treeLauncher: { available: false, targetForInput: () => undefined },
		},
	});
	assert.ok(!lines.some((line) => line.includes("ctrl+alt+s")));
});

test("treex entry loads components from the host entry point", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-treex-host-"));
	const distDir = join(tempDir, "dist");
	const binDir = join(tempDir, "bin");
	const realCliPath = join(distDir, "cli.js");
	const symlinkCliPath = join(binDir, "pi");
	const indexPath = join(distDir, "index.js");

	await mkdir(distDir, { recursive: true });
	await mkdir(binDir, { recursive: true });
	await writeFile(join(tempDir, "package.json"), '{"type":"module"}\n');
	await writeFile(realCliPath, "export {};\n");
	await symlink("../dist/cli.js", symlinkCliPath);
	await writeFile(
		indexPath,
		[
			"export class InteractiveMode {",
			"  showSelector(create) {",
			"    return create(() => {});",
			"  }",
			"}",
			"export class AssistantMessageComponent {}",
			"export class BashExecutionComponent {}",
			"export class BranchSummaryMessageComponent {}",
			"export class CompactionSummaryMessageComponent {}",
			"export class CustomMessageComponent {}",
			"export class ToolExecutionComponent {}",
			"export class UserMessageComponent {}",
		].join("\n"),
	);

	const originalArgv1 = process.argv[1];
	process.argv[1] = symlinkCliPath;

	try {
		const hostModule = await import(pathToFileURL(indexPath).href);
		const before = hostModule.InteractiveMode.prototype.showSelector;
		const handlers = new Map();

		await treexExtension({
			on(event, handler) {
				handlers.set(event, handler);
			},
		});
		assert.notEqual(hostModule.InteractiveMode.prototype.showSelector, before);

		assert.ok(handlers.has("session_shutdown"));
		await handlers.get("session_shutdown")();
		assert.equal(hostModule.InteractiveMode.prototype.showSelector, before);

		await treexExtension({
			on(event, handler) {
				handlers.set(event, handler);
			},
		});
		assert.notEqual(hostModule.InteractiveMode.prototype.showSelector, before);
	} finally {
		process.argv[1] = originalArgv1;
	}
});
