import { beforeEach, describe, expect, mock, test } from "bun:test";
import { registerInFlightMessage, unregisterInFlightMessage } from "../interrupt.ts";
import { TelegramChannel, type TelegramChannelConfig } from "../telegram.ts";

type ReactionCtx = {
	update: {
		message_reaction?: {
			chat?: { id: number };
			message_id?: number;
			user?: { id: number };
			new_reaction?: Array<{ type: string; emoji: string }>;
		};
	};
};

/**
 * Mirrors the telegram-reactions-feedback.test.ts harness: mock bot wired
 * in, registerHandlers invoked manually, reaction handlers captured so
 * tests can invoke them with synthetic reaction-update contexts.
 */
function makeChannelWithMockBot(config: TelegramChannelConfig) {
	const channel = new TelegramChannel(config);

	const handlers = {
		reactions: [] as Array<{ emoji: string | string[]; handler: (ctx: ReactionCtx) => Promise<void> }>,
	};

	const mockBot = {
		launch: mock(async () => undefined),
		stop: mock(() => undefined),
		command: mock(() => undefined),
		on: mock(() => undefined),
		action: mock(() => undefined),
		reaction: mock((emoji: string | string[], h: (ctx: ReactionCtx) => Promise<void>) => {
			handlers.reactions.push({ emoji, handler: h });
		}),
		telegram: {},
	};

	(channel as unknown as { bot: unknown }).bot = mockBot;
	(channel as unknown as { registerHandlers: () => void }).registerHandlers();

	return { channel, handlers };
}

/**
 * Synthetic Telegraf message_reaction context. newReaction entries follow
 * the ReactionType shape ({ type: "emoji", emoji: string }).
 */
function makeReactionCtx(args: {
	chatId?: number;
	messageId?: number;
	userId?: number;
	newReaction?: Array<{ type: string; emoji: string }>;
}): ReactionCtx {
	return {
		update: {
			message_reaction: {
				chat: args.chatId !== undefined ? { id: args.chatId } : undefined,
				message_id: args.messageId,
				user: args.userId !== undefined ? { id: args.userId } : undefined,
				new_reaction: args.newReaction ?? [],
			},
		},
	};
}

function findStopHandler(handlers: { reactions: Array<{ emoji: string | string[] }> }): number {
	return handlers.reactions.findIndex((r) => (Array.isArray(r.emoji) ? r.emoji : [r.emoji]).includes("😡"));
}

describe("Telegram reaction-based agent interrupt", () => {
	let interrupts: Array<{ conversationId: string; messageId: number }>;

	beforeEach(() => {
		interrupts = [];
	});

	test("registers a handler for the default stop emoji", () => {
		const { handlers } = makeChannelWithMockBot({ botToken: "t", enableMessageReactions: true });
		expect(findStopHandler(handlers)).toBeGreaterThanOrEqual(0);
	});

	test("stop reaction on the in-flight message fires onInterrupt", async () => {
		const { channel, handlers } = makeChannelWithMockBot({
			botToken: "t",
			ownerUserIds: ["111"],
			enableMessageReactions: true,
		});
		channel.onInterrupt = (t) => interrupts.push(t);
		registerInFlightMessage("telegram", 777, {
			channelId: "telegram",
			conversationId: "telegram:555",
		});

		try {
			const idx = findStopHandler(handlers);
			await handlers.reactions[idx].handler(
				makeReactionCtx({
					chatId: 555,
					messageId: 777,
					userId: 111,
					newReaction: [{ type: "emoji", emoji: "😡" }],
				}),
			);
			expect(interrupts).toHaveLength(1);
			expect(interrupts[0].conversationId).toBe("telegram:555");
			expect(interrupts[0].messageId).toBe(777);
		} finally {
			unregisterInFlightMessage("telegram", 777);
		}
	});

	test("reaction on a message with no active turn does not fire onInterrupt", async () => {
		const { channel, handlers } = makeChannelWithMockBot({
			botToken: "t",
			ownerUserIds: ["111"],
			enableMessageReactions: true,
		});
		channel.onInterrupt = (t) => interrupts.push(t);

		const idx = findStopHandler(handlers);
		await handlers.reactions[idx].handler(
			makeReactionCtx({
				chatId: 555,
				messageId: 999,
				userId: 111,
				newReaction: [{ type: "emoji", emoji: "😡" }],
			}),
		);
		expect(interrupts).toHaveLength(0);
	});

	test("stop reaction from a non-owner is ignored", async () => {
		const { channel, handlers } = makeChannelWithMockBot({
			botToken: "t",
			ownerUserIds: ["111"],
			enableMessageReactions: true,
		});
		channel.onInterrupt = (t) => interrupts.push(t);
		registerInFlightMessage("telegram", 777, {
			channelId: "telegram",
			conversationId: "telegram:555",
		});

		try {
			const idx = findStopHandler(handlers);
			await handlers.reactions[idx].handler(
				makeReactionCtx({
					chatId: 555,
					messageId: 777,
					userId: 222,
					newReaction: [{ type: "emoji", emoji: "😡" }],
				}),
			);
			expect(interrupts).toHaveLength(0);
		} finally {
			unregisterInFlightMessage("telegram", 777);
		}
	});

	test("reaction removal (empty new_reaction) does not fire onInterrupt", async () => {
		const { channel, handlers } = makeChannelWithMockBot({
			botToken: "t",
			ownerUserIds: ["111"],
			enableMessageReactions: true,
		});
		channel.onInterrupt = (t) => interrupts.push(t);
		registerInFlightMessage("telegram", 777, {
			channelId: "telegram",
			conversationId: "telegram:555",
		});

		try {
			const idx = findStopHandler(handlers);
			await handlers.reactions[idx].handler(
				makeReactionCtx({ chatId: 555, messageId: 777, userId: 111, newReaction: [] }),
			);
			expect(interrupts).toHaveLength(0);
		} finally {
			unregisterInFlightMessage("telegram", 777);
		}
	});

	test("custom interruptReaction overrides the default stop emoji", async () => {
		const { channel, handlers } = makeChannelWithMockBot({
			botToken: "t",
			ownerUserIds: ["111"],
			enableMessageReactions: true,
			interruptReaction: "🫡",
		});
		channel.onInterrupt = (t) => interrupts.push(t);
		registerInFlightMessage("telegram", 777, {
			channelId: "telegram",
			conversationId: "telegram:555",
		});

		try {
			// Default 😡 no longer registered; 🫡 is
			expect(findStopHandler(handlers)).toBe(-1);
			const saluteIdx = handlers.reactions.findIndex((r) =>
				(Array.isArray(r.emoji) ? r.emoji : [r.emoji]).includes("🫡"),
			);
			expect(saluteIdx).toBeGreaterThanOrEqual(0);
			await handlers.reactions[saluteIdx].handler(
				makeReactionCtx({
					chatId: 555,
					messageId: 777,
					userId: 111,
					newReaction: [{ type: "emoji", emoji: "🫡" }],
				}),
			);
			expect(interrupts).toHaveLength(1);
		} finally {
			unregisterInFlightMessage("telegram", 777);
		}
	});

	test("no reaction handlers registered when enableMessageReactions is off", () => {
		const { handlers } = makeChannelWithMockBot({ botToken: "t", enableMessageReactions: false });
		expect(handlers.reactions).toHaveLength(0);
	});
});
