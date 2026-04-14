// Pure helper extracted from runtime.ts so the init-plugin-snapshot path can be
// unit tested without spinning up the full agent main loop. Given an SDK init
// system message, extract a clean list of plugin keys and publish them to the
// dashboard SSE bus. Any failure is logged and swallowed: a telemetry bug must
// never propagate into the agent main loop.

import { publish as publishDashboardEvent } from "../ui/events.ts";

export type InitMessageLike =
	| {
			plugins?: Array<{ name?: unknown } | null | undefined>;
	  }
	| null
	| undefined;

export function extractPluginKeys(message: InitMessageLike): string[] {
	if (!message || typeof message !== "object") return [];
	const plugins = (message as { plugins?: unknown }).plugins;
	if (!Array.isArray(plugins)) return [];
	const keys: string[] = [];
	for (const entry of plugins) {
		if (!entry || typeof entry !== "object") continue;
		const name = (entry as { name?: unknown }).name;
		if (typeof name === "string" && name.length > 0) {
			keys.push(name);
		}
	}
	return keys;
}

export function emitPluginInitSnapshot(message: InitMessageLike): void {
	try {
		const keys = extractPluginKeys(message);
		publishDashboardEvent("plugin_init_snapshot", { keys });
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn(`[runtime] failed to emit plugin_init_snapshot: ${msg}`);
	}
}
