import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { type TelegrafContext, TelegramChannel, type TelegramChannelConfig } from "../telegram.ts";
import type { InboundMessage } from "../types.ts";

// Photos must not touch the real filesystem in tests: stub node:fs and
// Bun.write so the handler's save step is captured, not executed.
mock.module("node:fs", () => ({
	default: {
		existsSync: mock(() => true),
		mkdirSync: mock(() => undefined),
	},
	existsSync: mock(() => true),
	mkdirSync: mock(() => undefined),
}));

function makeChannelWithMockBot(config: TelegramChannelConfig) {
	const channel = new TelegramChannel(config);

	const handlers = {
		photo: null as ((ctx: TelegrafContext) => Promise<void>) | null,
	};

	const sentReplies: Array<{ chatId: number; text: string }> = [];

	const mockBot = {
		launch: mock(async () => undefined),
		stop: mock(() => undefined),
		command: mock((_cmd: string, _h: (ctx: TelegrafContext) => Promise<void>) => undefined),
		on: mock((event: string, h: (ctx: TelegrafContext) => Promise<void>) => {
			if (event === "photo") handlers.photo = h;
		}),
		action: mock((_pattern: RegExp, _h: (ctx: TelegrafContext) => Promise<void>) => undefined),
		reaction: mock((_emoji: string | string[], _h: (ctx: TelegrafContext) => Promise<void>) => undefined),
		telegram: {
			sendMessage: mock(async (chatId: number, text: string) => {
				sentReplies.push({ chatId, text });
				return { message_id: 1 };
			}),
			getFile: mock(async (fileId: string) => {
				if (fileId === "photo-large-file-id") return { file_path: "photos/file_123.jpg" };
				return { file_path: "photos/file_other.jpg" };
			}),
			sendChatAction: mock(async () => undefined),
			setMessageReaction: mock(async () => undefined),
			getMe: mock(async () => ({ id: 999, is_bot: true, first_name: "Bot" })),
		},
	};

	(channel as unknown as { bot: unknown }).bot = mockBot;
	(channel as unknown as { registerHandlers: () => void }).registerHandlers();

	return { channel, mockBot, handlers, sentReplies };
}

function makePhotoCtx(args: { chatId: number; userId: number; messageId?: number }): TelegrafContext {
	return {
		message: {
			photo: [
				{ file_id: "photo-small-file-id", file_size: 10000 },
				{ file_id: "photo-large-file-id", file_size: 200000 },
			],
			from: { id: args.userId, first_name: "User" },
			chat: { id: args.chatId, type: "private" },
			message_id: args.messageId ?? 77,
		},
		reply: async () => ({ message_id: 99 }),
	} as unknown as TelegrafContext;
}

describe("photo handler", () => {
	const originalFetch = globalThis.fetch;
	const originalWrite = Bun.write;

	beforeEach(() => {
		// Capture the handler's save step instead of writing to disk.
		Bun.write = (async (_path: string, data: ArrayBuffer) => {
			return data.byteLength;
		}) as typeof Bun.write;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		Bun.write = originalWrite;
	});

	test("downloads the largest variant and routes an inbound message with attachment", async () => {
		const { channel, mockBot, handlers } = makeChannelWithMockBot({ botToken: "test" });
		const received: InboundMessage[] = [];
		channel.onMessage(async (msg) => {
			received.push(msg);
		});

		globalThis.fetch = mock(async () => ({
			ok: true,
			statusText: "OK",
			arrayBuffer: async () => new ArrayBuffer(16),
		})) as unknown as typeof fetch;

		await handlers.photo?.(makePhotoCtx({ chatId: 100, userId: 5 }));

		expect(mockBot.telegram.getFile).toHaveBeenCalledWith("photo-large-file-id");
		expect(received.length).toBe(1);
		const inbound = received[0] as InboundMessage;
		expect(inbound.channelId).toBe("telegram");
		expect(inbound.conversationId).toBe("telegram:100");
		expect(inbound.text).toBe("[Photo attachment: telegram-photo-77.jpg]");
		expect(inbound.attachments).toEqual([
			{
				filename: "telegram-photo-77.jpg",
				path: "/app/data/attachments/telegram-photo-77.jpg",
				size: 16,
				mimeType: "image/jpeg",
			},
		]);
		expect(inbound.metadata?.telegramFileId).toBe("photo-large-file-id");
	});

	test("photo from a non-owner DM gets the rejection reply and is not routed", async () => {
		const { channel, handlers, sentReplies } = makeChannelWithMockBot({
			botToken: "test",
			ownerUserIds: ["5"],
		});
		let called = false;
		channel.onMessage(async () => {
			called = true;
		});

		await handlers.photo?.(makePhotoCtx({ chatId: 100, userId: 999 }));

		expect(called).toBe(false);
		expect(sentReplies.length).toBe(1);
	});

	test("failed download drops the message without routing", async () => {
		const { channel, handlers } = makeChannelWithMockBot({ botToken: "test" });
		const received: InboundMessage[] = [];
		channel.onMessage(async (msg) => {
			received.push(msg);
		});

		globalThis.fetch = mock(async () => ({
			ok: false,
			statusText: "Bad Gateway",
			arrayBuffer: async () => new ArrayBuffer(0),
		})) as unknown as typeof fetch;

		await handlers.photo?.(makePhotoCtx({ chatId: 100, userId: 5 }));

		expect(received.length).toBe(0);
	});
});
