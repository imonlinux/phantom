import { describe, expect, test } from "bun:test";
import * as eventsModule from "../../ui/events.ts";
import { emitPluginInitSnapshot, extractPluginKeys } from "../init-plugin-snapshot.ts";

describe("extractPluginKeys", () => {
	test("returns empty array on null", () => {
		expect(extractPluginKeys(null)).toEqual([]);
	});

	test("returns empty array on undefined", () => {
		expect(extractPluginKeys(undefined)).toEqual([]);
	});

	test("returns empty array when plugins field missing", () => {
		expect(extractPluginKeys({})).toEqual([]);
	});

	test("returns empty array when plugins is not an array", () => {
		expect(
			extractPluginKeys({ plugins: "not-an-array" } as unknown as Parameters<typeof extractPluginKeys>[0]),
		).toEqual([]);
	});

	test("extracts names from valid plugin entries", () => {
		const result = extractPluginKeys({
			plugins: [{ name: "linear@claude-plugins-official" }, { name: "notion@claude-plugins-official" }],
		});
		expect(result).toEqual(["linear@claude-plugins-official", "notion@claude-plugins-official"]);
	});

	test("filters out entries without a string name", () => {
		const result = extractPluginKeys({
			plugins: [{ name: "linear" }, null, { name: "" }, {}, { name: 42 as unknown as string }, { name: "notion" }],
		});
		expect(result).toEqual(["linear", "notion"]);
	});
});

describe("emitPluginInitSnapshot", () => {
	test("calls publish with extracted keys on a well-formed init message", () => {
		const received: Array<{ event: string; data: unknown }> = [];
		const unsub = eventsModule.subscribe((event, data) => received.push({ event, data }));
		try {
			emitPluginInitSnapshot({
				plugins: [{ name: "linear@claude-plugins-official" }, { name: "slack@claude-plugins-official" }],
			});
		} finally {
			unsub();
		}
		expect(received.length).toBe(1);
		expect(received[0].event).toBe("plugin_init_snapshot");
		expect(received[0].data).toEqual({
			keys: ["linear@claude-plugins-official", "slack@claude-plugins-official"],
		});
	});

	test("publishes empty keys when plugins missing", () => {
		const received: Array<{ event: string; data: unknown }> = [];
		const unsub = eventsModule.subscribe((event, data) => received.push({ event, data }));
		try {
			emitPluginInitSnapshot({});
		} finally {
			unsub();
		}
		expect(received.length).toBe(1);
		expect(received[0].data).toEqual({ keys: [] });
	});

	test("publishes empty keys on null input", () => {
		const received: Array<{ event: string; data: unknown }> = [];
		const unsub = eventsModule.subscribe((event, data) => received.push({ event, data }));
		try {
			emitPluginInitSnapshot(null);
		} finally {
			unsub();
		}
		expect(received.length).toBe(1);
		expect(received[0].data).toEqual({ keys: [] });
	});

	test("does not throw when a subscriber throws; isolates via existing publish fallback", () => {
		// publish() already wraps each listener in try/catch (events.ts:12-17),
		// so a throwing subscriber does not reach emitPluginInitSnapshot's
		// try/catch. This test confirms no propagation either way.
		const unsub = eventsModule.subscribe(() => {
			throw new Error("subscriber-boom");
		});
		try {
			expect(() => emitPluginInitSnapshot({ plugins: [{ name: "x" }] })).not.toThrow();
		} finally {
			unsub();
		}
	});
});
