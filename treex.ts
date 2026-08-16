import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createTmuxTreeLauncher, installTreeEditorBootstrap } from "./src/tmux-tree-launch.js";
import { installTreeXNativePatches } from "./src/treex-component.js";

function getHostDistDir() {
return dirname(realpathSync(process.argv[1]));
}

function getHostModuleUrl(relativePath) {
return pathToFileURL(resolve(getHostDistDir(), relativePath)).href;
}

export default async function treeXExtension(pi) {
installTreeEditorBootstrap(pi);
const host = await import(getHostModuleUrl("index.js"));

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
