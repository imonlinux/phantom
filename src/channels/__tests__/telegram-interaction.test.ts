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
	};
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
			telegramMessageId: 42,
			...metadata,
		},
	};
}

describe("TELEGRAM_EMOJIS", () => {
	test("uses 👀 for queued (Slack parity)", () => {
		expect(TELEGRAM_EMOJIS.queued).toBe("👀");
	});

	test("uses 🤔 for thinking (🧠 not on Telegram allowlist)", () => {
		expect(TELEGRAM_EMOJIS.thinking).toBe("🤔");
		expect(TELEGRAM_EMOJIS.thinking).not.toBe("🧠");
	});

	test("uses 👨‍💻 for tool/coding/web (no subdivision; 🛠/🔧/💻/🌐 not allowed)", () => {
		const technologist = "👨\u200d💻";
		expect(TELEGRAM_EMOJIS.tool).toBe(technologist);
		expect(TELEGRAM_EMOJIS.coding).toBe(technologist);
		expect(TELEGRAM_EMOJIS.web).toBe(technologist);
	});

	test("uses 👌 for done (✅ not on Telegram allowlist)", () => {
		expect(TELEGRAM_EMOJIS.done).toBe("👌");
		expect(TELEGRAM_EMOJIS.done).not.toBe("✅");
	});

	test("uses 😱 for error (⚠ not on Telegram allowlist)", () => {
		expect(TELEGRAM_EMOJIS.error).toBe("😱");
		expect(TELEGRAM_EMOJIS.error).not.toBe("⚠");
		expect(TELEGRAM_EMOJIS.error).not.toBe("⚠️");
	});

	test("uses 🥱 for stallSoft and 😨 for stallHard", () => {
		expect(TELEGRAM_EMOJIS.stallSoft).toBe("🥱");
		expect(TELEGRAM_EMOJIS.stallHard).toBe("😨");
	});
});

describe("TELEGRAM_TIMING", () => {
	test("debounceMs is at least 1100ms (Telegram per-chat rate limit)", () => {
		expect(TELEGRAM_TIMING.debounceMs).toBeGreaterThanOrEqual(1100);
	});
});

describe("createTelegramInteractionFactory (Phase 2.1)", () => {
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

	test("creates an instance with statusReactions when messageId is present", () => {
		const { channel } = makeMockTelegramChannel();
		const factory = createTelegramInteractionFactory(channel);

		const instance = factory(makeTelegramMessage());
		expect(instance).not.toBeNull();
		expect(instance?.statusReactions).toBeDefined();
	});

	test("creates an instance WITHOUT statusReactions when messageId is missing", () => {
		const { channel } = makeMockTelegramChannel();
		const factory = createTelegramInteractionFactory(channel);

		const noMessageId = makeTelegramMessage({ telegramMessageId: undefined });
		const instance = factory(noMessageId);
		expect(instance).not.toBeNull();
		expect(instance?.statusReactions).toBeUndefined();
		// But typing still works
		expect(instance?.onTurnStart).toBeDefined();
		expect(instance?.onTurnEnd).toBeDefined();
	});

	test("setQueued fires the configured queued emoji on instance creation", async () => {
		const { channel, calls } = makeMockTelegramChannel();
		const factory = createTelegramInteractionFactory(channel);

		factory(makeTelegramMessage());
		await new Promise((r) => setTimeout(r, 50));

		const queuedCall = calls.setReaction.find((c) => c.emoji === TELEGRAM_EMOJIS.queued);
		expect(queuedCall).toBeDefined();
		expect(queuedCall?.chatId).toBe(123);
		expect(queuedCall?.messageId).toBe(42);
	});

	test("onTurnStart still starts typing", async () => {
		const { channel, calls } = makeMockTelegramChannel();
		const factory = createTelegramInteractionFactory(channel);

		const instance = factory(makeTelegramMessage());
		await instance?.onTurnStart?.();
		expect(calls.startTyping).toEqual([123]);
	});

	test("onTurnEnd still stops typing", async () => {
		const { channel, calls } = makeMockTelegramChannel();
		const factory = createTelegramInteractionFactory(channel);

		const instance = factory(makeTelegramMessage());
		await instance?.onTurnEnd?.({ text: "hi", isError: false });
		expect(calls.stopTyping).toEqual([123]);
	});

	test("onRuntimeEvent thinking transitions to 🤔 (after debounce)", async () => {
		const { channel, calls } = makeMockTelegramChannel();
		const factory = createTelegramInteractionFactory(channel);

		const instance = factory(makeTelegramMessage());
		instance?.onRuntimeEvent?.({ type: "thinking", sessionId: "s1" });
		// Telegram debounce is 1100ms; wait a bit longer
		await new Promise((r) => setTimeout(r, 1200));
		const thinkingCall = calls.setReaction.find((c) => c.emoji === TELEGRAM_EMOJIS.thinking);
		expect(thinkingCall).toBeDefined();
	});

	test("onRuntimeEvent tool_use transitions to 👨‍💻 (no subdivision)", async () => {
		const { channel, calls } = makeMockTelegramChannel();
		const factory = createTelegramInteractionFactory(channel);

		const instance = factory(makeTelegramMessage());
		// Read normally maps to coding in Slack's set; for Telegram all three
		// (tool/coding/web) collapse to the same 👨‍💻.
		instance?.onRuntimeEvent?.({
			type: "tool_use",
			tool: "Read",
			input: { file_path: "/x.ts" },
			sessionId: "s1",
		});
		await new Promise((r) => setTimeout(r, 1200));
		const toolCall = calls.setReaction.find((c) => c.emoji === TELEGRAM_EMOJIS.tool);
		expect(toolCall).toBeDefined();
	});

	test("onRuntimeEvent error transitions to 😱 immediately", async () => {
		const { channel, calls } = makeMockTelegramChannel();
		const factory = createTelegramInteractionFactory(channel);

		const instance = factory(makeTelegramMessage());
		instance?.onRuntimeEvent?.({ type: "error", message: "boom" });
		await new Promise((r) => setTimeout(r, 50));
		// setError uses finishWith, which is immediate (no debounce)
		const errorCall = calls.setReaction.find((c) => c.emoji === TELEGRAM_EMOJIS.error);
		expect(errorCall).toBeDefined();
	});

	test("does NOT define deliverResponse yet (P2.3 will add it)", () => {
		const { channel } = makeMockTelegramChannel();
		const factory = createTelegramInteractionFactory(channel);

		const instance = factory(makeTelegramMessage());
		expect(instance?.deliverResponse).toBeUndefined();
	});

	test("does NOT define progressStream yet (P2.2 will add it)", () => {
		const { channel } = makeMockTelegramChannel();
		const factory = createTelegramInteractionFactory(channel);

		const instance = factory(makeTelegramMessage());
		expect(instance?.progressStream).toBeUndefined();
	});

	test("dispose disposes the status reactions controller", () => {
		const { channel } = makeMockTelegramChannel();
		const factory = createTelegramInteractionFactory(channel);

		const instance = factory(makeTelegramMessage());
		expect(() => instance?.dispose?.()).not.toThrow();
	});

	test("removeReaction is a no-op (Telegram setMessageReaction replaces atomically)", async () => {
		// The controller's transition between emojis calls
		// removeReaction(prev) then addReaction(new). For Telegram, the
		// remove call should NOT hit the API since setMessageReaction
		// already replaces. Verify that emoji transitions only produce
		// addReaction-equivalent calls.
		const { channel, calls } = makeMockTelegramChannel();
		const factory = createTelegramInteractionFactory(channel);

		const instance = factory(makeTelegramMessage());
		await new Promise((r) => setTimeout(r, 50)); // queued
		instance?.onRuntimeEvent?.({ type: "thinking", sessionId: "s1" });
		await new Promise((r) => setTimeout(r, 1200)); // thinking

		// We should see queued, then thinking. No "remove" call should appear
		// (which would manifest as a setReaction call with the previous emoji
		// in the wrong order — but our adapter never makes that call at all).
		// Assert: only forward transitions appear, in the expected sequence.
		const reactionEmojis = calls.setReaction.map((c) => c.emoji);
		expect(reactionEmojis[0]).toBe(TELEGRAM_EMOJIS.queued);
		expect(reactionEmojis).toContain(TELEGRAM_EMOJIS.thinking);
		// Verify there's no call that "removes" the queued emoji separately —
		// the only way that would happen is if removeReaction wasn't a no-op.
		const queuedCount = reactionEmojis.filter((e) => e === TELEGRAM_EMOJIS.queued).length;
		expect(queuedCount).toBe(1);
	});
});
