import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { installTreeXNativePatches } from "./src/treex-component.js";

function getHostDistDir() {
	return dirname(realpathSync(process.argv[1]));
}

function getHostModuleUrl(relativePath) {
	return pathToFileURL(resolve(getHostDistDir(), relativePath)).href;
}

export default async function treeXExtension(pi) {
	const host = await import(getHostModuleUrl("index.js"));

	const unpatch = installTreeXNativePatches(host.InteractiveMode, {
		assistantMessageComponent: host.AssistantMessageComponent,
		bashExecutionComponent: host.BashExecutionComponent,
		branchSummaryMessageComponent: host.BranchSummaryMessageComponent,
		compactionSummaryMessageComponent: host.CompactionSummaryMessageComponent,
		customMessageComponent: host.CustomMessageComponent,
		toolExecutionComponent: host.ToolExecutionComponent,
		userMessageComponent: host.UserMessageComponent,
	});

	pi.on("session_shutdown", unpatch);
}
