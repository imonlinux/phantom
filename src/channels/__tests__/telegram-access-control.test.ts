import { beforeEach, describe, expect, mock, test } from "bun:test";
import { type FeedbackSignal, setFeedbackHandler } from "../feedback.ts";
import { TelegramChannel, type TelegramChannelConfig } from "../telegram.ts";

function makeChannelWithMockBot(config: TelegramChannelConfig) {
	const channel = new TelegramChannel(config);

	const handlers = {
		commands: new Map<string, (ctx: any) => Promise<void>>(),
		text: null as ((ctx: any) => Promise<void>) | null,
		actions: [] as Array<{ pattern: RegExp; handler: (ctx: any) => Promise<void> }>,
		reactions: [] as Array<{ emoji: string | string[]; handler: (ctx: any) => Promise<void> }>,
	};

	const sentReplies: Array<{ chatId: number; text: string }> = [];

	const mockBot = {
		launch: mock(async () => {}),
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
			sendMessage: mock(async (chatId: number, text: string) => {
				sentReplies.push({ chatId, text });
				return { message_id: 1 };
			}),
			editMessageText: mock(async () => undefined),
			editMessageReplyMarkup: mock(async () => undefined),
			sendChatAction: mock(async () => undefined),
			setMessageReaction: mock(async () => undefined),
			getMe: mock(async () => ({ id: 999, is_bot: true, first_name: "Bot" })),
		},
	};

	(channel as unknown as { bot: unknown }).bot = mockBot;
	(channel as unknown as { registerHandlers: () => void }).registerHandlers();

	return { channel, mockBot, handlers, sentReplies };
}

function makeTextCtx(args: {
	chatId: number;
	chatType?: "private" | "group" | "supergroup" | "channel";
	userId: number;
	text: string;
	messageId?: number;
}): any {
	return {
		message: {
			text: args.text,
			from: { id: args.userId, first_name: "User" },
			chat: { id: args.chatId, type: args.chatType ?? "private" },
			message_id: args.messageId ?? 1,
		},
		from: { id: args.userId, first_name: "User" },
		chat: { id: args.chatId, type: args.chatType ?? "private" },
		reply: mock(async () => ({ message_id: 99 })),
	};
}

function makeActionCtx(args: {
	chatId: number;
	chatType?: "private" | "group" | "supergroup" | "channel";
	userId: number;
	callbackData: string;
	messageId?: number;
}): any {
	return {
		from: { id: args.userId },
		chat: { id: args.chatId, type: args.chatType ?? "private" },
		match: undefined,
		answerCbQuery: mock(async () => undefined),
		callbackQuery: {
			data: args.callbackData,
			message: { message_id: args.messageId ?? 1, chat: { id: args.chatId } },
		},
	};
}

function makeReactionCtx(args: { chatId: number; messageId: number; userId: number }): any {
	return {
		from: { id: args.userId },
		chat: { id: args.chatId, type: "supergroup" as const },
		update: {
			message_reaction: {
				chat: { id: args.chatId },
				message_id: args.messageId,
				user: { id: args.userId },
			},
		},
	};
}

describe("P3: empty owner_user_ids array (default) allows everyone", () => {
	test("text from any user is accepted when no owners configured", async () => {
		const { channel, handlers, sentReplies } = makeChannelWithMockBot({ botToken: "test" });
		let messageHandlerCalled = false;
		channel.onMessage(async () => {
			messageHandlerCalled = true;
		});

		await handlers.text?.(makeTextCtx({ chatId: 100, userId: 5, text: "hello" }));
		expect(messageHandlerCalled).toBe(true);
		expect(sentReplies.length).toBe(0);
	});

	test("explicit empty array means no access control", async () => {
		const { channel, handlers, sentReplies } = makeChannelWithMockBot({
			botToken: "test",
			ownerUserIds: [],
		});
		let messageHandlerCalled = false;
		channel.onMessage(async () => {
			messageHandlerCalled = true;
		});
		await handlers.text?.(makeTextCtx({ chatId: 100, userId: 5, text: "hi" }));
		expect(messageHandlerCalled).toBe(true);
		expect(sentReplies.length).toBe(0);
	});
});

describe("P3: DM access control", () => {
	test("owner can send messages in 1:1 DM", async () => {
		const { channel, handlers, sentReplies } = makeChannelWithMockBot({
			botToken: "test",
			ownerUserIds: ["8649220840"],
		});
		let messageHandlerCalled = false;
		channel.onMessage(async () => {
			messageHandlerCalled = true;
		});

		await handlers.text?.(makeTextCtx({ chatId: 100, userId: 8649220840, text: "hi", chatType: "private" }));

		expect(messageHandlerCalled).toBe(true);
		expect(sentReplies.length).toBe(0);
	});

	test("non-owner gets rejection reply on first DM", async () => {
		const { channel, handlers, sentReplies } = makeChannelWithMockBot({
			botToken: "test",
			ownerUserIds: ["8649220840"],
		});
		let messageHandlerCalled = false;
		channel.onMessage(async () => {
			messageHandlerCalled = true;
		});

		await handlers.text?.(makeTextCtx({ chatId: 555, userId: 555, text: "hi", chatType: "private" }));

		expect(messageHandlerCalled).toBe(false);
		expect(sentReplies.length).toBe(1);
		expect(sentReplies[0].chatId).toBe(555);
		expect(sentReplies[0].text).toMatch(/Phantom/i);
	});

	test("non-owner gets silent ignore on subsequent DMs (no spam)", async () => {
		const { channel, handlers, sentReplies } = makeChannelWithMockBot({
			botToken: "test",
			ownerUserIds: ["8649220840"],
		});
		let messageHandlerCalls = 0;
		channel.onMessage(async () => {
			messageHandlerCalls++;
		});

		await handlers.text?.(makeTextCtx({ chatId: 555, userId: 555, text: "hi", chatType: "private" }));
		expect(sentReplies.length).toBe(1);

		await handlers.text?.(makeTextCtx({ chatId: 555, userId: 555, text: "again", chatType: "private" }));
		await handlers.text?.(makeTextCtx({ chatId: 555, userId: 555, text: "still here", chatType: "private" }));

		expect(sentReplies.length).toBe(1);
		expect(messageHandlerCalls).toBe(0);
	});

	test("multiple owners (array) all get access", async () => {
		const { channel, handlers, sentReplies } = makeChannelWithMockBot({
			botToken: "test",
			ownerUserIds: ["8649220840", "9999999999"],
		});
		let calls = 0;
		channel.onMessage(async () => {
			calls++;
		});

		await handlers.text?.(makeTextCtx({ chatId: 100, userId: 8649220840, text: "hi", chatType: "private" }));
		await handlers.text?.(makeTextCtx({ chatId: 200, userId: 9999999999, text: "hi", chatType: "private" }));

		expect(calls).toBe(2);
		expect(sentReplies.length).toBe(0);
	});
});

describe("P3: group access control (silent ignore, no rejection)", () => {
	test("non-owner messages in groups are silently ignored, no rejection reply", async () => {
		const { channel, handlers, sentReplies } = makeChannelWithMockBot({
			botToken: "test",
			ownerUserIds: ["8649220840"],
		});
		let calls = 0;
		channel.onMessage(async () => {
			calls++;
		});

		await handlers.text?.(makeTextCtx({ chatId: -1001, userId: 555, text: "hi", chatType: "group" }));
		await handlers.text?.(makeTextCtx({ chatId: -1001, userId: 555, text: "again", chatType: "supergroup" }));

		expect(sentReplies.length).toBe(0);
		expect(calls).toBe(0);
	});

	test("owner messages in groups are accepted", async () => {
		const { channel, handlers, sentReplies } = makeChannelWithMockBot({
			botToken: "test",
			ownerUserIds: ["8649220840"],
		});
		let calls = 0;
		channel.onMessage(async () => {
			calls++;
		});

		await handlers.text?.(makeTextCtx({ chatId: -1001, userId: 8649220840, text: "hi", chatType: "group" }));
		expect(calls).toBe(1);
		expect(sentReplies.length).toBe(0);
	});
});

describe("P3: feedback button gating", () => {
	beforeEach(() => {
		setFeedbackHandler(((_s: FeedbackSignal) => {}) as (s: FeedbackSignal) => void);
	});

	test("non-owner feedback button click is silently dropped", async () => {
		const captured: FeedbackSignal[] = [];
		setFeedbackHandler((s: FeedbackSignal) => {
			captured.push(s);
		});

		const { handlers } = makeChannelWithMockBot({
			botToken: "test",
			ownerUserIds: ["8649220840"],
		});

		const feedbackAction = handlers.actions[0];
		await feedbackAction.handler(
			makeActionCtx({
				chatId: 555,
				userId: 555,
				callbackData: "phantom:feedback:positive",
				chatType: "private",
			}),
		);

		expect(captured.length).toBe(0);
	});

	test("owner feedback button click emits signal", async () => {
		const captured: FeedbackSignal[] = [];
		setFeedbackHandler((s: FeedbackSignal) => {
			captured.push(s);
		});

		const { handlers } = makeChannelWithMockBot({
			botToken: "test",
			ownerUserIds: ["8649220840"],
		});

		const feedbackAction = handlers.actions[0];
		await feedbackAction.handler(
			makeActionCtx({
				chatId: 100,
				userId: 8649220840,
				callbackData: "phantom:feedback:positive",
				chatType: "private",
			}),
		);

		expect(captured.length).toBe(1);
		expect(captured[0].type).toBe("positive");
	});
});

describe("P3: reaction-as-feedback gating (when enabled)", () => {
	beforeEach(() => {
		setFeedbackHandler(((_s: FeedbackSignal) => {}) as (s: FeedbackSignal) => void);
	});

	test("non-owner reaction is silently dropped", async () => {
		const captured: FeedbackSignal[] = [];
		setFeedbackHandler((s: FeedbackSignal) => {
			captured.push(s);
		});

		const { handlers } = makeChannelWithMockBot({
			botToken: "test",
			ownerUserIds: ["8649220840"],
			enableMessageReactions: true,
		});

		const positive = handlers.reactions.find((r) => Array.isArray(r.emoji) && r.emoji.includes("👍"));
		await positive?.handler(makeReactionCtx({ chatId: -1001, messageId: 42, userId: 555 }));

		expect(captured.length).toBe(0);
	});

	test("owner reaction emits signal", async () => {
		const captured: FeedbackSignal[] = [];
		setFeedbackHandler((s: FeedbackSignal) => {
			captured.push(s);
		});

		const { handlers } = makeChannelWithMockBot({
			botToken: "test",
			ownerUserIds: ["8649220840"],
			enableMessageReactions: true,
		});

		const positive = handlers.reactions.find((r) => Array.isArray(r.emoji) && r.emoji.includes("👍"));
		await positive?.handler(makeReactionCtx({ chatId: -1001, messageId: 42, userId: 8649220840 }));

		expect(captured.length).toBe(1);
		expect(captured[0].userId).toBe("8649220840");
	});
});

describe("P3: rejection reply content", () => {
	test("rejection text is informative and points to the project", async () => {
		const { channel, handlers, sentReplies } = makeChannelWithMockBot({
			botToken: "test",
			ownerUserIds: ["8649220840"],
		});
		channel.onMessage(async () => {});

		await handlers.text?.(makeTextCtx({ chatId: 555, userId: 555, text: "hi", chatType: "private" }));

		const rejection = sentReplies[0];
		expect(rejection.text).toMatch(/Phantom/);
		expect(rejection.text).toMatch(/owner/i);
		expect(rejection.text.length).toBeGreaterThan(20);
		expect(rejection.text.length).toBeLessThan(400);
	});
});

describe("P3: edge cases", () => {
	test("ownerUserIds undefined (not set) is equivalent to empty array (allow all)", async () => {
		const { channel, handlers, sentReplies } = makeChannelWithMockBot({ botToken: "test" });
		let called = false;
		channel.onMessage(async () => {
			called = true;
		});

		await handlers.text?.(makeTextCtx({ chatId: 100, userId: 5, text: "hi", chatType: "private" }));
		expect(called).toBe(true);
		expect(sentReplies.length).toBe(0);
	});

	test("missing ctx.chat.type treated as DM (rejection sent)", async () => {
		const { channel, handlers, sentReplies } = makeChannelWithMockBot({
			botToken: "test",
			ownerUserIds: ["8649220840"],
		});
		channel.onMessage(async () => {});

		const ctx = makeTextCtx({ chatId: 555, userId: 555, text: "hi", chatType: "private" });
		ctx.message.chat = { id: 555 };
		ctx.chat = { id: 555 };

		await handlers.text?.(ctx);
		expect(sentReplies.length).toBe(1);
	});
});

describe("P5.5: Security hardening", () => {
	test("uses custom rejection reply when configured", async () => {
		const customReply = "This is a private bot. Contact admin@example.com for access.";
		const { channel, handlers, sentReplies } = makeChannelWithMockBot({
			botToken: "test",
			ownerUserIds: ["8649220840"],
			rejectionReply: customReply,
		});
		channel.onMessage(async () => {});

		const ctx = makeTextCtx({ chatId: 555, userId: 555, text: "hi", chatType: "private" });
		await handlers.text?.(ctx);

		expect(sentReplies.length).toBe(1);
		expect(sentReplies[0].text).toBe(customReply);
	});

	test("uses default rejection reply when custom reply not configured", async () => {
		const { channel, handlers, sentReplies } = makeChannelWithMockBot({
			botToken: "test",
			ownerUserIds: ["8649220840"],
		});
		channel.onMessage(async () => {});

		const ctx = makeTextCtx({ chatId: 555, userId: 555, text: "hi", chatType: "private" });
		await handlers.text?.(ctx);

		expect(sentReplies.length).toBe(1);
		expect(sentReplies[0].text).toContain("Phantom");
		expect(sentReplies[0].text).toContain("github.com/ghostwright/phantom");
	});
});

describe("P6: Proactive intro", () => {
	test("sends intro message on first connect when owner_chat_id is configured", async () => {
		const { Database } = require("bun:sqlite");
		const { runMigrations } = require("../../db/migrate.ts");
		const db = new Database(":memory:");
		runMigrations(db);

		let introMessage: string | null = null;
		let introChatId: number | null = null;

		const mockBot = {
			telegram: {
				getMe: async () => ({ id: 123, username: "testbot" }),
				sendMessage: async (chatId: number, text: string) => {
					introMessage = text;
					introChatId = chatId;
					return { message_id: 1 };
				},
			},
		};

		const channel = new TelegramChannel({
			botToken: "test-token",
			ownerChatId: "123456789", // Owner's chat ID
		});

		// Inject mock bot and database
		(channel as unknown as { bot: typeof mockBot }).bot = mockBot as unknown;
		(channel as unknown as { db: Database }).db = db;

		// Test sendProactiveIntroIfFirstRun directly
		await channel["sendProactiveIntroIfFirstRun"]();

		// Verify intro was sent
		expect(introMessage).toContain("Phantom");
		expect(introMessage).toContain("/help");
		expect(introChatId).toBe(123456789);

		// Verify database record was created
		const row = db
			.query("SELECT * FROM channel_intros WHERE channel_id = 'telegram'")
			.get() as { channel_id: string; sent_to_chat_id: string } | undefined;
		expect(row).toBeDefined();
		expect(row?.channel_id).toBe("telegram");
		expect(row?.sent_to_chat_id).toBe("123456789");

		db.close();
	});

	test("does not send intro on subsequent connects", async () => {
		const { Database } = require("bun:sqlite");
		const { runMigrations } = require("../../db/migrate.ts");
		const db = new Database(":memory:");
		runMigrations(db);

		// Simulate previous intro by inserting a record
		db.run(
			"INSERT INTO channel_intros (channel_id, intro_sent_at, sent_to_chat_id) VALUES (?, datetime('now'), ?)",
			["telegram", "123456789"],
		);

		let introSent = false;

		const mockBot = {
			telegram: {
				getMe: async () => ({ id: 123, username: "testbot" }),
				sendMessage: async (_chatId: number, _text: string) => {
					introSent = true;
					return { message_id: 1 };
				},
			},
		};

		const channel = new TelegramChannel({
			botToken: "test-token",
			ownerChatId: "123456789",
		});

		// Inject mock bot and database
		(channel as unknown as { bot: typeof mockBot }).bot = mockBot as unknown;
		(channel as unknown as { db: Database }).db = db;

		// Test sendProactiveIntroIfFirstRun directly
		await channel["sendProactiveIntroIfFirstRun"]();

		// Verify intro was NOT sent
		expect(introSent).toBe(false);

		db.close();
	});

	test("does not send intro when owner_chat_id is not configured", async () => {
		const { Database } = require("bun:sqlite");
		const { runMigrations } = require("../../db/migrate.ts");
		const db = new Database(":memory:");
		runMigrations(db);

		let introSent = false;

		const mockBot = {
			telegram: {
				getMe: async () => ({ id: 123, username: "testbot" }),
				sendMessage: async (_chatId: number, _text: string) => {
					introSent = true;
					return { message_id: 1 };
				},
			},
		};

		const channel = new TelegramChannel({
			botToken: "test-token",
			// No ownerChatId configured
		});

		// Inject mock bot and database
		(channel as unknown as { bot: typeof mockBot }).bot = mockBot as unknown;
		(channel as unknown as { db: Database }).db = db;

		// Test sendProactiveIntroIfFirstRun directly
		await channel["sendProactiveIntroIfFirstRun"]();

		// Verify intro was NOT sent
		expect(introSent).toBe(false);

		db.close();
	});

	test("gracefully handles intro send failures", async () => {
		const { Database } = require("bun:sqlite");
		const { runMigrations } = require("../../db/migrate.ts");
		const db = new Database(":memory:");
		runMigrations(db);

		const mockBot = {
			telegram: {
				getMe: async () => ({ id: 123, username: "testbot" }),
				sendMessage: async (_chatId: number, _text: string) => {
					throw new Error("Network error");
				},
			},
		};

		const channel = new TelegramChannel({
			botToken: "test-token",
			ownerChatId: "123456789",
		});

		// Inject mock bot and database
		(channel as unknown as { bot: typeof mockBot }).bot = mockBot as unknown;
		(channel as unknown as { db: Database }).db = db;

		// Test the sendProactiveIntroIfFirstRun method directly
		// Call it and verify it doesn't throw - errors are caught and logged
		try {
			await channel["sendProactiveIntroIfFirstRun"]();
			// If we get here, no exception was thrown (expected)
			expect(true).toBe(true);
		} catch (err) {
			// If an exception was thrown, the test fails
			expect.fail(`sendProactiveIntroIfFirstRun should not throw, but threw: ${err}`);
		}

		db.close();
	});
});
