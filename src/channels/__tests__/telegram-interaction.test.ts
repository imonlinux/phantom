import { describe, expect, mock, test } from "bun:test";
import {
	createTelegramInteractionFactory,
	TELEGRAM_EMOJIS,
	TELEGRAM_TIMING,
} from "../telegram-interaction.ts";
import type { InboundMessage } from "../types.ts";

function makeMockTelegramChannel() {
	const calls = {
		startTyping: [] as number[],
		stopTyping: [] as number[],
		setReaction: [] as Array<{ chatId: number; messageId: number; emoji: string }>,
		postProgressMessage: [] as number[],
		updateProgressMessage: [] as Array<{ chatId: number; messageId: number; text: string }>,
		finishProgressMessage: [] as Array<{
			chatId: number;
			messageId: number;
			text: string;
			attachFeedback: boolean | undefined;
		}>,
	};
	let nextProgressMessageId: number | null = 7777;

	const channel = {
		startTyping: mock((chatId: number) => {
			calls.startTyping.push(chatId);
		}),
		stopTyping: mock((chatId: number) => {
			calls.stopTyping.push(chatId);
		}),
		setReaction: mock(async (chatId: number, messageId: number, emoji: string) => {
			calls.setReaction.push({ chatId, messageId, emoji });
			return true;
		}),
		postProgressMessage: mock(async (chatId: number) => {
			calls.postProgressMessage.push(chatId);
			return nextProgressMessageId;
		}),
		updateProgressMessage: mock(async (chatId: number, messageId: number, text: string) => {
			calls.updateProgressMessage.push({ chatId, messageId, text });
		}),
		finishProgressMessage: mock(
			async (chatId: number, messageId: number, text: string, attachFeedback?: boolean) => {
				calls.finishProgressMessage.push({ chatId, messageId, text, attachFeedback });
				return messageId;
			},
		),
	};

	return {
		channel: channel as unknown as Parameters<typeof createTelegramInteractionFactory>[0],
		calls,
		setNextProgressMessageId(id: number | null) {
			nextProgressMessageId = id;
		},
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
			telegramMessageId: 42,
			...metadata,
		},
	};
}

describe("TELEGRAM_EMOJIS (P2.1)", () => {
	test("uses 👀 for queued", () => {
		expect(TELEGRAM_EMOJIS.queued).toBe("👀");
	});
	test("uses 🤔 for thinking", () => {
		expect(TELEGRAM_EMOJIS.thinking).toBe("🤔");
	});
	test("uses 👨‍💻 for tool/coding/web", () => {
		const tech = "👨\u200d💻";
		expect(TELEGRAM_EMOJIS.tool).toBe(tech);
		expect(TELEGRAM_EMOJIS.coding).toBe(tech);
		expect(TELEGRAM_EMOJIS.web).toBe(tech);
	});
	test("uses 👌 for done, 😱 for error", () => {
		expect(TELEGRAM_EMOJIS.done).toBe("👌");
		expect(TELEGRAM_EMOJIS.error).toBe("😱");
	});
	test("uses 🥱/😨 for stallSoft/stallHard", () => {
		expect(TELEGRAM_EMOJIS.stallSoft).toBe("🥱");
		expect(TELEGRAM_EMOJIS.stallHard).toBe("😨");
	});
});

describe("TELEGRAM_TIMING (P2.1)", () => {
	test("debounceMs is at least 1100ms", () => {
		expect(TELEGRAM_TIMING.debounceMs).toBeGreaterThanOrEqual(1100);
	});
});

describe("createTelegramInteractionFactory: gating", () => {
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

	test("returns null when chatId is missing", () => {
		const { channel } = makeMockTelegramChannel();
		const factory = createTelegramInteractionFactory(channel);
		const noChatId = makeTelegramMessage({ telegramChatId: undefined });
		expect(factory(noChatId)).toBeNull();
	});

	test("creates an instance with statusReactions when messageId is present", () => {
		const { channel } = makeMockTelegramChannel();
		const factory = createTelegramInteractionFactory(channel);
		const instance = factory(makeTelegramMessage());
		expect(instance?.statusReactions).toBeDefined();
	});

	test("creates an instance WITHOUT statusReactions when messageId is missing", () => {
		const { channel } = makeMockTelegramChannel();
		const factory = createTelegramInteractionFactory(channel);
		const noMessageId = makeTelegramMessage({ telegramMessageId: undefined });
		const instance = factory(noMessageId);
		expect(instance?.statusReactions).toBeUndefined();
	});
});

describe("createTelegramInteractionFactory: reactions (P2.1)", () => {
	test("setQueued fires immediately on instance creation", async () => {
		const { channel, calls } = makeMockTelegramChannel();
		const factory = createTelegramInteractionFactory(channel);
		factory(makeTelegramMessage());
		await new Promise((r) => setTimeout(r, 50));
		const queuedCall = calls.setReaction.find((c) => c.emoji === TELEGRAM_EMOJIS.queued);
		expect(queuedCall).toBeDefined();
	});

	test("onRuntimeEvent thinking transitions to 🤔", async () => {
		const { channel, calls } = makeMockTelegramChannel();
		const factory = createTelegramInteractionFactory(channel);
		const instance = factory(makeTelegramMessage());
		instance?.onRuntimeEvent?.({ type: "thinking", sessionId: "s1" });
		await new Promise((r) => setTimeout(r, 1200));
		expect(calls.setReaction.find((c) => c.emoji === TELEGRAM_EMOJIS.thinking)).toBeDefined();
	});

	test("onRuntimeEvent tool_use transitions to 👨‍💻", async () => {
		const { channel, calls } = makeMockTelegramChannel();
		const factory = createTelegramInteractionFactory(channel);
		const instance = factory(makeTelegramMessage());
		instance?.onRuntimeEvent?.({
			type: "tool_use",
			tool: "Read",
			input: { file_path: "/x.ts" },
			sessionId: "s1",
		});
		await new Promise((r) => setTimeout(r, 1200));
		expect(calls.setReaction.find((c) => c.emoji === TELEGRAM_EMOJIS.tool)).toBeDefined();
	});

	test("onRuntimeEvent error transitions to 😱 immediately", async () => {
		const { channel, calls } = makeMockTelegramChannel();
		const factory = createTelegramInteractionFactory(channel);
		const instance = factory(makeTelegramMessage());
		instance?.onRuntimeEvent?.({ type: "error", message: "boom" });
		await new Promise((r) => setTimeout(r, 50));
		expect(calls.setReaction.find((c) => c.emoji === TELEGRAM_EMOJIS.error)).toBeDefined();
	});
});

describe("createTelegramInteractionFactory: progress stream (P2.2)", () => {
	test("instance has a progressStream defined", () => {
		const { channel } = makeMockTelegramChannel();
		const factory = createTelegramInteractionFactory(channel);
		const instance = factory(makeTelegramMessage());
		expect(instance?.progressStream).toBeDefined();
	});

	test("onTurnStart starts typing AND posts the progress message", async () => {
		const { channel, calls } = makeMockTelegramChannel();
		const factory = createTelegramInteractionFactory(channel);
		const instance = factory(makeTelegramMessage());
		await instance?.onTurnStart?.();
		expect(calls.startTyping).toEqual([123]);
		expect(calls.postProgressMessage).toEqual([123]);
	});

	test("onRuntimeEvent tool_use adds activity to the progress stream", async () => {
		const { channel, calls } = makeMockTelegramChannel();
		const factory = createTelegramInteractionFactory(channel);
		const instance = factory(makeTelegramMessage());
		await instance?.onTurnStart?.();
		instance?.onRuntimeEvent?.({
			type: "tool_use",
			tool: "Read",
			input: { file_path: "/x.ts" },
			sessionId: "s1",
		});
		await new Promise((r) => setTimeout(r, 1100));
		expect(calls.updateProgressMessage.length).toBeGreaterThanOrEqual(1);
		expect(calls.updateProgressMessage.some((c) => c.text.includes("Reading /x.ts"))).toBe(true);
	});

	test("deliverResponse claims the response by finishing the progress stream", async () => {
		const { channel, calls } = makeMockTelegramChannel();
		const factory = createTelegramInteractionFactory(channel);
		const instance = factory(makeTelegramMessage());
		await instance?.onTurnStart?.();
		const claimed = await instance?.deliverResponse?.({ text: "Final answer", isError: false });
		expect(claimed).toBe(true);
		expect(calls.finishProgressMessage.length).toBe(1);
		expect(calls.finishProgressMessage[0].text).toBe("Final answer");
	});

	test("deliverResponse falls through (returns false) when progress message couldn't be posted", async () => {
		const harness = makeMockTelegramChannel();
		harness.setNextProgressMessageId(null);
		const factory = createTelegramInteractionFactory(harness.channel);
		const instance = factory(makeTelegramMessage());
		await instance?.onTurnStart?.();
		const claimed = await instance?.deliverResponse?.({ text: "answer", isError: false });
		expect(claimed).toBe(false);
		expect(harness.calls.finishProgressMessage.length).toBe(0);
	});
});

// P2.3: new tests for feedback button attachment
describe("createTelegramInteractionFactory: feedback buttons (P2.3)", () => {
	test("deliverResponse passes attachFeedback=true to finishProgressMessage", async () => {
		const { channel, calls } = makeMockTelegramChannel();
		const factory = createTelegramInteractionFactory(channel);
		const instance = factory(makeTelegramMessage());

		await instance?.onTurnStart?.();
		await instance?.deliverResponse?.({ text: "Final answer", isError: false });

		expect(calls.finishProgressMessage.length).toBe(1);
		expect(calls.finishProgressMessage[0].attachFeedback).toBe(true);
	});

	test("attachFeedback is true even on error responses", async () => {
		const { channel, calls } = makeMockTelegramChannel();
		const factory = createTelegramInteractionFactory(channel);
		const instance = factory(makeTelegramMessage());

		await instance?.onTurnStart?.();
		await instance?.deliverResponse?.({ text: "Error: something broke", isError: true });

		expect(calls.finishProgressMessage.length).toBe(1);
		expect(calls.finishProgressMessage[0].attachFeedback).toBe(true);
	});
});

describe("createTelegramInteractionFactory: typing (P1)", () => {
	test("onTurnEnd stops typing", async () => {
		const { channel, calls } = makeMockTelegramChannel();
		const factory = createTelegramInteractionFactory(channel);
		const instance = factory(makeTelegramMessage());
		await instance?.onTurnEnd?.({ text: "hi", isError: false });
		expect(calls.stopTyping).toEqual([123]);
	});

	test("dispose disposes the status reactions controller", () => {
		const { channel } = makeMockTelegramChannel();
		const factory = createTelegramInteractionFactory(channel);
		const instance = factory(makeTelegramMessage());
		expect(() => instance?.dispose?.()).not.toThrow();
	});
});
