// Storage for the hooks slice of settings.json. Every write goes through
// src/plugins/settings-io.ts for atomic tmp+rename so no other field can be
// accidentally clobbered. The hooks editor ONLY touches Settings.hooks; every
// other key (enabledPlugins, permissions, model, etc.) is preserved
// byte-for-byte on a round trip.
//
// Concurrency: last-write-wins per the Cardinal Rule. Agent-originated edits
// via the Write tool bypass this path; if the agent edits hooks between the
// dashboard's read and the dashboard's write, the dashboard overwrites. An
// audit log row captures the previous slice so a human can diff and recover.

import { readSettings, writeSettings } from "../plugins/settings-io.ts";
import { getHooksSettingsPath } from "./paths.ts";
import {
	type HookDefinition,
	type HookEvent,
	type HookMatcherGroup,
	type HooksSlice,
	HooksSliceSchema,
	isHttpUrlAllowed,
} from "./schema.ts";

export type ListHooksResult =
	| { ok: true; slice: HooksSlice; total: number; allowedHttpHookUrls: string[] | undefined }
	| { ok: false; error: string };

export function listHooks(settingsPath: string = getHooksSettingsPath()): ListHooksResult {
	const read = readSettings(settingsPath);
	if (!read.ok) {
		return { ok: false, error: read.error };
	}
	const rawSlice = (read.settings.hooks ?? {}) as unknown;
	const parsed = HooksSliceSchema.safeParse(rawSlice);
	if (!parsed.success) {
		return { ok: false, error: `On-disk hooks slice is invalid: ${parsed.error.issues[0].message}` };
	}
	let total = 0;
	for (const groups of Object.values(parsed.data)) {
		for (const group of groups ?? []) {
			total += group.hooks.length;
		}
	}
	const allowedHttpHookUrls = Array.isArray(read.settings.allowedHttpHookUrls)
		? (read.settings.allowedHttpHookUrls as string[])
		: undefined;
	return { ok: true, slice: parsed.data, total, allowedHttpHookUrls };
}

export type InstallHookInput = {
	event: HookEvent;
	matcher?: string;
	definition: HookDefinition;
};

export type InstallHookResult =
	| {
			ok: true;
			slice: HooksSlice;
			event: HookEvent;
			matcher?: string;
			groupIndex: number;
			hookIndex: number;
			previousSlice: HooksSlice;
	  }
	| { ok: false; status: 400 | 403 | 422 | 500; error: string };

// Install a new hook. Appends to an existing matcher group with the same
// matcher, or creates a new matcher group if none exists for that matcher.
// Writes ONLY the Settings.hooks slice back; all other keys preserved.
export function installHook(input: InstallHookInput, settingsPath: string = getHooksSettingsPath()): InstallHookResult {
	const read = readSettings(settingsPath);
	if (!read.ok) return { ok: false, status: 500, error: read.error };

	const prevRaw = (read.settings.hooks ?? {}) as unknown;
	const prevParsed = HooksSliceSchema.safeParse(prevRaw);
	if (!prevParsed.success) {
		return { ok: false, status: 500, error: `On-disk hooks slice is invalid: ${prevParsed.error.issues[0].message}` };
	}
	const previousSlice = prevParsed.data;

	// allowlist enforcement for http hooks
	if (input.definition.type === "http") {
		const allowlist = Array.isArray(read.settings.allowedHttpHookUrls)
			? (read.settings.allowedHttpHookUrls as string[])
			: undefined;
		if (!isHttpUrlAllowed(input.definition.url, allowlist)) {
			return {
				ok: false,
				status: 403,
				error: `HTTP hook URL ${input.definition.url} is not on the allowedHttpHookUrls allowlist. Add it to settings.json first.`,
			};
		}
	}

	const nextSlice: HooksSlice = JSON.parse(JSON.stringify(previousSlice));
	const groupsForEvent: HookMatcherGroup[] = (nextSlice[input.event] as HookMatcherGroup[] | undefined) ?? [];

	// Find an existing group with the same matcher. Treat undefined matcher
	// as its own category (the "no matcher" group).
	let groupIndex = groupsForEvent.findIndex((g) => (g.matcher ?? null) === (input.matcher ?? null));
	if (groupIndex === -1) {
		groupsForEvent.push({
			matcher: input.matcher,
			hooks: [input.definition],
		});
		groupIndex = groupsForEvent.length - 1;
	} else {
		groupsForEvent[groupIndex].hooks.push(input.definition);
	}
	nextSlice[input.event] = groupsForEvent;

	const validated = HooksSliceSchema.safeParse(nextSlice);
	if (!validated.success) {
		return {
			ok: false,
			status: 422,
			error: `Hook validation failed: ${validated.error.issues[0].path.join(".")}: ${validated.error.issues[0].message}`,
		};
	}

	const merged = { ...read.settings, hooks: validated.data };
	const write = writeSettings(merged, settingsPath);
	if (!write.ok) {
		return { ok: false, status: 500, error: write.error };
	}

	const hookIndex = (validated.data[input.event]?.[groupIndex]?.hooks.length ?? 1) - 1;
	return {
		ok: true,
		slice: validated.data,
		event: input.event,
		matcher: input.matcher,
		groupIndex,
		hookIndex,
		previousSlice,
	};
}

export type UpdateHookInput = {
	event: HookEvent;
	groupIndex: number;
	hookIndex: number;
	definition: HookDefinition;
};

export type UpdateHookResult =
	| { ok: true; slice: HooksSlice; previousSlice: HooksSlice }
	| { ok: false; status: 404 | 403 | 422 | 500; error: string };

export function updateHook(input: UpdateHookInput, settingsPath: string = getHooksSettingsPath()): UpdateHookResult {
	const read = readSettings(settingsPath);
	if (!read.ok) return { ok: false, status: 500, error: read.error };

	const prevParsed = HooksSliceSchema.safeParse((read.settings.hooks ?? {}) as unknown);
	if (!prevParsed.success) {
		return { ok: false, status: 500, error: `On-disk hooks slice is invalid: ${prevParsed.error.issues[0].message}` };
	}
	const previousSlice = prevParsed.data;
	const nextSlice: HooksSlice = JSON.parse(JSON.stringify(previousSlice));
	const groups = nextSlice[input.event];
	if (!groups || groups.length <= input.groupIndex || !groups[input.groupIndex]) {
		return { ok: false, status: 404, error: `No matcher group at ${input.event}[${input.groupIndex}]` };
	}
	const group = groups[input.groupIndex];
	if (!group.hooks || group.hooks.length <= input.hookIndex) {
		return {
			ok: false,
			status: 404,
			error: `No hook at ${input.event}[${input.groupIndex}].hooks[${input.hookIndex}]`,
		};
	}

	if (input.definition.type === "http") {
		const allowlist = Array.isArray(read.settings.allowedHttpHookUrls)
			? (read.settings.allowedHttpHookUrls as string[])
			: undefined;
		if (!isHttpUrlAllowed(input.definition.url, allowlist)) {
			return {
				ok: false,
				status: 403,
				error: `HTTP hook URL ${input.definition.url} is not on the allowedHttpHookUrls allowlist.`,
			};
		}
	}

	group.hooks[input.hookIndex] = input.definition;
	const validated = HooksSliceSchema.safeParse(nextSlice);
	if (!validated.success) {
		return {
			ok: false,
			status: 422,
			error: `Hook validation failed: ${validated.error.issues[0].message}`,
		};
	}
	const merged = { ...read.settings, hooks: validated.data };
	const write = writeSettings(merged, settingsPath);
	if (!write.ok) return { ok: false, status: 500, error: write.error };

	return { ok: true, slice: validated.data, previousSlice };
}

export type UninstallHookInput = {
	event: HookEvent;
	groupIndex: number;
	hookIndex: number;
};

export type UninstallHookResult =
	| { ok: true; slice: HooksSlice; previousSlice: HooksSlice }
	| { ok: false; status: 404 | 500; error: string };

export function uninstallHook(
	input: UninstallHookInput,
	settingsPath: string = getHooksSettingsPath(),
): UninstallHookResult {
	const read = readSettings(settingsPath);
	if (!read.ok) return { ok: false, status: 500, error: read.error };

	const prevParsed = HooksSliceSchema.safeParse((read.settings.hooks ?? {}) as unknown);
	if (!prevParsed.success) {
		return { ok: false, status: 500, error: `On-disk hooks slice is invalid: ${prevParsed.error.issues[0].message}` };
	}
	const previousSlice = prevParsed.data;
	const nextSlice: HooksSlice = JSON.parse(JSON.stringify(previousSlice));
	const groups = nextSlice[input.event];
	if (!groups || groups.length <= input.groupIndex || !groups[input.groupIndex]) {
		return { ok: false, status: 404, error: `No matcher group at ${input.event}[${input.groupIndex}]` };
	}
	const group = groups[input.groupIndex];
	if (!group.hooks || group.hooks.length <= input.hookIndex) {
		return {
			ok: false,
			status: 404,
			error: `No hook at ${input.event}[${input.groupIndex}].hooks[${input.hookIndex}]`,
		};
	}

	group.hooks.splice(input.hookIndex, 1);
	if (group.hooks.length === 0) {
		groups.splice(input.groupIndex, 1);
	}
	if (groups.length === 0) {
		delete nextSlice[input.event];
	}
	const merged = { ...read.settings, hooks: nextSlice };
	const write = writeSettings(merged, settingsPath);
	if (!write.ok) return { ok: false, status: 500, error: write.error };

	return { ok: true, slice: nextSlice, previousSlice };
}
