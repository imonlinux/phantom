import { describe, expect, mock, test } from "bun:test";
import { TelegramChannel, type TelegramChannelConfig } from "../telegram.ts";

function makeChannelWithMockApi(overrides: Record<string, any> = {}) {
	const channel = new TelegramChannel({ botToken: "test-token" } as TelegramChannelConfig);
	const sendMessage = overrides.sendMessage ?? mock(async () => ({ message_id: 100 }));
	const editMessageText = overrides.editMessageText ?? mock(async () => undefined);
	(channel as unknown as { bot: unknown }).bot = {
		telegram: {
			sendMessage,
			editMessageText,
			editMessageReplyMarkup: mock(async () => undefined),
			sendChatAction: mock(async () => undefined),
			setMessageReaction: mock(async () => undefined),
			getMe: mock(async () => ({ id: 1, is_bot: true, first_name: "Bot" })),
		},
		launch: mock(async () => undefined),
		stop: mock(() => undefined),
		command: mock(() => undefined),
		on: mock(() => undefined),
		action: mock(() => undefined),
	};
	return { channel, sendMessage, editMessageText };
}

describe("TelegramChannel.postProgressMessage", () => {
	test("returns null when bot is not connected", async () => {
		const channel = new TelegramChannel({ botToken: "x" } as TelegramChannelConfig);
		expect(await channel.postProgressMessage(123)).toBeNull();
	});

	test('sends "Working on it..." as plain text (no parse_mode)', async () => {
		const calls: any[] = [];
		const { channel } = makeChannelWithMockApi({
			sendMessage: mock(async (...args: any[]) => {
				calls.push(args);
				return { message_id: 100 };
			}),
		});

		const id = await channel.postProgressMessage(123);
		expect(id).toBe(100);
		expect(calls.length).toBe(1);
		expect(calls[0][0]).toBe(123);
		expect(calls[0][1]).toBe("Working on it...");
		// No parse_mode option — the third arg should be undefined or
		// an empty options object. Both are acceptable; what matters is
		// that there's no MarkdownV2 escape.
		expect(calls[0][2]).toBeUndefined();
	});

	test("returns null when sendMessage throws", async () => {
		const { channel } = makeChannelWithMockApi({
			sendMessage: mock(async () => {
				throw new Error("network error");
			}),
		});
		expect(await channel.postProgressMessage(123)).toBeNull();
	});

	test("declares progressUpdates capability", () => {
		const channel = new TelegramChannel({ botToken: "x" } as TelegramChannelConfig);
		expect(channel.capabilities.progressUpdates).toBe(true);
	});
});

describe("TelegramChannel.updateProgressMessage", () => {
	test("does nothing when bot is not connected", async () => {
		const channel = new TelegramChannel({ botToken: "x" } as TelegramChannelConfig);
		// Should not throw
		await channel.updateProgressMessage(123, 100, "new text");
	});

	test("calls editMessageText with plain text (no parse_mode)", async () => {
		const calls: any[] = [];
		const { channel } = makeChannelWithMockApi({
			editMessageText: mock(async (...args: any[]) => {
				calls.push(args);
				return undefined;
			}),
		});

		await channel.updateProgressMessage(123, 100, "Working on it...\n> Reading /x.ts");
		expect(calls.length).toBe(1);
		expect(calls[0][0]).toBe(123);
		expect(calls[0][1]).toBe(100);
		expect(calls[0][2]).toBeUndefined(); // inlineMessageId
		expect(calls[0][3]).toBe("Working on it...\n> Reading /x.ts");
		expect(calls[0][4]).toBeUndefined(); // no options/parse_mode
	});

	test("silently swallows 'message is not modified' error", async () => {
		const { channel } = makeChannelWithMockApi({
			editMessageText: mock(async () => {
				throw new Error("400: Bad Request: message is not modified");
			}),
		});
		// Should not throw, should not warn loudly
		await expect(channel.updateProgressMessage(123, 100, "same text")).resolves.toBeUndefined();
	});

	test("warns but does not throw on other errors", async () => {
		const { channel } = makeChannelWithMockApi({
			editMessageText: mock(async () => {
				throw new Error("network error");
			}),
		});
		await expect(channel.updateProgressMessage(123, 100, "text")).resolves.toBeUndefined();
	});
});

describe("TelegramChannel.finishProgressMessage", () => {
	test("throws when bot is not connected", async () => {
		const channel = new TelegramChannel({ botToken: "x" } as TelegramChannelConfig);
		await expect(channel.finishProgressMessage(123, 100, "final")).rejects.toThrow();
	});

	test("edits in place with MarkdownV2 escape (happy path)", async () => {
		const editCalls: any[] = [];
		const sendCalls: any[] = [];
		const { channel } = makeChannelWithMockApi({
			editMessageText: mock(async (...args: any[]) => {
				editCalls.push(args);
				return undefined;
			}),
			sendMessage: mock(async (...args: any[]) => {
				sendCalls.push(args);
				return { message_id: 999 };
			}),
		});

		const id = await channel.finishProgressMessage(123, 100, "Hello world!");
		expect(id).toBe(100); // edited in place, returns same id
		expect(editCalls.length).toBe(1);
		expect(sendCalls.length).toBe(0); // no fallback send
		expect(editCalls[0][0]).toBe(123);
		expect(editCalls[0][1]).toBe(100);
		// "Hello world!" → "Hello world\\!" after escape (! is a MarkdownV2 special char)
		expect(editCalls[0][3]).toBe("Hello world\\!");
		expect(editCalls[0][4]).toEqual({ parse_mode: "MarkdownV2" });
	});

	test("falls back to fresh send when message exceeds 4096 chars", async () => {
		const editCalls: any[] = [];
		const sendCalls: any[] = [];
		const { channel } = makeChannelWithMockApi({
			editMessageText: mock(async (...args: any[]) => {
				editCalls.push(args);
				return undefined;
			}),
			sendMessage: mock(async (...args: any[]) => {
				sendCalls.push(args);
				return { message_id: 999 };
			}),
		});

		// Generate a string that escapes to > 4096 chars. Plain `a` doesn't
		// need escape so 5000 'a's stays 5000 chars.
		const longText = "a".repeat(5000);
		const id = await channel.finishProgressMessage(123, 100, longText);
		expect(id).toBe(999); // fresh message id, not 100
		expect(editCalls.length).toBe(0); // edit skipped
		expect(sendCalls.length).toBe(1);
		expect(sendCalls[0][1]).toBe(longText);
		expect(sendCalls[0][2]).toEqual({ parse_mode: "MarkdownV2" });
	});

	test("returns same id on 'message is not modified' (treated as success)", async () => {
		const { channel } = makeChannelWithMockApi({
			editMessageText: mock(async () => {
				throw new Error("400: Bad Request: message is not modified");
			}),
		});

		const id = await channel.finishProgressMessage(123, 100, "Hi");
		expect(id).toBe(100);
	});

	test("falls back to fresh send when editMessageText fails for other reasons", async () => {
		const sendCalls: any[] = [];
		const { channel } = makeChannelWithMockApi({
			editMessageText: mock(async () => {
				throw new Error("400: Bad Request: can't parse entities");
			}),
			sendMessage: mock(async (...args: any[]) => {
				sendCalls.push(args);
				return { message_id: 999 };
			}),
		});

		const id = await channel.finishProgressMessage(123, 100, "Hello *world*");
		expect(id).toBe(999);
		expect(sendCalls.length).toBe(1);
	});

	test("propagates error if both edit and fallback send fail", async () => {
		const { channel } = makeChannelWithMockApi({
			editMessageText: mock(async () => {
				throw new Error("edit failed");
			}),
			sendMessage: mock(async () => {
				throw new Error("send also failed");
			}),
		});

		await expect(channel.finishProgressMessage(123, 100, "x")).rejects.toThrow("send also failed");
	});
});
