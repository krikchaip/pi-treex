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

const LAYOUT_NODE = Symbol.for("@earendil-works/pi-tui/layout-node");
const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
const TREE_HELP_HINTS_KEY = Symbol.for("pi:tree-help-hints");

function createFixedComponent(lines) {
	return {
		render: () => [...lines],
	};
}

function createVStack(entries) {
	return {
		[LAYOUT_NODE]() {
			return { type: "vstack", entries };
		},
		render(width) {
			return entries
				.filter((entry) => entry.visible?.({ width, height: Number.MAX_SAFE_INTEGER }) ?? true)
				.flatMap((entry) => entry.component.render(width));
		},
	};
}

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
			const lifecycle = {};
			const done = () => {
				lifecycle.dispose?.();
				this.editorContainer.clear();
				this.editorContainer.addChild(this.editor);
				this.ui.setFocus(this.editor);
			};

			const created = create(done);
			lifecycle.dispose = created.dispose;
			this.activeSelectorDispose = created.dispose;
			this.editorContainer.clear();
			this.editorContainer.addChild(created.component);
			this.ui.setFocus(created.focus);
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

test("native and detail borders use the theme accent", () => {
	const theme = {
		...createTheme(),
		fg: (name, text) => (name === "accent" ? `accent:${text}` : text),
	};
	const { selector, lines } = renderWrappedTree({ theme });
	const nativeBorders = selector.children.filter((child) => child?.constructor?.name === "DynamicBorder");

	assert.ok(nativeBorders.length > 0);
	assert.ok(nativeBorders.every((border) => border.color("─") === "accent:─"));
	assert.ok(lines.at(-1)?.startsWith("accent:"));
});

test("collapsed detail keeps metadata above a bordered eight-line body", () => {
	const content = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n");
	const tree = [
		makeMessageNode("long-assistant", null, {
			role: "assistant",
			content: [{ type: "text", text: content }],
			stopReason: "stop",
		}),
	];
	const { lines } = renderWrappedTree({
		tree,
		leafId: "long-assistant",
		initialSelectedId: "long-assistant",
		filterMode: "all",
		rows: 40,
		width: 100,
	});
	const metadataIndex = lines.findIndex((line) => line.includes("DEPTH"));
	const treeBorderIndex = lines.findLastIndex((line, index) => index < metadataIndex && line.includes("─"));

	assert.equal(metadataIndex, treeBorderIndex + 1);
	assert.ok(lines[metadataIndex + 1].includes("─"));
	assert.equal(lines.length - metadataIndex, 11);
	assert.ok(lines[metadataIndex + 2].includes("line 1"));
	assert.ok(lines[metadataIndex + 9].includes("line 8"));
	assert.equal(visibleWidth(lines[metadataIndex]), 100);
	assert.ok(lines[metadataIndex].endsWith("… Ctrl+R full"));
	assert.ok(lines.at(-1)?.includes("─"));
});

test("collapsed detail is completely hidden on short screens", () => {
	const { lines } = renderWrappedTree({ rows: 16, width: 100 });

	assert.ok(!lines.some((line) => line.includes("DEPTH")));
	assert.ok(!lines.some((line) => line.includes("Ctrl+R full")));
	assert.equal(lines.filter((line) => line.includes("selected branch message")).length, 1);
});

test("collapsed and expanded details share native body lines and metadata", () => {
	class TrackingAssistantMessageComponent {
		render() {
			return ["native first", "", "native third"];
		}
	}
	const tree = [
		makeMessageNode("assistant", null, {
			role: "assistant",
			content: [{ type: "text", text: "ignored" }],
			stopReason: "stop",
		}),
	];
	const { mode, lines: collapsedLines } = renderWrappedTree({
		tree,
		leafId: "assistant",
		initialSelectedId: "assistant",
		filterMode: "all",
		nativeComponents: createNativeComponents({
			assistantMessageComponent: TrackingAssistantMessageComponent,
		}),
		rows: 40,
		width: 100,
	});
	const collapsedBodyIndex = collapsedLines.findIndex((line) => line.includes("native first"));
	const collapsedMetadataLine = findLine(collapsedLines, "DEPTH");
	const expandHintIndex = collapsedMetadataLine.indexOf("… Ctrl+R full");
	const collapsedMetadata = collapsedMetadataLine.slice(0, expandHintIndex).trimEnd();

	assert.equal(collapsedLines[collapsedBodyIndex + 1], "".padEnd(100));
	assert.ok(collapsedLines[collapsedBodyIndex + 2].includes("native third"));

	mode.child.handleInput("\x12");
	const expandedLines = mode.child.render(100);
	const expandedBodyIndex = expandedLines.findIndex((line) => line.includes("native first"));
	const expandedMetadataIndex = expandedLines.findIndex((line) => line.includes("DEPTH"));
	const expandedMetadataLine = expandedLines[expandedMetadataIndex];
	const navigationIndex = expandedLines.findIndex((line) => line.includes("↑↓ scroll"));
	const navigationLine = expandedLines[navigationIndex];

	assert.equal(expandedMetadataIndex + 2, expandedBodyIndex);
	assert.equal(expandedLines[expandedBodyIndex + 1], "".padEnd(100));
	assert.ok(expandedLines[expandedBodyIndex + 2].includes("native third"));
	assert.equal(expandedMetadataLine.trimEnd(), collapsedMetadata);
	assert.ok(!expandedMetadataLine.includes("Ctrl+R"));
	assert.ok(expandedLines[expandedMetadataIndex + 1].includes("─"));
	assert.ok(expandedLines[navigationIndex - 1].includes("─"));
	assert.ok(navigationLine.includes("Esc/Ctrl+R collapse"));
});

test("sticky-left removes the final indentation level on narrow terminals", () => {
	const { mode, lines: wideLines } = renderWrappedTree({ rows: 16 });
	const narrowLines = mode.child.render(40);
	const narrowCurrentLine = findLine(narrowLines, "selected branch message");
	const wideCurrentLine = findLine(wideLines, "selected branch message");

	assert.ok(narrowCurrentLine);
	assert.ok(wideCurrentLine);
	assert.equal(narrowCurrentLine.indexOf("• user:"), 2);
	assert.equal(wideCurrentLine.indexOf("• user:"), 5);
});

test("selector chrome is measured before placing the sticky-left status", () => {
	const { mode, selector } = renderWrappedTree({ rows: 16 });
	const wrappedHelpLines = simulateWrappedTreeHelp(selector);
	const lines = mode.child.render(80);
	const stickyStatusIndex = lines.findIndex((line) => line.includes("depth 3"));
	const firstTreeRowIndex = lines.findIndex((line, index) => index > stickyStatusIndex && line.includes("• user:"));

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
	assert.ok(lines.some((line) => line.includes("DEPTH")));
	assert.ok(lines.some((line) => line.includes("Esc/Ctrl+R collapse")));
});

test("tree status is folded into the detail header", () => {
	const { lines } = renderWrappedTree({ filterMode: "no-tools" });
	const detailHeader = findLine(lines, "DEPTH");

	const detailHeaderIndex = lines.findIndex((line) => line.includes("DEPTH"));

	assert.match(detailHeader ?? "", /\d+\/\d+ · \[no-tools\] · DEPTH \d+/);
	assert.ok(!lines.some((line) => line.trim().startsWith("(") && line.includes("[no-tools]")));
	assert.ok(lines[detailHeaderIndex + 1]?.includes("─"));
});

test("current row gets an accent marker when it is visible but not selected", () => {
	const { lines } = renderWrappedTree({ initialSelectedId: "branch-6" });
	const currentLine = findLine(lines, "selected branch message");
	const detailHeader = findLine(lines, "DEPTH");

	assert.ok(currentLine?.startsWith("◆ "));
	assert.ok(currentLine?.includes("• user: selected branch message"));
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

test("bash detail uses the same native rendering in both preview modes", () => {
	const { lines, mode } = renderWrappedTree({
		tree: createBashExecutionTree(),
		leafId: "bash-detail",
		initialSelectedId: "bash-detail",
		filterMode: "all",
	});

	assert.ok(lines.some((line) => line.includes("line 1")));
	assert.ok(lines.some((line) => line.includes("line 2")));
	assert.ok(lines.some((line) => line.includes("$ npm test")));

	mode.child.handleInput("\x12");
	const expandedLines = mode.child.render(80);
	assert.ok(expandedLines.some((line) => line.includes("$ npm test")));
});

test("assistant detail uses ModelRuntime context with native rendering", () => {
	const { lines } = renderWrappedTree({
		tree: createAssistantDetailTree(),
		leafId: "assistant-detail",
		initialSelectedId: "assistant-detail",
		filterMode: "all",
		width: 100,
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
		width: 100,
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
		width: 100,
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

test("detail metadata always shows the right-aligned review hint", () => {
	const truncatedTree = [
		makeMessageNode("long-assistant", null, {
			role: "assistant",
			content: [{ type: "text", text: Array.from({ length: 9 }, (_, index) => `line ${index + 1}`).join("\n") }],
			stopReason: "stop",
		}),
	];
	const shortTree = [
		makeMessageNode("short-assistant", null, {
			role: "assistant",
			content: [{ type: "text", text: Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n") }],
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
	assert.ok(shortLines.some((line) => line.includes("Ctrl+R full")));
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
	const expandedLines = mode.child.render(80);
	assert.ok(expandedLines.some((line) => line.includes("DEPTH")));
	assert.ok(!expandedLines.some((line) => line.includes("FULL ASSISTANT MESSAGE")));
	assert.ok(expandedLines.some((line) => line.includes("one")));
	assert.ok(expandedLines.some((line) => line.includes("two")));
	assert.ok(expandedLines.some((line) => line.includes("three")));
	assert.ok(expandedLines.some((line) => line.includes("four")));
	assert.ok(expandedLines.some((line) => line.includes("Esc/Ctrl+R collapse")));

	mode.child.handleInput("\x1b");
	assert.equal(mode.child.expandedDetail.expanded, false);
});

test("expanded detail footer matches resume ordering, color, and border placement", () => {
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
		theme: createHintTheme(),
	});

	mode.child.handleInput("\x12");
	const expandedLines = mode.child.render(80);
	const metadataIndex = expandedLines.findIndex((line) => line.includes("DEPTH"));
	const hintIndex = expandedLines.findIndex((line) => line.includes("Esc/Ctrl+R collapse"));
	const hintLine = expandedLines[hintIndex];

	assert.ok(metadataIndex > 0);
	assert.ok(expandedLines[metadataIndex + 1].includes("─"));
	const dimPrefix = "\u001b[38;2;102;102;102m";
	const colorReset = "\u001b[39m";
	assert.ok(hintLine.startsWith(dimPrefix), JSON.stringify(hintLine));
	const plainHint = hintLine.slice(dimPrefix.length, hintLine.indexOf(colorReset));
	assert.match(plainHint, /^1-\d+\/\d+ · ↑↓ scroll · ←\/→ page · Home\/End · Esc\/Ctrl\+R collapse$/);
	assert.ok(expandedLines[hintIndex - 1].includes("─"));
	assert.ok(!expandedLines[hintIndex + 1]?.includes("─"));
});

test("expanded page navigation uses the last rendered body height", () => {
	const content = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n");
	const tree = [
		makeMessageNode("long-assistant", null, {
			role: "assistant",
			content: [{ type: "text", text: content }],
			stopReason: "stop",
		}),
	];
	const { mode } = renderWrappedTree({
		tree,
		leafId: "long-assistant",
		initialSelectedId: "long-assistant",
		filterMode: "all",
		rows: 30,
	});

	mode.child.handleInput("\x12");
	mode.child.render(60);
	const renderedBodyHeight = mode.child.expandedDetail.bodyHeight;
	assert.ok(renderedBodyHeight > 1);

	mode.ui.terminal.rows = 1;
	mode.child.handleInput("\x1b[C");
	assert.equal(mode.child.expandedDetail.scrollOffset, renderedBodyHeight);

	mode.ui.terminal.rows = 30;
	const pagedLines = mode.child.render(60);
	assert.ok(pagedLines.some((line) => line.includes(`${renderedBodyHeight + 1}-`)));
});

test("expanded detail keeps key hints visible in fullscreen layout", () => {
	const { mode } = renderWrappedTree();
	mode.ui.terminal.rows = 30;

	const transcript = createFixedComponent(["transcript"]);
	mode.widgetContainerBelow = createFixedComponent(["bottom widget"]);
	mode.footerContainer = createFixedComponent(["footer one", "footer two"]);
	const dock = createVStack([
		{ component: mode.editorContainer, shrink: 1, minSize: 3 },
		{ component: mode.widgetContainerBelow, shrink: 1, minSize: 0 },
		{ component: mode.footerContainer, shrink: 1, minSize: 1 },
	]);
	mode.fullscreenLayoutRoot = createVStack([
		{ component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
		{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
	]);

	mode.child.handleInput("\x12");
	const expandedLines = mode.child.render(80);

	assert.deepEqual(mode.widgetContainerBelow.render(80), []);
	assert.deepEqual(mode.footerContainer.render(80), []);
	assert.ok(expandedLines.length <= 29);
	assert.ok(expandedLines.some((line) => line.includes("Esc/Ctrl+R collapse")));
	assert.ok(expandedLines.some((line) => line.includes("↑↓ scroll")));

	mode.child.handleInput("\x1b");
	assert.deepEqual(mode.widgetContainerBelow.render(80), ["bottom widget"]);
	assert.deepEqual(mode.footerContainer.render(80), ["footer one", "footer two"]);

	mode.child.handleInput("\x12");
	assert.equal(typeof mode.activeSelectorDispose, "function");
	mode.activeSelectorDispose();
	assert.deepEqual(mode.widgetContainerBelow.render(80), ["bottom widget"]);
	assert.deepEqual(mode.footerContainer.render(80), ["footer one", "footer two"]);
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
