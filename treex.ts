import { fileURLToPath } from "node:url";

import {
	AssistantMessageComponent,
	BashExecutionComponent,
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	CustomMessageComponent,
	InteractiveMode,
	SessionManager,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";

import { createTmuxTreeLauncher, installTreeEditorBootstrap } from "./src/tmux-tree-launch.js";
import { installTreeXNativePatches } from "./src/treex-component.js";

export default function treeXExtension(pi) {
	installTreeEditorBootstrap(pi);

	const unpatch = installTreeXNativePatches(InteractiveMode, {
		assistantMessageComponent: AssistantMessageComponent,
		bashExecutionComponent: BashExecutionComponent,
		branchSummaryMessageComponent: BranchSummaryMessageComponent,
		compactionSummaryMessageComponent: CompactionSummaryMessageComponent,
		customMessageComponent: CustomMessageComponent,
		toolExecutionComponent: ToolExecutionComponent,
		userMessageComponent: UserMessageComponent,
		treeLauncher: createTmuxTreeLauncher(SessionManager, { extensionPath: fileURLToPath(import.meta.url) }),
	});

	pi.on("session_shutdown", unpatch);
}
