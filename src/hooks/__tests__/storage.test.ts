import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installHook, listHooks, uninstallHook, updateHook } from "../storage.ts";

let tmp: string;
let settingsPath: string;

function writeSettings(obj: unknown): void {
	writeFileSync(settingsPath, `${JSON.stringify(obj, null, 2)}\n`);
}

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "phantom-hooks-"));
	settingsPath = join(tmp, "settings.json");
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("listHooks", () => {
	test("returns empty slice when settings.json does not exist", () => {
		const result = listHooks(settingsPath);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.slice).toEqual({});
		expect(result.total).toBe(0);
	});

	test("returns a populated slice", () => {
		writeSettings({
			enabledPlugins: { "linear@claude-plugins-official": true },
			hooks: {
				PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo pre" }] }],
			},
		});
		const result = listHooks(settingsPath);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.total).toBe(1);
		expect(result.slice.PreToolUse?.[0].matcher).toBe("Bash");
	});
});

describe("installHook: slice-only write", () => {
	test("install does not touch enabledPlugins", () => {
		writeSettings({
			enabledPlugins: { "linear@claude-plugins-official": true, "notion@claude-plugins-official": true },
			permissions: { allow: ["Bash(git:*)"], deny: [] },
			model: "claude-opus-4-6",
			x_custom_field: "preserved byte-for-byte",
		});
		const result = installHook(
			{
				event: "PreToolUse",
				matcher: "Bash",
				definition: { type: "command", command: "echo precheck" },
			},
			settingsPath,
		);
		expect(result.ok).toBe(true);
		const after = JSON.parse(readFileSync(settingsPath, "utf-8"));
		expect(after.enabledPlugins).toEqual({
			"linear@claude-plugins-official": true,
			"notion@claude-plugins-official": true,
		});
		expect(after.permissions).toEqual({ allow: ["Bash(git:*)"], deny: [] });
		expect(after.model).toBe("claude-opus-4-6");
		expect(after.x_custom_field).toBe("preserved byte-for-byte");
		expect(after.hooks.PreToolUse[0].matcher).toBe("Bash");
		expect(after.hooks.PreToolUse[0].hooks[0].command).toBe("echo precheck");
	});

	test("install appends to an existing matcher group", () => {
		writeSettings({
			hooks: {
				PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "first" }] }],
			},
		});
		const result = installHook(
			{
				event: "PreToolUse",
				matcher: "Bash",
				definition: { type: "command", command: "second" },
			},
			settingsPath,
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.slice.PreToolUse?.[0].hooks.length).toBe(2);
		expect(result.slice.PreToolUse?.[0].hooks[1]).toMatchObject({ type: "command", command: "second" });
	});

	test("install creates a new matcher group when matcher differs", () => {
		writeSettings({
			hooks: {
				PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "first" }] }],
			},
		});
		const result = installHook(
			{
				event: "PreToolUse",
				matcher: "Write",
				definition: { type: "command", command: "format.sh" },
			},
			settingsPath,
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.slice.PreToolUse?.length).toBe(2);
	});

	test("install refuses http hooks outside the allowlist", () => {
		writeSettings({
			allowedHttpHookUrls: ["https://hooks.example.com/*"],
		});
		const result = installHook(
			{
				event: "PostToolUse",
				definition: { type: "http", url: "https://evil.com/hook" },
			},
			settingsPath,
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.status).toBe(403);
	});

	test("install accepts http hooks matching the allowlist wildcard", () => {
		writeSettings({
			allowedHttpHookUrls: ["https://hooks.example.com/*"],
		});
		const result = installHook(
			{
				event: "PostToolUse",
				definition: { type: "http", url: "https://hooks.example.com/deploy" },
			},
			settingsPath,
		);
		expect(result.ok).toBe(true);
	});
});

describe("updateHook", () => {
	test("replaces the hook in place", () => {
		writeSettings({
			hooks: {
				PreToolUse: [
					{
						matcher: "Bash",
						hooks: [
							{ type: "command", command: "old" },
							{ type: "command", command: "also-old" },
						],
					},
				],
			},
		});
		const result = updateHook(
			{
				event: "PreToolUse",
				groupIndex: 0,
				hookIndex: 1,
				definition: { type: "command", command: "new" },
			},
			settingsPath,
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.slice.PreToolUse?.[0].hooks[0]).toMatchObject({ command: "old" });
		expect(result.slice.PreToolUse?.[0].hooks[1]).toMatchObject({ command: "new" });
	});

	test("returns 404 for an out-of-range group", () => {
		writeSettings({
			hooks: {
				PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "x" }] }],
			},
		});
		const result = updateHook(
			{
				event: "PreToolUse",
				groupIndex: 5,
				hookIndex: 0,
				definition: { type: "command", command: "y" },
			},
			settingsPath,
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.status).toBe(404);
	});
});

describe("uninstallHook", () => {
	test("removes the hook and preserves siblings", () => {
		writeSettings({
			enabledPlugins: { "linear@claude-plugins-official": true },
			hooks: {
				PreToolUse: [
					{
						matcher: "Bash",
						hooks: [
							{ type: "command", command: "keep" },
							{ type: "command", command: "remove" },
						],
					},
				],
			},
		});
		const result = uninstallHook({ event: "PreToolUse", groupIndex: 0, hookIndex: 1 }, settingsPath);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.slice.PreToolUse?.[0].hooks.length).toBe(1);
		expect(result.slice.PreToolUse?.[0].hooks[0]).toMatchObject({ command: "keep" });
		// enabledPlugins preserved
		const after = JSON.parse(readFileSync(settingsPath, "utf-8"));
		expect(after.enabledPlugins).toEqual({ "linear@claude-plugins-official": true });
	});

	test("removes the group when the last hook is uninstalled", () => {
		writeSettings({
			hooks: {
				PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "only" }] }],
			},
		});
		const result = uninstallHook({ event: "PreToolUse", groupIndex: 0, hookIndex: 0 }, settingsPath);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.slice.PreToolUse).toBeUndefined();
	});

	test("returns 404 for missing hook", () => {
		writeSettings({ hooks: {} });
		const result = uninstallHook({ event: "PreToolUse", groupIndex: 0, hookIndex: 0 }, settingsPath);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.status).toBe(404);
	});
});

describe("byte-for-byte preservation of PR2 fields", () => {
	test("a full install/uninstall cycle leaves enabledPlugins identical", () => {
		const enabledBefore = {
			"linear@claude-plugins-official": true,
			"notion@claude-plugins-official": true,
			"slack@claude-plugins-official": { version: "1.2.3" },
			"claude-md-management@claude-plugins-official": false,
		};
		writeSettings({ enabledPlugins: enabledBefore });

		const install = installHook(
			{
				event: "UserPromptSubmit",
				definition: { type: "prompt", prompt: "Evaluate whether the request is safe." },
			},
			settingsPath,
		);
		expect(install.ok).toBe(true);

		let after = JSON.parse(readFileSync(settingsPath, "utf-8"));
		expect(after.enabledPlugins).toEqual(enabledBefore);

		const uninstall = uninstallHook({ event: "UserPromptSubmit", groupIndex: 0, hookIndex: 0 }, settingsPath);
		expect(uninstall.ok).toBe(true);

		after = JSON.parse(readFileSync(settingsPath, "utf-8"));
		expect(after.enabledPlugins).toEqual(enabledBefore);
	});
});
