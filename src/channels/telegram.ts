/**
 * Telegram channel using Telegraf (long polling).
 * Supports inline keyboards, persistent typing, message editing,
 * MarkdownV2 formatting, and command handling.
 *
 * Phase 2 of the Telegram parity plan:
 * - P2.1 (this file): adds setReaction (Bot API 7.0+ setMessageReaction)
 *   with a per-chat circuit breaker that disables reactions for the rest
 *   of the session after a 400 REACTION_INVALID. Falls through to
 *   typing-only signaling per the parity plan.
 */

import type { Channel, ChannelCapabilities, InboundMessage, OutboundMessage, SentMessage } from "./types.ts";

type TelegrafBot = {
	launch: () => Promise<void>;
	stop: () => void;
	command: (cmd: string, handler: (ctx: TelegrafContext) => Promise<void>) => void;
	on: (event: string, handler: (ctx: TelegrafContext) => Promise<void>) => void;
	action: (pattern: RegExp, handler: (ctx: TelegrafContext) => Promise<void>) => void;
	telegram: TelegramApi;
};

type TelegramApi = {
	sendMessage: (
		chatId: number | string,
		text: string,
		options?: Record<string, unknown>,
	) => Promise<{ message_id: number }>;
	editMessageText: (
		chatId: number | string,
		messageId: number,
		inlineMessageId: string | undefined,
		text: string,
		options?: Record<string, unknown>,
	) => Promise<unknown>;
	editMessageReplyMarkup: (
		chatId: number | string,
		messageId: number,
		inlineMessageId: string | undefined,
		replyMarkup: Record<string, unknown> | undefined,
	) => Promise<unknown>;
	sendChatAction: (chatId: number | string, action: string) => Promise<void>;
	setMessageReaction: (
		chatId: number | string,
		messageId: number,
		reaction: Array<{ type: "emoji"; emoji: string }>,
		isBig?: boolean,
	) => Promise<unknown>;
};

type TelegrafContext = {
	message?: {
		text?: string;
		from?: { id: number; first_name?: string; username?: string };
		chat: { id: number };
		message_id: number;
	};
	reply: (text: string, options?: Record<string, unknown>) => Promise<{ message_id: number }>;
	telegram: TelegramApi;
	chat?: { id: number };
	from?: { id: number; first_name?: string; username?: string };
	match?: RegExpMatchArray;
	answerCbQuery?: (text?: string) => Promise<void>;
	callbackQuery?: { data?: string; message?: { message_id: number; chat: { id: number } } };
};

export type TelegramChannelConfig = {
	botToken: string;
};

type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

export class TelegramChannel implements Channel {
	readonly id = "telegram";
	readonly name = "Telegram";
	readonly capabilities: ChannelCapabilities = {
		threads: false,
		richText: true,
		attachments: true,
		buttons: true,
		inlineKeyboards: true,
		typing: true,
		messageEditing: true,
		// P2.1: declare reaction support. The capability is best-effort; the
		// per-chat circuit breaker may disable it at runtime.
		reactions: true,
	};

	private bot: TelegrafBot | null = null;
	private messageHandler: ((message: InboundMessage) => Promise<void>) | null = null;
	private connectionState: ConnectionState = "disconnected";
	private config: TelegramChannelConfig;
	private typingTimers = new Map<number, ReturnType<typeof setInterval>>();

	// P2.1: Per-chat circuit breaker. When setMessageReaction returns 400
	// REACTION_INVALID for a chat, that chat is added here and subsequent
	// reaction calls become no-ops for the rest of the session. Logged once.
	private reactionDisabledChats = new Set<number>();

	// Connection supervision (interim fix; Phase 8 webhook mode is the real
	// solution). Long-polling can silently drop without Telegraf surfacing the
	// failure to the orchestration. We periodically ping getMe to detect dead
	// connections and reconnect with exponential backoff.
	private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
	private isReconnecting = false;
	private shutdownRequested = false;
	private reconnectAttempts = 0;

	private static readonly HEALTHCHECK_INTERVAL_MS = 60_000;
	private static readonly RECONNECT_BACKOFF_BASE_MS = 1_000;
	private static readonly RECONNECT_BACKOFF_CAP_MS = 60_000;
	// Maximum wait for bot.stop() to resolve cleanly before forcing teardown.
	// Docker's default SIGTERM grace is 10s, so we need to come in well under.
	private static readonly STOP_TIMEOUT_MS = 5_000;
	// Brief delay between bot.stop() and the next bot.launch() to let
	// Telegram release the long-poll slot server-side.
	private static readonly RECONNECT_STOP_DELAY_MS = 1_000;

	constructor(config: TelegramChannelConfig) {
		this.config = config;
	}

	async connect(): Promise<void> {
		if (this.connectionState === "connected") return;

		// Try the initial connect. If it fails (typically because a previous
		// process didn't release the long-poll slot — common when Docker
		// SIGKILLs during shutdown), don't throw: schedule a supervised
		// reconnect and let the rest of the app come up. Slack and other
		// channels can still work while Telegram retries in the background.
		const launched = await this.tryLaunch();
		if (!launched) {
			console.warn(
				"[telegram] Initial connect failed; scheduling background reconnect. " +
					"Other channels will continue normally.",
			);
			// Schedule the first reconnect attempt without blocking startup.
			void this.reconnect();
		}
	}

	async disconnect(): Promise<void> {
		if (this.connectionState === "disconnected") return;
		this.shutdownRequested = true;
		this.stopHealthCheck();

		for (const timer of this.typingTimers.values()) {
			clearInterval(timer);
		}
		this.typingTimers.clear();

		// Race bot.stop() against a hard timeout. Telegraf's stop() waits
		// for in-flight polls to complete, which can exceed Docker's
		// SIGTERM-to-SIGKILL window. If we time out, the slot stays held
		// server-side until Telegram's connection timeout (~90s) — but
		// at least we exit cleanly so the rest of shutdown continues.
		await this.stopBotWithTimeout();

		this.connectionState = "disconnected";
		console.log("[telegram] Disconnected");
	}

	/**
	 * Attempt a single bot.launch(). On success, transitions to connected
	 * and starts the healthcheck. On failure, leaves state as "error" and
	 * returns false so the caller can decide to retry. Never throws.
	 */
	private async tryLaunch(): Promise<boolean> {
		this.connectionState = "connecting";
		try {
			const { Telegraf } = await import("telegraf");
			this.bot = new Telegraf(this.config.botToken) as unknown as TelegrafBot;
			this.registerHandlers();
			await this.bot.launch();
			this.connectionState = "connected";
			this.reconnectAttempts = 0;
			this.startHealthCheck();
			console.log("[telegram] Bot connected via long polling");
			return true;
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`[telegram] Failed to connect: ${msg}`);
			this.connectionState = "error";
			this.bot = null;
			return false;
		}
	}

	/**
	 * Stop the bot with a hard timeout. Returns when stop completes or the
	 * timeout elapses, whichever comes first. Never throws.
	 */
	private async stopBotWithTimeout(): Promise<void> {
		if (!this.bot) return;
		const bot = this.bot;

		// Telegraf's bot.stop() is synchronous in signature but kicks off
		// async cleanup internally. We wrap it in a Promise we can race.
		const stopPromise = new Promise<void>((resolve) => {
			try {
				bot.stop();
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				console.warn(`[telegram] Error during stop: ${msg}`);
			}
			// Give Telegraf a moment to wind down its poll loop. We don't
			// have a Promise to await on bot.stop() in older Telegraf
			// versions, so this short tick is the best we can do.
			setTimeout(resolve, 100);
		});

		const timeoutPromise = new Promise<void>((resolve) => {
			setTimeout(() => {
				console.warn(
					`[telegram] bot.stop() timed out after ${TelegramChannel.STOP_TIMEOUT_MS}ms; ` +
						"polling slot may take ~90s to release server-side",
				);
				resolve();
			}, TelegramChannel.STOP_TIMEOUT_MS);
		});

		await Promise.race([stopPromise, timeoutPromise]);
	}

	async send(conversationId: string, message: OutboundMessage): Promise<SentMessage> {
		if (!this.bot) throw new Error("Telegram bot not connected");

		const chatId = parseTelegramConversationId(conversationId);
		const text = escapeMarkdownV2(message.text);

		const result = await this.bot.telegram.sendMessage(chatId, text, {
			parse_mode: "MarkdownV2",
		});

		return {
			id: String(result.message_id),
			channelId: this.id,
			conversationId,
			timestamp: new Date(),
		};
	}

	onMessage(handler: (message: InboundMessage) => Promise<void>): void {
		this.messageHandler = handler;
	}

	isConnected(): boolean {
		return this.connectionState === "connected";
	}

	getConnectionState(): ConnectionState {
		return this.connectionState;
	}

	startTyping(chatId: number): void {
		this.stopTyping(chatId);
		void this.bot?.telegram.sendChatAction(chatId, "typing").catch(() => {});
		const timer = setInterval(() => {
			void this.bot?.telegram.sendChatAction(chatId, "typing").catch(() => {});
		}, 4000);
		this.typingTimers.set(chatId, timer);
	}

	stopTyping(chatId: number): void {
		const timer = this.typingTimers.get(chatId);
		if (timer) {
			clearInterval(timer);
			this.typingTimers.delete(chatId);
		}
	}

	async sendWithKeyboard(
		chatId: number,
		text: string,
		buttons: Array<Array<{ text: string; callback_data: string }>>,
	): Promise<number> {
		if (!this.bot) throw new Error("Telegram bot not connected");
		const result = await this.bot.telegram.sendMessage(chatId, escapeMarkdownV2(text), {
			parse_mode: "MarkdownV2",
			reply_markup: { inline_keyboard: buttons },
		});
		return result.message_id;
	}

	async editMessage(chatId: number, messageId: number, text: string): Promise<void> {
		if (!this.bot) return;
		try {
			await this.bot.telegram.editMessageText(chatId, messageId, undefined, escapeMarkdownV2(text), {
				parse_mode: "MarkdownV2",
			});
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			if (!msg.includes("message is not modified")) {
				console.warn(`[telegram] Failed to edit message: ${msg}`);
			}
		}
	}

	/**
	 * P2.1: Set or clear a reaction on a message.
	 *
	 * Bot API 7.0+ (setMessageReaction) replaces the bot's prior reaction;
	 * bots are limited to one reaction per message. Pass an empty emoji
	 * string to clear.
	 *
	 * Per-chat circuit breaker: if the API rejects with 400 REACTION_INVALID
	 * (the configured emoji isn't on the chat's allowlist, or the chat
	 * forbids reactions), this chat is marked no-reactions for the rest of
	 * the session. Logged once.
	 *
	 * Best-effort: never throws into the caller. Returns false if the call
	 * was skipped (no bot, circuit-broken chat) or failed.
	 */
	async setReaction(chatId: number, messageId: number, emoji: string): Promise<boolean> {
		if (!this.bot) return false;
		if (this.reactionDisabledChats.has(chatId)) return false;

		const reaction = emoji ? [{ type: "emoji" as const, emoji }] : [];
		try {
			await this.bot.telegram.setMessageReaction(chatId, messageId, reaction);
			return true;
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			// 400 REACTION_INVALID: the emoji isn't accepted in this chat.
			// Mark the chat as no-reactions for the session and degrade to
			// typing-only signaling.
			if (msg.includes("REACTION_INVALID") || msg.includes("400")) {
				if (!this.reactionDisabledChats.has(chatId)) {
					this.reactionDisabledChats.add(chatId);
					console.warn(
						`[telegram] Reactions disabled for chat ${chatId} (REACTION_INVALID); falling back to typing-only`,
					);
				}
				return false;
			}
			// Other errors (429 flood, network) are warned but don't trip the
			// breaker — they're transient.
			console.warn(`[telegram] setMessageReaction failed for chat ${chatId}: ${msg}`);
			return false;
		}
	}

	/** Test seam: inspect circuit-breaker state. */
	isReactionDisabledFor(chatId: number): boolean {
		return this.reactionDisabledChats.has(chatId);
	}

	private registerHandlers(): void {
		if (!this.bot) return;

		this.bot.command("start", async (ctx) => {
			await ctx.reply("Hello! I'm Phantom, your AI co-worker. Send me a message to get started.");
		});

		this.bot.command("status", async (ctx) => {
			await ctx.reply("Phantom is running and ready to help.");
		});

		this.bot.command("help", async (ctx) => {
			await ctx.reply(
				"Send me any message and I'll help you out.\n\nCommands:\n/start - Introduction\n/status - Check status\n/help - Show this message",
			);
		});

		this.bot.on("text", async (ctx) => {
			if (!this.messageHandler || !ctx.message?.text) return;

			const text = ctx.message.text;
			if (text.startsWith("/")) return;

			const chatId = ctx.message.chat.id;
			const from = ctx.message.from;
			const conversationId = `telegram:${chatId}`;

			const inbound: InboundMessage = {
				id: String(ctx.message.message_id),
				channelId: this.id,
				conversationId,
				senderId: String(from?.id ?? "unknown"),
				senderName: from?.first_name ?? from?.username,
				text,
				timestamp: new Date(),
				metadata: {
					telegramChatId: chatId,
					telegramMessageId: ctx.message.message_id,
				},
			};

			try {
				await this.messageHandler(inbound);
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				console.error(`[telegram] Error handling message: ${msg}`);
			}
		});

		this.bot.action(/^phantom:(.+)$/, async (ctx) => {
			if (ctx.answerCbQuery) {
				await ctx.answerCbQuery();
			}

			const data = ctx.match?.[1];
			if (!data || !this.messageHandler) return;

			const chatId = ctx.callbackQuery?.message?.chat.id;
			if (!chatId) return;

			const from = ctx.from;
			const conversationId = `telegram:${chatId}`;

			const inbound: InboundMessage = {
				id: `cb_${Date.now()}`,
				channelId: this.id,
				conversationId,
				senderId: String(from?.id ?? "unknown"),
				senderName: from?.first_name ?? from?.username,
				text: data,
				timestamp: new Date(),
				metadata: {
					telegramChatId: chatId,
					source: "callback_query",
					callbackData: data,
				},
			};

			try {
				await this.messageHandler(inbound);
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				console.error(`[telegram] Error handling callback: ${msg}`);
			}
		});
	}

	/**
	 * Start the periodic healthcheck. Calls getMe (the cheapest Bot API
	 * call) every HEALTHCHECK_INTERVAL_MS; on failure, triggers a
	 * supervised reconnect with exponential backoff.
	 *
	 * Safe to call repeatedly — clears any existing timer first.
	 */
	private startHealthCheck(): void {
		this.stopHealthCheck();
		this.healthCheckTimer = setInterval(() => {
			void this.runHealthCheck();
		}, TelegramChannel.HEALTHCHECK_INTERVAL_MS);
	}

	private stopHealthCheck(): void {
		if (this.healthCheckTimer) {
			clearInterval(this.healthCheckTimer);
			this.healthCheckTimer = null;
		}
	}

	private async runHealthCheck(): Promise<void> {
		// Skip if we're already trying to recover or shutting down.
		if (this.isReconnecting || this.shutdownRequested) return;
		if (this.connectionState !== "connected" || !this.bot) return;

		try {
			// getMe is a no-op identity ping — no payload, no chat, no rate
			// implications. If it fails, the polling connection is dead.
			await this.bot.telegram.getMe();
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`[telegram] Healthcheck failed: ${msg}; attempting reconnect`);
			void this.reconnect();
		}
	}

	/**
	 * Supervised reconnect with exponential backoff. Stops the existing bot
	 * (releasing the long-poll slot server-side), waits briefly, then
	 * launches a new instance. On failure, schedules the next attempt with
	 * doubled backoff up to RECONNECT_BACKOFF_CAP_MS.
	 *
	 * Idempotent — only one reconnect runs at a time.
	 */
	private async reconnect(): Promise<void> {
		if (this.isReconnecting || this.shutdownRequested) return;
		this.isReconnecting = true;
		this.stopHealthCheck();

		try {
			// Tear down the dead bot. Use the timeout version to avoid
			// hanging shutdown if the poll loop is wedged.
			await this.stopBotWithTimeout();
			this.bot = null;
			this.connectionState = "disconnected";

			// Brief delay so Telegram's server-side polling slot releases
			// before we try to claim it again.
			await new Promise((resolve) => setTimeout(resolve, TelegramChannel.RECONNECT_STOP_DELAY_MS));

			if (this.shutdownRequested) return;

			// Try to launch. If it fails, the error handler will schedule
			// the next reconnect attempt with exponential backoff.
			const launched = await this.tryLaunch();
			if (launched) {
				console.log("[telegram] Reconnected successfully");
			} else {
				// tryLaunch already set state to "error", so we just need to
				// schedule the next reconnect.
				throw new Error("tryLaunch failed");
			}
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			this.reconnectAttempts++;
			const backoffMs = Math.min(
				TelegramChannel.RECONNECT_BACKOFF_BASE_MS * 2 ** (this.reconnectAttempts - 1),
				TelegramChannel.RECONNECT_BACKOFF_CAP_MS,
			);
			console.warn(
				`[telegram] Reconnect attempt ${this.reconnectAttempts} failed: ${msg}; ` +
					`retrying in ${backoffMs}ms`,
			);
			// Schedule the next attempt without holding isReconnecting across
			// the timer — the recursive call will re-acquire it.
			setTimeout(() => {
				this.isReconnecting = false;
				if (!this.shutdownRequested) void this.reconnect();
			}, backoffMs);
			return;
		} finally {
			// Only release the lock on success path; the error path's
			// setTimeout releases it itself before the recursive call.
			if (this.connectionState === "connected") {
				this.isReconnecting = false;
			}
		}
	}
}

function parseTelegramConversationId(conversationId: string): number {
	const chatId = conversationId.split(":")[1];
	return Number(chatId);
}

function escapeMarkdownV2(text: string): string {
	const codeBlocks: string[] = [];
	let result = text.replace(/```[\s\S]*?```/g, (match) => {
		codeBlocks.push(match);
		return `\x00CB${codeBlocks.length - 1}\x00`;
	});
	const inlineCodes: string[] = [];
	result = result.replace(/`[^`]+`/g, (match) => {
		inlineCodes.push(match);
		return `\x00IC${inlineCodes.length - 1}\x00`;
	});
	result = result.replace(/([_*\[\]()~>#+\-=|{}.!\\])/g, "\\$1");
	for (let i = 0; i < inlineCodes.length; i++) {
		result = result.replace(`\x00IC${i}\x00`, inlineCodes[i]);
	}
	for (let i = 0; i < codeBlocks.length; i++) {
		result = result.replace(`\x00CB${i}\x00`, codeBlocks[i]);
	}
	return result;
}
