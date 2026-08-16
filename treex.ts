import { fileURLToPath } from "node:url";

import * as host from "@earendil-works/pi-coding-agent";

import { createTmuxTreeLauncher, installTreeEditorBootstrap } from "./src/tmux-tree-launch.js";
import { installTreeXNativePatches } from "./src/treex-component.js";

export default function treeXExtension(pi) {
	installTreeEditorBootstrap(pi);

	// Pi's loader supplies the active runtime, including in standalone binaries.
	const unpatch = installTreeXNativePatches(host.InteractiveMode, {
		assistantMessageComponent: host.AssistantMessageComponent,
		bashExecutionComponent: host.BashExecutionComponent,
		branchSummaryMessageComponent: host.BranchSummaryMessageComponent,
		compactionSummaryMessageComponent: host.CompactionSummaryMessageComponent,
		customMessageComponent: host.CustomMessageComponent,
		toolExecutionComponent: host.ToolExecutionComponent,
		userMessageComponent: host.UserMessageComponent,
		treeLauncher: createTmuxTreeLauncher(host.SessionManager, { extensionPath: fileURLToPath(import.meta.url) }),
	});

	pi.on("session_shutdown", unpatch);
}
