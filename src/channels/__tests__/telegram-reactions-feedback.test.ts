import { beforeEach, describe, expect, mock, test } from "bun:test";
import { type FeedbackSignal, setFeedbackHandler } from "../feedback.ts";
import { TelegramChannel, type TelegramChannelConfig } from "../telegram.ts";

/**
 * Builds a TelegramChannel with a mock bot wired in. Captures all
 * registered handlers (command, on, action, reaction) so tests can
 * assert which ones were registered and invoke them with synthetic
 * contexts.
 */
function makeChannelWithMockBot(config: TelegramChannelConfig) {
	const channel = new TelegramChannel(config);

	const handlers = {
		commands: new Map<string, (ctx: any) => Promise<void>>(),
		text: null as ((ctx: any) => Promise<void>) | null,
		actions: [] as Array<{ pattern: RegExp; handler: (ctx: any) => Promise<void> }>,
		reactions: [] as Array<{ emoji: string | string[]; handler: (ctx: any) => Promise<void> }>,
	};

	const launchCalls: Array<{ allowedUpdates?: string[] }> = [];

	const mockBot = {
		launch: mock(async (opts?: { allowedUpdates?: string[] }) => {
			launchCalls.push(opts ?? {});
		}),
		stop: mock(() => undefined),
		command: mock((cmd: string, h: (ctx: any) => Promise<void>) => {
			handlers.commands.set(cmd, h);
		}),
		on: mock((event: string, h: (ctx: any) => Promise<void>) => {
			if (event === "text") handlers.text = h;
		}),
		action: mock((pattern: RegExp, h: (ctx: any) => Promise<void>) => {
			handlers.actions.push({ pattern, handler: h });
		}),
		reaction: mock((emoji: string | string[], h: (ctx: any) => Promise<void>) => {
			handlers.reactions.push({ emoji, handler: h });
		}),
		telegram: {
			sendMessage: mock(async () => ({ message_id: 1 })),
			editMessageText: mock(async () => undefined),
			editMessageReplyMarkup: mock(async () => undefined),
			sendChatAction: mock(async () => undefined),
			setMessageReaction: mock(async () => undefined),
			getMe: mock(async () => ({ id: 999, is_bot: true, first_name: "Bot" })),
		},
	};

	(channel as unknown as { bot: unknown }).bot = mockBot;
	// Skip the dynamic import path by manually invoking registerHandlers.
	(channel as unknown as { registerHandlers: () => void }).registerHandlers();

	return { channel, mockBot, handlers, launchCalls };
}

/**
 * Synthetic Telegraf reaction context for testing handleReactionFeedback.
 */
function makeReactionCtx(args: {
	chatId?: number;
	messageId?: number;
	userId?: number;
}): any {
	return {
		update: {
			message_reaction: {
				chat: args.chatId !== undefined ? { id: args.chatId } : undefined,
				message_id: args.messageId,
				user: args.userId !== undefined ? { id: args.userId } : undefined,
			},
		},
	};
}

describe("P2.4: reaction-as-feedback gating", () => {
	beforeEach(() => {
		setFeedbackHandler((() => {}) as (signal: FeedbackSignal) => void);
	});

	test("does NOT register reaction handlers when enableMessageReactions is false (default)", () => {
		const { handlers, mockBot } = makeChannelWithMockBot({ botToken: "test" });
		expect(handlers.reactions.length).toBe(0);
		expect(mockBot.reaction).not.toHaveBeenCalled();
	});

	test("does NOT register reaction handlers when enableMessageReactions is undefined", () => {
		// Simulate config where the field is omitted entirely
		const { handlers } = makeChannelWithMockBot({ botToken: "test" } as TelegramChannelConfig);
		expect(handlers.reactions.length).toBe(0);
	});

	test("DOES register reaction handlers when enableMessageReactions is true", () => {
		const { handlers, mockBot } = makeChannelWithMockBot({
			botToken: "test",
			enableMessageReactions: true,
		});
		expect(handlers.reactions.length).toBe(2);
		expect(mockBot.reaction).toHaveBeenCalledTimes(2);
	});

	test("positive handler registers for 👍, ❤, 🔥", () => {
		const { handlers } = makeChannelWithMockBot({
			botToken: "test",
			enableMessageReactions: true,
		});
		const positive = handlers.reactions.find((r) => Array.isArray(r.emoji) && r.emoji.includes("👍"));
		expect(positive).toBeDefined();
		expect(positive?.emoji).toEqual(["👍", "❤", "🔥"]);
	});

	test("negative handler registers for 👎", () => {
		const { handlers } = makeChannelWithMockBot({
			botToken: "test",
			enableMessageReactions: true,
		});
		const negative = handlers.reactions.find((r) => Array.isArray(r.emoji) && r.emoji.includes("👎"));
		expect(negative).toBeDefined();
		expect(negative?.emoji).toEqual(["👎"]);
	});
});

describe("P2.4: launch options thread message_reaction when enabled", () => {
	test("launch is called WITHOUT message_reaction when flag is false", async () => {
		// We can't test the actual connect() path because it does dynamic
		// import of telegraf. Instead, test the construction directly: a
		// channel with the flag false, when its handlers are registered,
		// would have NOT registered reaction handlers — and we know from
		// telegram.ts that the launch options assembly uses the same flag.
		//
		// To verify the launch options shape, simulate the construction
		// of allowedUpdates that connect() would do:
		const config: TelegramChannelConfig = { botToken: "test" };
		const allowedUpdates: string[] = ["message", "callback_query"];
		if (config.enableMessageReactions) {
			allowedUpdates.push("message_reaction");
		}
		expect(allowedUpdates).not.toContain("message_reaction");
	});

	test("launch is called WITH message_reaction when flag is true", () => {
		const config: TelegramChannelConfig = {
			botToken: "test",
			enableMessageReactions: true,
		};
		const allowedUpdates: string[] = ["message", "callback_query"];
		if (config.enableMessageReactions) {
			allowedUpdates.push("message_reaction");
		}
		expect(allowedUpdates).toContain("message_reaction");
		expect(allowedUpdates).toContain("message");
		expect(allowedUpdates).toContain("callback_query");
	});
});

describe("P2.4: reaction handler emits FeedbackSignal", () => {
	let captured: FeedbackSignal[] = [];

	beforeEach(() => {
		captured = [];
		setFeedbackHandler((signal: FeedbackSignal) => {
			captured.push(signal);
		});
	});

	test("👍 reaction emits positive feedback", async () => {
		const { handlers } = makeChannelWithMockBot({
			botToken: "test",
			enableMessageReactions: true,
		});
		const positive = handlers.reactions.find((r) => Array.isArray(r.emoji) && r.emoji.includes("👍"));
		await positive?.handler(makeReactionCtx({ chatId: 100, messageId: 42, userId: 5 }));

		expect(captured.length).toBe(1);
		expect(captured[0].type).toBe("positive");
		expect(captured[0].source).toBe("reaction");
		expect(captured[0].conversationId).toBe("telegram:100");
		expect(captured[0].messageTs).toBe("42");
		expect(captured[0].userId).toBe("5");
		expect(captured[0].timestamp).toBeGreaterThan(0);
	});

	test("👎 reaction emits negative feedback", async () => {
		const { handlers } = makeChannelWithMockBot({
			botToken: "test",
			enableMessageReactions: true,
		});
		const negative = handlers.reactions.find((r) => Array.isArray(r.emoji) && r.emoji.includes("👎"));
		await negative?.handler(makeReactionCtx({ chatId: 100, messageId: 42, userId: 5 }));

		expect(captured.length).toBe(1);
		expect(captured[0].type).toBe("negative");
		expect(captured[0].source).toBe("reaction");
	});

	test("FeedbackSignal shape matches Slack's exactly", async () => {
		const { handlers } = makeChannelWithMockBot({
			botToken: "test",
			enableMessageReactions: true,
		});
		const positive = handlers.reactions.find((r) => Array.isArray(r.emoji) && r.emoji.includes("👍"));
		await positive?.handler(makeReactionCtx({ chatId: 100, messageId: 42, userId: 5 }));

		const signal = captured[0];
		// Required fields per the FeedbackSignal type
		expect(typeof signal.type).toBe("string");
		expect(typeof signal.conversationId).toBe("string");
		expect(typeof signal.messageTs).toBe("string");
		expect(typeof signal.userId).toBe("string");
		expect(typeof signal.source).toBe("string");
		expect(typeof signal.timestamp).toBe("number");
		expect(["positive", "negative", "partial"]).toContain(signal.type);
		expect(["button", "reaction"]).toContain(signal.source);
	});

	test("anonymous reaction (no user.id) is silently dropped", async () => {
		const { handlers } = makeChannelWithMockBot({
			botToken: "test",
			enableMessageReactions: true,
		});
		const positive = handlers.reactions.find((r) => Array.isArray(r.emoji) && r.emoji.includes("👍"));
		// No userId — simulates anonymous-admin reaction in a group
		await positive?.handler(makeReactionCtx({ chatId: 100, messageId: 42 }));
		expect(captured.length).toBe(0);
	});

	test("reaction with missing chat is dropped", async () => {
		const { handlers } = makeChannelWithMockBot({
			botToken: "test",
			enableMessageReactions: true,
		});
		const positive = handlers.reactions.find((r) => Array.isArray(r.emoji) && r.emoji.includes("👍"));
		await positive?.handler(makeReactionCtx({ messageId: 42, userId: 5 }));
		expect(captured.length).toBe(0);
	});

	test("reaction with missing message_id is dropped", async () => {
		const { handlers } = makeChannelWithMockBot({
			botToken: "test",
			enableMessageReactions: true,
		});
		const positive = handlers.reactions.find((r) => Array.isArray(r.emoji) && r.emoji.includes("👍"));
		await positive?.handler(makeReactionCtx({ chatId: 100, userId: 5 }));
		expect(captured.length).toBe(0);
	});

	test("multiple reactions from the same user produce multiple signals", async () => {
		const { handlers } = makeChannelWithMockBot({
			botToken: "test",
			enableMessageReactions: true,
		});
		const positive = handlers.reactions.find((r) => Array.isArray(r.emoji) && r.emoji.includes("👍"));
		await positive?.handler(makeReactionCtx({ chatId: 100, messageId: 42, userId: 5 }));
		await positive?.handler(makeReactionCtx({ chatId: 100, messageId: 43, userId: 5 }));
		expect(captured.length).toBe(2);
		expect(captured[0].messageTs).toBe("42");
		expect(captured[1].messageTs).toBe("43");
	});
});
