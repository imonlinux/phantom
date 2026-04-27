import { describe, expect, mock, test } from "bun:test";
import { createTelegramInteractionFactory } from "../telegram-interaction.ts";
import type { InboundMessage } from "../types.ts";

function makeMockTelegramChannel() {
	const calls = {
		startTyping: [] as number[],
		stopTyping: [] as number[],
	};
	const channel = {
		startTyping: mock((chatId: number) => {
			calls.startTyping.push(chatId);
		}),
		stopTyping: mock((chatId: number) => {
			calls.stopTyping.push(chatId);
		}),
	};
	return {
		channel: channel as unknown as Parameters<typeof createTelegramInteractionFactory>[0],
		calls,
	};
}

function makeTelegramMessage(metadata: Record<string, unknown> = {}): InboundMessage {
	return {
		id: "msg-id",
		channelId: "telegram",
		conversationId: "telegram:123",
		senderId: "456",
		text: "hello",
		timestamp: new Date(),
		metadata: {
			telegramChatId: 123,
			...metadata,
		},
	};
}

describe("createTelegramInteractionFactory", () => {
	test("returns null when telegramChannel is null", () => {
		const factory = createTelegramInteractionFactory(null);
		expect(factory(makeTelegramMessage())).toBeNull();
	});

	test("returns null for non-telegram messages", () => {
		const { channel } = makeMockTelegramChannel();
		const factory = createTelegramInteractionFactory(channel);

		const slackMsg: InboundMessage = {
			id: "x",
			channelId: "slack",
			conversationId: "slack:C:t",
			senderId: "u",
			text: "hi",
			timestamp: new Date(),
			metadata: { slackChannel: "C", slackMessageTs: "t" },
		};
		expect(factory(slackMsg)).toBeNull();
	});

	test("returns null when chatId is missing from metadata", () => {
		const { channel } = makeMockTelegramChannel();
		const factory = createTelegramInteractionFactory(channel);

		const noChatId = makeTelegramMessage({ telegramChatId: undefined });
		expect(factory(noChatId)).toBeNull();
	});

	test("creates a minimal instance with onTurnStart and onTurnEnd hooks", () => {
		const { channel } = makeMockTelegramChannel();
		const factory = createTelegramInteractionFactory(channel);

		const instance = factory(makeTelegramMessage());
		expect(instance).not.toBeNull();
		expect(instance?.onTurnStart).toBeDefined();
		expect(instance?.onTurnEnd).toBeDefined();
		// Phase 1 only: no reactions, no progress, no delivery override
		expect(instance?.statusReactions).toBeUndefined();
		expect(instance?.progressStream).toBeUndefined();
		expect(instance?.deliverResponse).toBeUndefined();
	});

	test("onTurnStart starts typing for the chat", async () => {
		const { channel, calls } = makeMockTelegramChannel();
		const factory = createTelegramInteractionFactory(channel);

		const instance = factory(makeTelegramMessage());
		await instance?.onTurnStart?.();
		expect(calls.startTyping).toEqual([123]);
	});

	test("onTurnEnd stops typing for the chat", async () => {
		const { channel, calls } = makeMockTelegramChannel();
		const factory = createTelegramInteractionFactory(channel);

		const instance = factory(makeTelegramMessage());
		await instance?.onTurnEnd?.({ text: "hi", isError: false });
		expect(calls.stopTyping).toEqual([123]);
	});

	test("typing lifecycle: start before runtime, stop after", async () => {
		const { channel, calls } = makeMockTelegramChannel();
		const factory = createTelegramInteractionFactory(channel);

		const instance = factory(makeTelegramMessage({ telegramChatId: 999 }));
		await instance?.onTurnStart?.();
		// ...runtime would run here...
		await instance?.onTurnEnd?.({ text: "result", isError: false });

		expect(calls.startTyping).toEqual([999]);
		expect(calls.stopTyping).toEqual([999]);
	});
});
