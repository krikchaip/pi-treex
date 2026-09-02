import {
	buildSessionContext,
	calculateContextTokens,
	estimateTokens,
	getLastAssistantUsage,
	getLatestCompactionEntry,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import { renderTreeHelp } from "./tmux-tree-launch.js";

const DETAIL_BODY_LINES = 8;
const MIN_TREE_LINES_WITH_DETAIL = 5;
const NARROW_TERMINAL_MAX_WIDTH = 50;
const COMPACT_DETAIL_LINES = DETAIL_BODY_LINES + 3;
const EXPANDED_DETAIL_CHROME_LINES = 4;
const EXPANDED_DETAIL_MIN_LINES = EXPANDED_DETAIL_CHROME_LINES + DETAIL_BODY_LINES;
const EXPANDED_DETAIL_PREFERRED_TREE_ROWS = 12;
const EXPANDED_DETAIL_COLLAPSE_HINT = "Esc/Ctrl+R collapse";
const CURRENT_ROW_MARKER = "◆";
const METADATA_SEPARATOR = " · ";
const METADATA_GROUP_SEPARATOR = "  │  ";
const REVIEW_DETAIL_KEY = Key.ctrl("r");
const TRUNCATED_DETAIL_HINT = "… Ctrl+R full";
const FILTER_LABELS = {
	"no-tools": "[no-tools]",
	"user-only": "[user]",
	"labeled-only": "[labeled]",
	all: "[all]",
};
const LAYOUT_NODE = Symbol.for("@earendil-works/pi-tui/layout-node");
const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
const TREE_HELP_HINTS_KEY = Symbol.for("pi:tree-help-hints");
const TREE_HELP_HINTS_CONSUMED_KEY = Symbol.for("pi:tree-help-hints-consumed");
const SHOW_SELECTOR_PATCH = Symbol.for("pi-treex:show-selector-patch");
const ESCAPE_CODE = 27;
const BELL_CODE = 7;

function getTheme() {
	return globalThis[THEME_KEY];
}

function normalizeLayoutSize(value, fallback) {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

function layoutNode(component) {
	const getNode = component?.[LAYOUT_NODE];
	return typeof getNode === "function" ? getNode.call(component) : undefined;
}

function containsLayoutComponent(component, target) {
	if (component === target) return true;

	const node = layoutNode(component);
	return Boolean(node?.entries?.some((entry) => containsLayoutComponent(entry.component, target)));
}

function findLayoutEntry(component, target) {
	const node = layoutNode(component);
	if (!Array.isArray(node?.entries)) return undefined;

	for (const entry of node.entries) {
		if (entry.component === target) return entry;
		const nested = findLayoutEntry(entry.component, target);
		if (nested) return nested;
	}

	return undefined;
}

function renderedHeight(component, width) {
	try {
		const lines = component?.render?.(width);
		return Array.isArray(lines) ? lines.length : 0;
	} catch {
		return 0;
	}
}

function stackEntryHeight(entry, width) {
	const intrinsic = typeof entry.basis === "number" ? entry.basis : renderedHeight(entry.component, width);
	const minimum = normalizeLayoutSize(entry.minSize, 0);
	const maximum = Math.max(minimum, normalizeLayoutSize(entry.maxSize, Number.MAX_SAFE_INTEGER));
	return Math.max(minimum, Math.min(maximum, Math.floor(intrinsic)));
}

function allocatedLayoutHeight(component, target, width, height) {
	if (component === target) return Math.max(0, Math.floor(height));

	const node = layoutNode(component);
	if (node?.type !== "vstack" || !Array.isArray(node.entries)) return undefined;

	const viewport = { width, height };
	const entries = node.entries.filter((entry) => {
		try {
			return entry.visible?.(viewport) ?? true;
		} catch {
			return true;
		}
	});
	const targetEntry = entries.find((entry) => containsLayoutComponent(entry.component, target));
	if (!targetEntry) return undefined;

	const gap = normalizeLayoutSize(node.gap, 0);
	const reservedHeight =
		Math.max(0, entries.length - 1) * gap +
		entries
			.filter((entry) => entry !== targetEntry)
			.reduce((total, entry) => total + stackEntryHeight(entry, width), 0);
	const minimum = normalizeLayoutSize(targetEntry.minSize, 0);
	const maximum = Math.max(minimum, normalizeLayoutSize(targetEntry.maxSize, Number.MAX_SAFE_INTEGER));
	const targetHeight = Math.max(minimum, Math.min(maximum, Math.max(0, height - reservedHeight)));

	return allocatedLayoutHeight(targetEntry.component, target, width, targetHeight);
}

function availablePickerRows(mode, width) {
	const terminalRows = mode.ui?.terminal?.rows;
	if (!Number.isFinite(terminalRows)) return undefined;

	const fromLayout = allocatedLayoutHeight(mode.fullscreenLayoutRoot, mode.editorContainer, width, terminalRows);
	if (fromLayout !== undefined) return fromLayout;

	const uiChildren = mode.ui?.children;
	const editorIndex = uiChildren?.indexOf?.(mode.editorContainer);
	if (!Array.isArray(uiChildren) || editorIndex < 0) return terminalRows;

	const rowsBelow = uiChildren
		.slice(editorIndex + 1)
		.reduce((total, component) => total + renderedHeight(component, width), 0);
	return Math.max(0, terminalRows - rowsBelow);
}

function normalizeDetail(text) {
	return String(text ?? "")
		.replace(/\r/g, "")
		.replace(/\t/g, "    ")
		.trim();
}

function isAnsiFinalByte(char) {
	const code = char.charCodeAt(0);
	return code >= 0x40 && code <= 0x7e;
}

function getAnsiSequenceLength(text, startIndex) {
	if (text.charCodeAt(startIndex) !== ESCAPE_CODE) return 0;

	const marker = text[startIndex + 1];
	if (marker === "[") {
		let index = startIndex + 2;
		while (index < text.length && !isAnsiFinalByte(text[index])) {
			index++;
		}
		return index < text.length ? index - startIndex + 1 : 0;
	}

	if (marker !== "]" && marker !== "_") return 0;

	let index = startIndex + 2;
	while (index < text.length) {
		if (text.charCodeAt(index) === BELL_CODE) return index - startIndex + 1;
		if (text.charCodeAt(index) === ESCAPE_CODE && text[index + 1] === "\\") return index - startIndex + 2;
		index++;
	}
	return 0;
}

function stripAnsi(text) {
	let result = "";
	for (let index = 0; index < text.length; ) {
		const ansiLength = getAnsiSequenceLength(text, index);
		if (ansiLength) {
			index += ansiLength;
		} else {
			result += text[index];
			index++;
		}
	}
	return result;
}

function hasVisibleText(line) {
	return visibleWidth(stripAnsi(line).trim()) > 0;
}

function stringifyJson(value, spacing = 0) {
	return JSON.stringify(value, null, spacing) ?? "";
}

function formatCustomEntryData(data) {
	return typeof data === "string" ? normalizeDetail(data) : stringifyJson(data, 2);
}

function formatAgo(value, singular, plural = `${singular}S`) {
	return `${value} ${value === 1 ? singular : plural} AGO`;
}

function formatRelativeTime(timestamp) {
	const then = new Date(timestamp).getTime();
	if (!Number.isFinite(then)) return "UNKNOWN TIME";

	const diffMinutes = Math.floor(Math.max(0, Date.now() - then) / 60000);
	if (diffMinutes < 1) return "JUST NOW";
	if (diffMinutes < 60) return formatAgo(diffMinutes, "MIN");

	const diffHours = Math.floor(diffMinutes / 60);
	if (diffHours < 24) return formatAgo(diffHours, "HR");

	const diffDays = Math.floor(diffHours / 24);
	if (diffDays < 30) return formatAgo(diffDays, "DAY");

	const diffMonths = Math.floor(diffDays / 30);
	if (diffMonths < 12) return formatAgo(diffMonths, "MO");

	return formatAgo(Math.floor(diffMonths / 12), "YR");
}

function fitLine(line, width) {
	return truncateToWidth(line, width, "...", true);
}

function getDisplayIndent(treeList, flatNode) {
	return treeList.multipleRoots ? Math.max(0, flatNode.indent - 1) : flatNode.indent;
}

function getDisplayDepth(treeList, flatNode) {
	return getDisplayIndent(treeList, flatNode) + 1;
}

function getVisibleWindow(treeList) {
	if (treeList.filteredNodes.length === 0) {
		return { startIndex: 0, endIndex: 0 };
	}

	const startIndex = Math.max(
		0,
		Math.min(
			treeList.selectedIndex - Math.floor(treeList.maxVisibleLines / 2),
			treeList.filteredNodes.length - treeList.maxVisibleLines,
		),
	);

	return {
		startIndex,
		endIndex: Math.min(startIndex + treeList.maxVisibleLines, treeList.filteredNodes.length),
	};
}

function getStickyLeftState(treeList, width) {
	const { startIndex, endIndex } = getVisibleWindow(treeList);
	if (startIndex === endIndex) {
		return {
			startIndex,
			endIndex,
			stickyLeftShift: 0,
			stickyLeftDepth: null,
		};
	}

	let minVisibleDisplayIndent = Number.POSITIVE_INFINITY;
	for (let index = startIndex; index < endIndex; index++) {
		const flatNode = treeList.filteredNodes[index];
		minVisibleDisplayIndent = Math.min(minVisibleDisplayIndent, getDisplayIndent(treeList, flatNode));
	}

	// On phone-sized terminals, the cursor and path marker provide enough left-side
	// structure without retaining a full three-cell indentation level.
	const retainedIndent = width <= NARROW_TERMINAL_MAX_WIDTH ? 0 : 1;
	const stickyLeftShift = Math.max(0, minVisibleDisplayIndent - retainedIndent);

	return {
		startIndex,
		endIndex,
		stickyLeftShift,
		stickyLeftDepth: stickyLeftShift > 0 ? minVisibleDisplayIndent + 1 : null,
	};
}

function shiftGutters(gutters, stickyLeftShift) {
	if (stickyLeftShift === 0) return gutters;
	return gutters
		.map((gutter) => ({ ...gutter, position: gutter.position - stickyLeftShift }))
		.filter((gutter) => gutter.position >= 0);
}

function getLeadingAnsiLength(line) {
	let length = 0;
	while (length < line.length) {
		const ansiLength = getAnsiSequenceLength(line, length);
		if (!ansiLength) break;
		length += ansiLength;
	}
	return length;
}

function replaceCursorSlot(line, replacement) {
	const prefixLength = getLeadingAnsiLength(line);
	// Native tree rows start with a 2-cell cursor slot ("› " or "  "), possibly after ANSI styling.
	return `${line.slice(0, prefixLength)}${replacement}${line.slice(prefixLength + 2)}`;
}

function markCurrentLine(treeList, lines) {
	if (!treeList.currentLeafId) return lines;

	const { startIndex, endIndex } = getVisibleWindow(treeList);
	let currentIndex = treeList.filteredNodes.findIndex((node) => node.node.entry.id === treeList.currentLeafId);
	if (currentIndex === -1) {
		if (treeList.foldedNodes.size === 0) return lines;
		currentIndex = treeList.findNearestVisibleIndex(treeList.currentLeafId);
	}
	if (currentIndex < startIndex || currentIndex >= endIndex) return lines;

	const theme = getTheme();
	const marker = `${theme.bold(theme.fg("accent", CURRENT_ROW_MARKER))} `;
	lines[currentIndex - startIndex] = replaceCursorSlot(lines[currentIndex - startIndex], marker);
	return lines;
}

function renderWithStickyLeft(treeList, width, originalRender) {
	const { startIndex, endIndex, stickyLeftShift } = getStickyLeftState(treeList, width);
	if (stickyLeftShift === 0) {
		return originalRender(width);
	}

	const originalNodes = [];
	for (let index = startIndex; index < endIndex; index++) {
		const flatNode = treeList.filteredNodes[index];
		const shiftedIndent = Math.max(0, getDisplayIndent(treeList, flatNode) - stickyLeftShift);

		originalNodes.push({
			flatNode,
			indent: flatNode.indent,
			gutters: flatNode.gutters,
		});

		flatNode.indent = treeList.multipleRoots ? shiftedIndent + 1 : shiftedIndent;
		flatNode.gutters = shiftGutters(flatNode.gutters, stickyLeftShift);
	}

	try {
		return originalRender(width);
	} finally {
		for (const originalNode of originalNodes) {
			originalNode.flatNode.indent = originalNode.indent;
			originalNode.flatNode.gutters = originalNode.gutters;
		}
	}
}

function patchTreeListRender(treeList) {
	if (treeList.__treexStickyLeftPatched) return;

	const originalRender = treeList.render.bind(treeList);
	treeList.__treexStickyLeftPatched = true;

	treeList.render = function renderStickyLeft(width) {
		const lines = renderWithStickyLeft(this, width, originalRender);
		lines.pop();
		return markCurrentLine(this, lines);
	};
}

function formatToolCallVerbose(name, args) {
	const json = stringifyJson(args, 2);
	return json ? `${name}\n${json}` : name;
}

function extractDetailContent(treeList, content, options = {}) {
	const { includeToolCalls = false, verboseToolCalls = false } = options;

	if (typeof content === "string") {
		return normalizeDetail(content);
	}

	if (!Array.isArray(content)) return "";

	const parts = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;

		if (block.type === "text") {
			parts.push(normalizeDetail(block.text));
			continue;
		}

		if (block.type === "toolCall" && includeToolCalls) {
			parts.push(
				verboseToolCalls
					? formatToolCallVerbose(block.name, block.arguments)
					: treeList.formatToolCall(block.name, block.arguments),
			);
			continue;
		}

		if (block.type === "image") {
			parts.push("[image]");
		}
	}

	return parts.filter(Boolean).join("\n\n");
}

function describeEntry(treeList, node) {
	const entry = node.entry;

	switch (entry.type) {
		case "message": {
			const message = entry.message;

			if (message.role === "user") {
				return {
					kind: "USER",
					full: extractDetailContent(treeList, message.content, { includeToolCalls: true }) || "(empty)",
				};
			}

			if (message.role === "assistant") {
				return {
					kind: "ASSISTANT",
					full:
						extractDetailContent(treeList, message.content, { includeToolCalls: true, verboseToolCalls: true }) ||
						message.errorMessage ||
						(message.stopReason === "aborted" ? "(aborted)" : "(no content)"),
				};
			}

			if (message.role === "toolResult") {
				return {
					kind: "TOOL RESULT",
					toolName: message.toolName,
				};
			}

			if (message.role === "bashExecution") {
				return {
					kind: "BASH",
					full: normalizeDetail(message.command ?? "") || "(empty)",
					toolName: "bash",
				};
			}

			return {
				kind: String(message.role ?? "MESSAGE").toUpperCase(),
				full: `[${message.role ?? "message"}]`,
			};
		}

		case "custom_message":
			return {
				kind: entry.customType ? `${entry.customType}`.toUpperCase() : "CUSTOM MESSAGE",
				full: extractDetailContent(treeList, entry.content, { includeToolCalls: true }) || "(empty)",
			};

		case "compaction": {
			const tokenCount = Math.round((entry.tokensBefore ?? 0) / 1000);
			const fallback = `[compaction: ${tokenCount}k tokens]`;
			return {
				kind: "COMPACTION",
				full: normalizeDetail(entry.summary ?? fallback) || fallback,
			};
		}

		case "branch_summary":
			return {
				kind: "BRANCH SUMMARY",
				full: normalizeDetail(entry.summary ?? "") || "(empty)",
			};

		case "model_change":
			return {
				kind: "MODEL",
				full: `[model: ${entry.modelId}]`,
			};

		case "thinking_level_change":
			return {
				kind: "THINKING",
				full: `[thinking: ${entry.thinkingLevel}]`,
			};

		case "custom":
			return {
				kind: entry.customType ? `${entry.customType}`.toUpperCase() : "CUSTOM",
				full: entry.data === undefined ? `[custom: ${entry.customType}]` : formatCustomEntryData(entry.data),
			};

		case "label":
			return {
				kind: "LABEL",
				full: entry.label ?? "(cleared)",
			};

		case "session_info":
			return {
				kind: "SESSION TITLE",
				full: entry.name ?? "(empty)",
			};

		default:
			return {
				kind: "ENTRY",
				full: "[entry]",
			};
	}
}

function calculateTreeDetailLayout(availableRows, detailExpanded, selectorChromeLines) {
	const availableContentRows = Math.max(1, availableRows - selectorChromeLines);
	if (detailExpanded) {
		const treeRows = Math.min(
			EXPANDED_DETAIL_PREFERRED_TREE_ROWS,
			Math.max(1, availableContentRows - EXPANDED_DETAIL_MIN_LINES),
		);
		const detailBodyRows = Math.max(1, availableContentRows - treeRows - EXPANDED_DETAIL_CHROME_LINES);

		return { treeRows, detailBodyRows, detailVisible: true };
	}

	if (availableContentRows < MIN_TREE_LINES_WITH_DETAIL + COMPACT_DETAIL_LINES) {
		return {
			treeRows: availableContentRows,
			detailBodyRows: 0,
			detailVisible: false,
		};
	}

	const preferredTreeRows = Math.max(MIN_TREE_LINES_WITH_DETAIL, Math.floor(availableRows / 2) - COMPACT_DETAIL_LINES);
	const availableTreeRows = Math.max(1, availableContentRows - COMPACT_DETAIL_LINES);
	return {
		treeRows: Math.min(preferredTreeRows, availableTreeRows),
		detailBodyRows: DETAIL_BODY_LINES,
		detailVisible: true,
	};
}

function getRenderedTreeLineCount(treeList) {
	const { startIndex, endIndex } = getVisibleWindow(treeList);
	// The native tree renders a single "No entries found" row when the window is empty.
	if (startIndex === endIndex) return 1;
	return endIndex - startIndex;
}

// Detail pane context helpers
function findModel(session, modelIdentity) {
	return (
		session.modelRuntime?.getModel?.(modelIdentity.provider, modelIdentity.modelId) ??
		session.modelRegistry?.find?.(modelIdentity.provider, modelIdentity.modelId)
	);
}

function getDetailContextUsage(session, entry) {
	const branchEntries = session.sessionManager.getBranch(entry.id);
	const sessionContext = buildSessionContext(session.sessionManager.getEntries(), entry.id);
	const modelIdentity = sessionContext.model ?? findLastAssistantModel(branchEntries);
	if (!modelIdentity) return null;

	const contextWindow = findModel(session, modelIdentity)?.contextWindow;
	if (!contextWindow) return null;

	const latestCompaction = getLatestCompactionEntry(branchEntries);
	if (latestCompaction) {
		const compactionIndex = branchEntries.lastIndexOf(latestCompaction);
		const usage = getLastAssistantUsage(branchEntries.slice(compactionIndex + 1));
		if (!usage || calculateContextTokens(usage) === 0) {
			return { percent: null, contextWindow };
		}
	}

	return {
		percent: (estimateContextTokensFromMessages(sessionContext.messages) / contextWindow) * 100,
		contextWindow,
	};
}

function findLastAssistantModel(branchEntries) {
	for (let index = branchEntries.length - 1; index >= 0; index--) {
		const entry = branchEntries[index];
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		if (!entry.message.provider || !entry.message.model) continue;
		return {
			provider: entry.message.provider,
			modelId: entry.message.model,
		};
	}

	return null;
}

function estimateContextTokensFromMessages(messages) {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		if (message.stopReason === "aborted" || message.stopReason === "error" || !message.usage) continue;

		let trailingTokens = 0;
		for (let trailingIndex = index + 1; trailingIndex < messages.length; trailingIndex++) {
			trailingTokens += estimateTokens(messages[trailingIndex]);
		}

		return calculateContextTokens(message.usage) + trailingTokens;
	}

	let estimatedTokens = 0;
	for (const message of messages) {
		estimatedTokens += estimateTokens(message);
	}
	return estimatedTokens;
}

function formatShortTokenCount(count) {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function formatDetailContextUsage(theme, contextUsage) {
	if (!contextUsage) return null;

	const display =
		contextUsage.percent === null
			? `?/${formatShortTokenCount(contextUsage.contextWindow)}`
			: `${contextUsage.percent.toFixed(1)}%/${formatShortTokenCount(contextUsage.contextWindow)}`;

	if (contextUsage.percent === null) {
		return theme.fg("muted", display);
	}
	if (contextUsage.percent > 90) {
		return theme.fg("error", display);
	}
	if (contextUsage.percent > 70) {
		return theme.fg("warning", display);
	}
	return theme.fg("muted", display);
}

function getCurrentDirection(treeList, selected) {
	if (!treeList.currentLeafId || selected.node.entry.id === treeList.currentLeafId) return null;

	const currentFlatIndex = treeList.flatNodes.findIndex((node) => node.node.entry.id === treeList.currentLeafId);
	const selectedFlatIndex = treeList.flatNodes.findIndex((node) => node.node.entry.id === selected.node.entry.id);
	return currentFlatIndex < selectedFlatIndex ? "up" : "down";
}

function getCurrentPositionPart(treeList, selected, theme) {
	if (selected.node.entry.id === treeList.currentLeafId) {
		return theme.fg("accent", "CURRENT");
	}

	const currentDirection = getCurrentDirection(treeList, selected);
	if (!currentDirection) return null;

	return theme.bold(theme.fg("accent", currentDirection === "up" ? "↑ CURRENT" : "↓ CURRENT"));
}

function getTreeFilterParts(treeList, theme) {
	const filterLabel = FILTER_LABELS[treeList.filterMode];
	const labels = filterLabel ? [filterLabel] : [];

	if (treeList.showLabelTimestamps) {
		labels.push("[+label time]");
	}

	return labels.map((label) => theme.fg("muted", label));
}

function joinMetadataParts(theme, parts) {
	return parts.filter(Boolean).join(theme.fg("muted", METADATA_SEPARATOR));
}

function getTreeSelector(result) {
	if (typeof result?.focus?.getTreeList === "function") return result.focus;
	if (typeof result?.component?.getTreeList === "function") return result.component;
	return null;
}

function isToolResultEntry(entry) {
	return entry.type === "message" && entry.message.role === "toolResult";
}

function withoutThinkingBlocks(message) {
	if (!Array.isArray(message?.content)) return message;
	return {
		...message,
		content: message.content.filter((block) => block?.type !== "thinking"),
	};
}

function compactDetailLines(lines) {
	let start = 0;
	while (start < lines.length && !hasVisibleText(lines[start])) start++;
	let end = lines.length;
	while (end > start && !hasVisibleText(lines[end - 1])) end--;
	return lines.slice(start, end);
}

function removeSharedPrefix(baseLines, lines) {
	let index = 0;
	while (
		index < baseLines.length &&
		index < lines.length &&
		stripAnsi(lines[index]).trimEnd() === stripAnsi(baseLines[index]).trimEnd()
	) {
		index++;
	}
	return lines.slice(index);
}

function appendRightHint(line, width, theme, hintText, hintColumnText = hintText) {
	const hint = theme.fg("dim", hintText);
	const hintWidth = visibleWidth(hint);
	if (width <= hintWidth) return fitLine(hint, width);

	const hintColumnWidth = Math.max(hintWidth, visibleWidth(hintColumnText));
	const left = truncateToWidth(line, Math.max(0, width - hintColumnWidth - 1), "");
	const padding = Math.max(0, width - visibleWidth(left) - hintWidth);
	return `${left}${" ".repeat(padding)}${hint}`;
}

function getDetailBodyLines(lines) {
	const bodyLines = lines.slice(0, DETAIL_BODY_LINES);
	while (bodyLines.length < DETAIL_BODY_LINES) bodyLines.push("");
	return bodyLines;
}

function renderCompactComponentLines(component, width) {
	return compactDetailLines(component.render(width));
}

function renderPlainTextLines(text, width) {
	return wrapTextWithAnsi(normalizeDetail(text) || "(no text)", width);
}

function renderCompactPlainTextLines(text, width) {
	return compactDetailLines(renderPlainTextLines(text, width));
}

function compactNativeTreeSpacing(lines) {
	const result = [...lines];
	if (result[0] === "") result.shift();
	if (result.length >= 2 && result[result.length - 2] === "") {
		result.splice(result.length - 2, 1);
	}
	return result;
}

class ExpandedDetailPane {
	constructor() {
		this.expanded = false;
		this.scrollOffset = 0;
		this.bodyHeight = DETAIL_BODY_LINES;
	}

	toggle() {
		if (this.expanded) {
			this.collapse();
		} else {
			this.expanded = true;
			this.scrollOffset = 0;
		}
	}

	collapse() {
		this.expanded = false;
		this.scrollOffset = 0;
	}

	handleInput(keyData) {
		if (matchesKey(keyData, Key.escape) || matchesKey(keyData, Key.ctrl("c"))) {
			this.collapse();
			return;
		}
		if (matchesKey(keyData, Key.up)) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
			return;
		}
		if (matchesKey(keyData, Key.down)) {
			this.scrollOffset++;
			return;
		}
		if (matchesKey(keyData, Key.pageUp) || matchesKey(keyData, Key.left)) {
			this.scrollOffset = Math.max(0, this.scrollOffset - this.bodyHeight);
			return;
		}
		if (matchesKey(keyData, Key.pageDown) || matchesKey(keyData, Key.right)) {
			this.scrollOffset += this.bodyHeight;
			return;
		}
		if (matchesKey(keyData, Key.home)) {
			this.scrollOffset = 0;
			return;
		}
		if (matchesKey(keyData, Key.end)) {
			this.scrollOffset = Number.POSITIVE_INFINITY;
		}
	}

	renderEmpty(theme, width) {
		const footerParts = ["0-0/0", "↑↓ scroll", "←/→ page", "Home/End", EXPANDED_DETAIL_COLLAPSE_HINT];
		return [
			fitLine(theme.fg("muted", "NO SELECTION"), width),
			fitLine(theme.fg("accent", "─".repeat(width)), width),
			...Array.from({ length: this.bodyHeight }, () => fitLine("", width)),
			fitLine(theme.fg("accent", "─".repeat(width)), width),
			fitLine(theme.fg("dim", footerParts.join(METADATA_SEPARATOR)), width),
		];
	}

	render(theme, width, contentLines, metadata) {
		const lines = contentLines.length ? contentLines : [theme.fg("muted", "(no text)")];
		const maxOffset = Math.max(0, lines.length - this.bodyHeight);
		this.scrollOffset = Math.min(Math.max(0, this.scrollOffset), maxOffset);

		const visibleLines = lines.slice(this.scrollOffset, this.scrollOffset + this.bodyHeight);
		while (visibleLines.length < this.bodyHeight) {
			visibleLines.push("");
		}

		const firstVisibleLine = Math.min(lines.length, this.scrollOffset + 1);
		const lastVisibleLine = Math.min(lines.length, this.scrollOffset + this.bodyHeight);
		const footerParts = [
			`${firstVisibleLine}-${lastVisibleLine}/${lines.length}`,
			"↑↓ scroll",
			"←/→ page",
			"Home/End",
			EXPANDED_DETAIL_COLLAPSE_HINT,
		];

		return [
			appendRightHint(metadata, width, theme, "", EXPANDED_DETAIL_COLLAPSE_HINT),
			fitLine(theme.fg("accent", "─".repeat(width)), width),
			...visibleLines.map((line) => fitLine(line, width)),
			fitLine(theme.fg("accent", "─".repeat(width)), width),
			fitLine(theme.fg("dim", footerParts.join(METADATA_SEPARATOR)), width),
		];
	}
}

class DetailContentRenderer {
	constructor(mode, treeList, components) {
		this.mode = mode;
		this.treeList = treeList;
		this.tui = mode.ui;
		this.components = components;
	}

	createToolExecutionComponent(entry) {
		const message = entry.message;
		const toolCall = this.treeList.toolCallMap.get(message.toolCallId);
		return new this.components.toolExecutionComponent(
			message.toolName,
			message.toolCallId,
			toolCall?.arguments ?? {},
			{ showImages: false },
			this.mode.getRegisteredToolDefinition(message.toolName),
			this.tui,
			this.mode.sessionManager.getCwd(),
		);
	}

	createUserMessageComponent(entry) {
		const text = this.mode.getUserMessageText(entry.message);
		return new this.components.userMessageComponent(
			text,
			this.mode.getMarkdownThemeWithSettings(),
			this.mode.outputPad,
		);
	}

	createAssistantMessageComponent(entry) {
		return new this.components.assistantMessageComponent(
			withoutThinkingBlocks(entry.message),
			this.mode.hideThinkingBlock,
			this.mode.getMarkdownThemeWithSettings(),
			this.mode.hiddenThinkingLabel,
			this.mode.outputPad,
		);
	}

	renderBashExecutionLines(entry, width) {
		const message = entry.message;
		const component = new this.components.bashExecutionComponent(message.command, this.tui, message.excludeFromContext);
		if (message.output) {
			component.appendOutput(message.output);
		}
		component.setExpanded(true);
		component.setComplete(
			message.exitCode,
			message.cancelled,
			message.truncated ? { truncated: true } : undefined,
			message.fullOutputPath,
		);
		return component.render(width);
	}

	renderExpandableEntryLines(Component, message, width) {
		const component = new Component(message, this.mode.getMarkdownThemeWithSettings());
		component.setExpanded(true);
		return component.render(width);
	}

	renderCustomMessageLines(entry, width) {
		const renderer = this.mode.session.extensionRunner?.getMessageRenderer?.(entry.customType);
		const component = new this.components.customMessageComponent(
			entry,
			renderer,
			this.mode.getMarkdownThemeWithSettings(),
		);
		component.setExpanded(true);
		return component.render(width);
	}

	renderToolLines(entry, width, result) {
		const component = this.createToolExecutionComponent(entry);
		component.setExpanded(true);
		if (result) {
			component.updateResult(result);
		}
		return component.render(width);
	}

	renderToolResultPreviewLines(entry, width) {
		const callLines = compactDetailLines(this.renderToolLines(entry, width));
		const fullLines = compactDetailLines(this.renderToolLines(entry, width, entry.message));
		const resultLines = removeSharedPrefix(callLines, fullLines);
		return resultLines.length > 0 ? resultLines : fullLines;
	}

	render(entry, info, width) {
		if (isToolResultEntry(entry)) {
			return this.renderToolResultPreviewLines(entry, width);
		}

		if (entry.type === "message") {
			switch (entry.message.role) {
				case "user":
					return renderCompactComponentLines(this.createUserMessageComponent(entry), width);
				case "assistant":
					return renderCompactComponentLines(this.createAssistantMessageComponent(entry), width);
				case "bashExecution":
					return compactDetailLines(this.renderBashExecutionLines(entry, width));
			}
		}

		if (entry.type === "compaction") {
			return compactDetailLines(
				this.renderExpandableEntryLines(this.components.compactionSummaryMessageComponent, entry, width),
			);
		}

		if (entry.type === "branch_summary") {
			return compactDetailLines(
				this.renderExpandableEntryLines(this.components.branchSummaryMessageComponent, entry, width),
			);
		}

		if (entry.type === "custom_message") {
			return compactDetailLines(this.renderCustomMessageLines(entry, width));
		}

		return renderCompactPlainTextLines(info.full, width);
	}
}

class TreeXWrapper {
	constructor(selector, mode, nativeComponents, closeSelector, disposeSelector) {
		this.selector = selector;
		this.disposeSelector = typeof disposeSelector === "function" ? () => disposeSelector() : () => selector.dispose?.();
		this[TREE_HELP_HINTS_CONSUMED_KEY] = true;
		this.selector[TREE_HELP_HINTS_CONSUMED_KEY] = true;
		this.treeList = selector.getTreeList();
		this.mode = mode;
		this.tui = mode.ui;
		this.closeSelector = closeSelector;
		this.treeLauncher = nativeComponents.treeLauncher;
		this.treeLaunchError = undefined;
		this.detailContent = new DetailContentRenderer(mode, this.treeList, nativeComponents);
		this.expandedDetail = new ExpandedDetailPane();
		this.detailVisible = true;
		this.hiddenBottomEntries = [];
		this.hiddenBottomComponents = [];
		patchTreeListRender(this.treeList);

		// Patch native tree border colors to match theme accent
		const theme = getTheme();
		const children = this.selector.children || [];
		for (const [index, child] of children.entries()) {
			if (child?.constructor && child.constructor.name === "DynamicBorder") {
				child.color = (str) => theme.fg("accent", str);
			}
			const isTreeHelp =
				child?.constructor?.name === "TreeHelp" || children[index + 1]?.constructor?.name === "SearchLine";
			if (isTreeHelp) {
				const renderHelp = child.render.bind(child);
				child.render = (width) =>
					renderTreeHelp(renderHelp, width, getTheme(), {
						treeHints: this[TREE_HELP_HINTS_KEY] ?? this.selector[TREE_HELP_HINTS_KEY],
						showTreeLaunchHints: this.treeLauncher?.available,
						errorMessage: this.treeLaunchError,
					});
			}
		}
	}

	getTreeList() {
		return this.treeList;
	}

	renderSelector(width) {
		const lines = compactNativeTreeSpacing(this.selector.render(width));
		const treeLineCount = this.selector.labelInput ? 0 : getRenderedTreeLineCount(this.treeList);
		return { lines, treeLineCount };
	}

	renderSelectorWithLayout(width) {
		// Pi's tree help wraps based on terminal width. Measure its rendered chrome,
		// then give the editor's live fullscreen allocation to the tree and detail pane.
		let rendered = this.renderSelector(width);
		const selectorChromeLines = rendered.lines.length - rendered.treeLineCount;
		const availableRows = availablePickerRows(this.mode, width) ?? this.tui.terminal.rows;
		const { treeRows, detailBodyRows, detailVisible } = calculateTreeDetailLayout(
			availableRows,
			this.expandedDetail.expanded,
			selectorChromeLines,
		);

		this.detailVisible = detailVisible;
		this.expandedDetail.bodyHeight = detailBodyRows;
		if (this.treeList.maxVisibleLines !== treeRows) {
			this.treeList.maxVisibleLines = treeRows;
			rendered = this.renderSelector(width);
		}

		return rendered;
	}

	get focused() {
		return this.selector.focused;
	}

	set focused(value) {
		this.selector.focused = value;
	}

	invalidate() {
		this.selector.invalidate();
	}

	setExpandedLayout(expanded) {
		if (!expanded) {
			this.restoreLayout();
			return;
		}
		if (this.hiddenBottomComponents.length > 0) return;

		const root = this.mode.fullscreenLayoutRoot;
		for (const component of [this.mode.widgetContainerBelow, this.mode.footerContainer]) {
			if (!component) continue;

			this.hiddenBottomComponents.push({
				component,
				hadRender: Object.prototype.hasOwnProperty.call(component, "render"),
				render: component.render,
			});
			component.render = () => [];

			const entry = findLayoutEntry(root, component);
			if (!entry) continue;
			this.hiddenBottomEntries.push({
				entry,
				hadVisible: Object.prototype.hasOwnProperty.call(entry, "visible"),
				visible: entry.visible,
			});
			entry.visible = () => false;
		}
	}

	restoreLayout() {
		for (const snapshot of this.hiddenBottomEntries) {
			if (snapshot.hadVisible) snapshot.entry.visible = snapshot.visible;
			// biome-ignore lint/performance/noDelete: restore inherited or absent layout state exactly.
			else delete snapshot.entry.visible;
		}
		this.hiddenBottomEntries = [];

		for (const snapshot of this.hiddenBottomComponents) {
			if (snapshot.hadRender) snapshot.component.render = snapshot.render;
			// biome-ignore lint/performance/noDelete: restore prototype-based component rendering exactly.
			else delete snapshot.component.render;
		}
		this.hiddenBottomComponents = [];
	}

	handleInput(keyData) {
		if (this.mode.keybindings?.matches?.(keyData, "app.session.tree")) {
			this.closeSelector();
			this.tui.requestRender();
			return;
		}

		const treeLaunchTarget = this.treeLauncher?.available ? this.treeLauncher.targetForInput(keyData) : undefined;
		if (!this.selector.labelInput && treeLaunchTarget) {
			const selected = this.getSelectedNode();
			const result = selected
				? this.treeLauncher.launch(this.mode, selected.node.entry, treeLaunchTarget)
				: { ok: false, error: "Select a tree entry first" };
			if (result.ok) {
				this.tui.requestRender();
				return;
			}
			this.treeLaunchError = result.error;
			this.tui.requestRender();
			return;
		}

		this.treeLaunchError = undefined;
		if (!this.selector.labelInput && matchesKey(keyData, REVIEW_DETAIL_KEY)) {
			this.expandedDetail.toggle();
			this.setExpandedLayout(this.expandedDetail.expanded);
		} else if (this.expandedDetail.expanded) {
			this.expandedDetail.handleInput(keyData);
			this.setExpandedLayout(this.expandedDetail.expanded);
		} else {
			this.selector.handleInput(keyData);
		}

		this.tui.requestRender();
	}

	dispose() {
		this.restoreLayout();
		const disposeSelector = this.disposeSelector;
		this.disposeSelector = undefined;
		disposeSelector?.();
	}

	renderStickyLeftLine(theme, width, stickyLeftDepth) {
		const badge = theme.bg(
			"selectedBg",
			` ${theme.bold(theme.fg("accent", "⇤"))} ${theme.bold(theme.fg("accent", `depth ${stickyLeftDepth}`))} `,
		);

		return fitLine(`  ${badge}`, width);
	}

	getSelectedNode() {
		return this.treeList.filteredNodes[this.treeList.selectedIndex] ?? null;
	}

	getDetailMetadata(theme, selected, info) {
		const entry = selected.node.entry;
		const contextUsage = getDetailContextUsage(this.mode.session, entry);
		const treeParts = [
			theme.fg("muted", `${this.treeList.selectedIndex + 1}/${this.treeList.filteredNodes.length}`),
			...getTreeFilterParts(this.treeList, theme),
			theme.bold(theme.fg("accent", `DEPTH ${getDisplayDepth(this.treeList, selected)}`)),
			getCurrentPositionPart(this.treeList, selected, theme),
		];

		const entryParts = [theme.bold(info.kind), theme.fg("muted", formatRelativeTime(entry.timestamp))];
		if (info.toolName) entryParts.push(theme.fg("muted", String(info.toolName).toUpperCase()));
		if (selected.node.label) entryParts.push(theme.fg("warning", `[${selected.node.label}]`));

		const metadataGroups = [joinMetadataParts(theme, treeParts), joinMetadataParts(theme, entryParts)];
		const contextPart = formatDetailContextUsage(theme, contextUsage);
		if (contextPart) {
			metadataGroups.push(joinMetadataParts(theme, [theme.fg("muted", "CTX"), contextPart]));
		}

		return metadataGroups.join(theme.fg("muted", METADATA_GROUP_SEPARATOR));
	}

	renderDetailPane(theme, width) {
		const selected = this.getSelectedNode();
		if (!selected) {
			return [
				fitLine(theme.fg("muted", "NO SELECTION"), width),
				fitLine(theme.fg("accent", "─".repeat(width)), width),
				...Array.from({ length: DETAIL_BODY_LINES }, () => fitLine("", width)),
				fitLine(theme.fg("accent", "─".repeat(width)), width),
			];
		}

		const entry = selected.node.entry;
		const info = describeEntry(this.treeList, selected.node);
		const contentLines = this.detailContent.render(entry, info, width);
		const bodyLines = getDetailBodyLines(contentLines);
		const metadata = this.getDetailMetadata(theme, selected, info);
		const metadataLine = appendRightHint(metadata, width, theme, TRUNCATED_DETAIL_HINT, EXPANDED_DETAIL_COLLAPSE_HINT);

		return [
			metadataLine,
			fitLine(theme.fg("accent", "─".repeat(width)), width),
			...bodyLines.map((line) => fitLine(line, width)),
			fitLine(theme.fg("accent", "─".repeat(width)), width),
		];
	}

	renderExpandedDetailPane(theme, width) {
		const selected = this.getSelectedNode();
		if (!selected) {
			return this.expandedDetail.renderEmpty(theme, width);
		}

		const entry = selected.node.entry;
		const info = describeEntry(this.treeList, selected.node);

		return this.expandedDetail.render(
			theme,
			width,
			this.detailContent.render(entry, info, width),
			this.getDetailMetadata(theme, selected, info),
		);
	}

	render(width) {
		const theme = getTheme();
		const renderWidth = Math.max(20, width);

		const { lines, treeLineCount } = this.renderSelectorWithLayout(renderWidth);
		const { stickyLeftDepth } = getStickyLeftState(this.treeList, renderWidth);

		if (stickyLeftDepth && treeLineCount > 0) {
			// The native bottom border remains after the tree rows. Replace the
			// spacer immediately before those rows without assuming a chrome height.
			const firstTreeLineIndex = lines.length - treeLineCount - 1;
			lines[firstTreeLineIndex - 1] = this.renderStickyLeftLine(theme, renderWidth, stickyLeftDepth);
		}

		const detailLines = this.expandedDetail.expanded
			? this.renderExpandedDetailPane(theme, renderWidth)
			: this.detailVisible
				? this.renderDetailPane(theme, renderWidth)
				: [];

		return [...lines, ...detailLines];
	}
}

function uninstallTreeXNativePatches(InteractiveMode) {
	const proto = InteractiveMode.prototype;
	const patch = proto[SHOW_SELECTOR_PATCH];
	if (!patch) return;

	if (proto.showSelector === patch.patched) {
		proto.showSelector = patch.original;
	}
	delete proto[SHOW_SELECTOR_PATCH];
}

export function installTreeXNativePatches(InteractiveMode, nativeComponents) {
	const proto = InteractiveMode.prototype;
	uninstallTreeXNativePatches(InteractiveMode);

	const originalShowSelector = proto.showSelector;
	const patchedShowSelector = function treexShowSelector(create) {
		return originalShowSelector.call(this, (done) => {
			const result = create(done);
			const selector = getTreeSelector(result);
			if (!selector) {
				return result;
			}

			const wrapper = new TreeXWrapper(selector, this, nativeComponents, done, result.dispose);
			return { component: wrapper, focus: wrapper, dispose: () => wrapper.dispose() };
		});
	};

	proto.showSelector = patchedShowSelector;
	proto[SHOW_SELECTOR_PATCH] = {
		original: originalShowSelector,
		patched: patchedShowSelector,
	};
	return () => uninstallTreeXNativePatches(InteractiveMode);
}
