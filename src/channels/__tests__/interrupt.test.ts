import { describe, expect, test } from "bun:test";
import {
	INTERRUPT_ACK,
	findInFlightMessage,
	isInterruptText,
	registerInFlightMessage,
	unregisterInFlightMessage,
} from "../interrupt.ts";

describe("isInterruptText", () => {
	test("matches the bare trigger words case-insensitively", () => {
		expect(isInterruptText("stop")).toBe(true);
		expect(isInterruptText("Stop")).toBe(true);
		expect(isInterruptText("  STOP  ")).toBe(true);
		expect(isInterruptText("/stop")).toBe(true);
		expect(isInterruptText("cancel")).toBe(true);
		expect(isInterruptText("CANCEL")).toBe(true);
	});

	test("matches a bare stop emoji, with or without variation selector", () => {
		expect(isInterruptText("🛑")).toBe(true);
		expect(isInterruptText("🛑️")).toBe(true);
	});

	test("rejects normal messages", () => {
		expect(isInterruptText("stop it")).toBe(false);
		expect(isInterruptText("stopping now")).toBe(false);
		expect(isInterruptText("please cancel the deploy")).toBe(false);
		expect(isInterruptText("")).toBe(false);
		expect(isInterruptText("👍")).toBe(false);
	});
});

describe("in-flight message registry", () => {
	test("round-trips a registered message to its target", () => {
		registerInFlightMessage("nextcloud", 42, {
			channelId: "nextcloud",
			conversationId: "nextcloud:room:room",
		});

		try {
			expect(findInFlightMessage("nextcloud", 42)).toEqual({
				channelId: "nextcloud",
				conversationId: "nextcloud:room:room",
			});
		} finally {
			unregisterInFlightMessage("nextcloud", 42);
		}
	});

	test("keys are channel-scoped", () => {
		registerInFlightMessage("nextcloud", 42, {
			channelId: "nextcloud",
			conversationId: "nextcloud:room:room",
		});

		try {
			expect(findInFlightMessage("telegram", 42)).toBeUndefined();
		} finally {
			unregisterInFlightMessage("nextcloud", 42);
		}
	});

	test("unregister clears the entry", () => {
		registerInFlightMessage("nextcloud", 7, {
			channelId: "nextcloud",
			conversationId: "nextcloud:room:thread1",
		});
		unregisterInFlightMessage("nextcloud", 7);
		expect(findInFlightMessage("nextcloud", 7)).toBeUndefined();
	});

	test("re-registration overwrites with the latest target", () => {
		registerInFlightMessage("nextcloud", 9, {
			channelId: "nextcloud",
			conversationId: "nextcloud:room:room",
		});
		registerInFlightMessage("nextcloud", 9, {
			channelId: "nextcloud",
			conversationId: "nextcloud:room:thread5",
		});

		try {
			expect(findInFlightMessage("nextcloud", 9)?.conversationId).toBe("nextcloud:room:thread5");
		} finally {
			unregisterInFlightMessage("nextcloud", 9);
		}
	});
});

describe("INTERRUPT_ACK", () => {
	test("is a plain, non-error response so turns end in a success state", () => {
		expect(INTERRUPT_ACK).toBe("Stopped.");
		expect(INTERRUPT_ACK.startsWith("Error:")).toBe(false);
	});
});
