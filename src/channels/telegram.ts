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
import { buildFeedbackInlineKeyboard, emitFeedback, parseFeedbackAction } from "./feedback.ts";
import { escapeMarkdownV2, splitForTelegram, TELEGRAM_MAX_MESSAGE_LENGTH } from "./markdown-v2.ts";

type TelegrafBot = {
	launch: (opts?: { allowedUpdates?: string[] }) => Promise<void>;
	stop: () => void;
	command: (cmd: string, handler: (ctx: TelegrafContext) => Promise<void>) => void;
	on: (event: string, handler: (ctx: TelegrafContext) => Promise<void>) => void;
	action: (pattern: RegExp, handler: (ctx: TelegrafContext) => Promise<void>) => void;
	reaction: (emoji: string | string[], handler: (ctx: TelegrafContext) => Promise<void>) => void;
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
		chat: { id: number; type?: "private" | "group" | "supergroup" | "channel" };
		message_id: number;
	};
	reply: (text: string, options?: Record<string, unknown>) => Promise<{ message_id: number }>;
	telegram: TelegramApi;
	chat?: { id: number; type?: "private" | "group" | "supergroup" | "channel" };
	from?: { id: number; first_name?: string; username?: string };
	match?: RegExpMatchArray;
	answerCbQuery?: (text?: string) => Promise<void>;
	callbackQuery?: { data?: string; message?: { message_id: number; chat: { id: number } } };
};

export type TelegramChannelConfig = {
	botToken: string;
	enableMessageReactions?: boolean;
	/**
	 * P3: List of Telegram numeric user IDs (as strings) authorized to
	 * interact with the bot. Empty array (default) means no restrictions.
	 */
	ownerUserIds?: string[];
};

type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

// Telegram's hard message length limit. Phase 5 will add proper splitting;
// P2.2 falls back to a fresh send when the final response exceeds this.
const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

// P3: Rejection reply sent to non-owners in DMs. First message gets the
// explanation, subsequent ones are silently dropped (tracked via rejectedUsers).
const REJECTION_REPLY =
	"Hi! I'm Phantom, a personal AI co-worker. I can only respond to my owner. " +
	"<https://github.com/ghostwright/phantom>";

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
		// P2.2: progressive tool activity updates (Working on it... → final response)
		progressUpdates: true,
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

	// P3: Users who have been DM-rejected at least once. We track them so
	// we don't send the rejection reply repeatedly — first message gets the
	// explanation, subsequent ones are silently dropped.
	//
	// Unbounded by design — for a personal bot in DMs this never grows
	// meaningfully. If we ever see runaway growth in the wild, swap for an
	// LRU. Until then, simpler is better.
	private rejectedUsers = new Set<string>();

	// Connection supervision (interim fix; Phase 8 webhook mode is the real
	// solution). Long-polling can silently drop without Telegraf surfacing the
	// failure to the orchestration. We periodically ping getMe to detect dead
	// connections and reconnect with exponential backoff.
	private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
	private isReconnecting = false;
	private shutdownRequested = false;
	private reconnectAttempts = 0;

	private static readonly HEALTHCHECK_INTERVAL_MS = 60_000;
	// Wait for immediate launch failures (bad token, fast network errors)
	// before declaring the launch successful. Telegraf's bot.launch() never
	// resolves on success — it only rejects on failure or when bot.stop().
	private static readonly LAUNCH_SETTLE_MS = 2_000;
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

			// P2.4: subscribe to message_reaction updates only when the operator
			// has opted in. Default polling does NOT include reaction events;
			// without this, bot.reaction handlers never fire.
			const allowedUpdates: string[] = ["message", "callback_query"];
			if (this.config.enableMessageReactions) {
				allowedUpdates.push("message_reaction");
			}

			// CRITICAL: bot.launch() in long-polling mode returns a promise
			// that resolves when polling STOPS, not when it starts. Awaiting
			// it blocks forever — leaving connectionState stuck at "connecting"
			// while the bot actually polls and serves messages in the background.
			//
			// We start launch as a background promise, wait LAUNCH_SETTLE_MS
			// for immediate failures, then verify responsiveness via getMe()
			// before declaring success. The launchPromise's catch handler
			// stays hooked so a later polling failure (e.g., 409 Conflict
			// from a held slot, network drop) triggers reconnect.
			let immediateError: Error | null = null;
			const launchPromise = this.bot.launch({ allowedUpdates }).catch((err: unknown) => {
				const errMsg = err instanceof Error ? err.message : String(err);
				if (this.connectionState === "connecting") {
					// Failure during settle window — capture for caller throw.
					immediateError = err instanceof Error ? err : new Error(errMsg);
				} else if (this.connectionState === "connected" && !this.shutdownRequested) {
					// Polling died after we declared connected. Trigger
					// reconnect immediately (don't wait for the 60s healthcheck).
					console.warn(`[telegram] Polling loop ended: ${errMsg}; reconnecting`);
					this.connectionState = "error";
					void this.reconnect();
				}
			});

			await Promise.race([
				new Promise((resolve) => setTimeout(resolve, TelegramChannel.LAUNCH_SETTLE_MS)),
				launchPromise,
			]);

			if (immediateError) {
				throw immediateError;
			}

			// Verify the bot is responsive. getMe is the cheapest API call
			// and uses a different endpoint than getUpdates, so it succeeds
			// even when the polling slot is contested. Combined with the
			// settle window above, this catches bad tokens immediately.
			await this.bot.telegram.getMe();

			this.connectionState = "connected";
			const ownerCount = this.config.ownerUserIds?.length ?? 0;
			if (ownerCount > 0) {
				console.log(`[telegram] Access control active: ${ownerCount} owner ID(s) configured`);
			} else {
				console.log("[telegram] No access control configured — all users can interact with the bot");
			}
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

	/**
	 * P2.2: Post a fresh "Working on it…" message as plain text. Returns
	 * the new message_id, or null on failure (best-effort — the caller
	 * should fall through to typing-only signaling if this returns null).
	 *
	 * Plain text (no parse_mode) is intentional: the progress message is
	 * transient, gets edited many times during a turn, and the bytes saved
	 * by skipping MarkdownV2 escaping add up across the throttled edit
	 * stream. The final-response edit (finishProgressMessage) does use
	 * MarkdownV2 since the user keeps reading it.
	 */
	async postProgressMessage(chatId: number): Promise<number | null> {
		if (!this.bot) return null;
		try {
			const result = await this.bot.telegram.sendMessage(chatId, "Working on it...");
			return result.message_id;
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`[telegram] Failed to post progress message: ${msg}`);
			return null;
		}
	}

	/**
	 * P2.2: Update a progress message in place with new activity. Plain
	 * text — no MarkdownV2 escape, matching postProgressMessage.
	 *
	 * Best-effort: silently swallows the "message is not modified" case
	 * (Telegram's expected response when the new text equals the old) and
	 * warns on other failures without throwing. progress-stream.ts already
	 * throttles to 1 update/sec which lines up with Telegram's per-chat
	 * rate limit.
	 */
	async updateProgressMessage(chatId: number, messageId: number, text: string): Promise<void> {
		if (!this.bot) return;
		try {
			await this.bot.telegram.editMessageText(chatId, messageId, undefined, text);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			if (!msg.includes("message is not modified")) {
				console.warn(`[telegram] Failed to update progress message: ${msg}`);
			}
		}
	}

	/**
	 * P5.3: Replace the progress message with the final agent response.
	 * Splits long responses into chunks ≤ 4096 chars after MarkdownV2 escaping.
	 *
	 * Multi-chunk flow:
	 * - Chunk 1: edit progress message (no buttons)
	 * - Chunks 2..N-1: send as fresh messages (no buttons)
	 * - Chunk N: send with buttons (if attachFeedback and not truncated)
	 *
	 * Preserves parse-error fallback: if any API call fails, falls back
	 * to a fresh message send with the full escaped text.
	 *
	 * Returns the message_id of the last message containing response content
	 * (either the edited progress message or the final fresh message).
	 */
	async finishProgressMessage(
		chatId: number,
		messageId: number,
		text: string,
		attachFeedback = false,
	): Promise<number> {
		if (!this.bot) throw new Error("Telegram bot not connected");

		const chunks = splitForTelegram(text);
		const isTruncated = chunks.length === 5 && text.length > TELEGRAM_MAX_MESSAGE_LENGTH * 5;

		// Single chunk: edit the progress message in place.
		if (chunks.length === 1) {
			const escaped = chunks[0];
			const replyMarkup = attachFeedback
				? { reply_markup: { inline_keyboard: buildFeedbackInlineKeyboard() } }
				: {};

			try {
				await this.bot.telegram.editMessageText(chatId, messageId, undefined, escaped, {
					parse_mode: "MarkdownV2",
					...replyMarkup,
				});
				return messageId;
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				if (msg.includes("message is not modified")) {
					return messageId;
				}
				console.warn(
					`[telegram] Failed to finalize progress message (${msg}); sending response as fresh message`,
				);
				return this.editOrSendMessage(chatId, messageId, escaped, attachFeedback);
			}
		}

		// Multi-chunk: edit progress message with chunk 1, send rest as fresh messages.
		let lastMessageId: number;

		// Chunk 1: edit progress message (no buttons, even if attachFeedback)
		try {
			await this.bot.telegram.editMessageText(chatId, messageId, undefined, chunks[0], {
				parse_mode: "MarkdownV2",
			});
			lastMessageId = messageId;
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`[telegram] Failed to edit progress message with chunk 1 (${msg}); sending as fresh message`);
			lastMessageId = await this.editOrSendMessage(chatId, messageId, chunks[0], false);
		}

		// Chunks 2..N-1: send as fresh messages (no buttons)
		for (let i = 1; i < chunks.length - 1; i++) {
			try {
				const result = await this.bot.telegram.sendMessage(chatId, chunks[i], {
					parse_mode: "MarkdownV2",
				});
				lastMessageId = result.message_id;
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				console.error(`[telegram] Failed to send chunk ${i + 1}: ${msg}`);
				// Continue trying to send remaining chunks
			}
		}

		// Final chunk: attach buttons if requested and not truncated
		const finalChunkIndex = chunks.length - 1;
		const attachButtonsToFinal = attachFeedback && !isTruncated;
		try {
			const result = await this.bot.telegram.sendMessage(
				chatId,
				chunks[finalChunkIndex],
				attachButtonsToFinal
					? {
							parse_mode: "MarkdownV2",
							reply_markup: { inline_keyboard: buildFeedbackInlineKeyboard() },
						}
					: { parse_mode: "MarkdownV2" },
			);
			lastMessageId = result.message_id;
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`[telegram] Failed to send final chunk: ${msg}`);
		}

		return lastMessageId;
	}

	/**
	 * P5.3: Helper for edit-or-send fallback. Attempts to edit the progress
	 * message; on failure, sends a fresh message. Used for single-chunk
	 * responses when the edit fails.
	 */
	private async editOrSendMessage(
		chatId: number,
		messageId: number,
		escaped: string,
		attachFeedback: boolean,
	): Promise<number> {
		if (!this.bot) throw new Error("Telegram bot not connected");

		try {
			const result = await this.bot.telegram.sendMessage(
				chatId,
				escaped,
				attachFeedback
					? {
							parse_mode: "MarkdownV2",
							reply_markup: { inline_keyboard: buildFeedbackInlineKeyboard() },
						}
					: { parse_mode: "MarkdownV2" },
			);
			return result.message_id;
		} catch (sendErr: unknown) {
			const sendMsg = sendErr instanceof Error ? sendErr.message : String(sendErr);
			console.error(`[telegram] Failed to send fallback response: ${sendMsg}`);
			throw sendErr;
		}
	}

	/**
	 * P2.3: Remove the inline keyboard from a message after the user clicks
	 * a feedback button. Leaves the message text intact — only the buttons
	 * are cleared. Best-effort; errors are warned but not thrown.
	 */
	async clearMessageButtons(chatId: number, messageId: number): Promise<void> {
		if (!this.bot) return;
		try {
			await this.bot.telegram.editMessageReplyMarkup(chatId, messageId, undefined, undefined);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			// "message is not modified" is benign — buttons were already cleared.
			if (!msg.includes("message is not modified")) {
				console.warn(`[telegram] Failed to clear message buttons: ${msg}`);
			}
		}
	}

	/**
	 * P3: Check if a sender is in the configured owner list. Empty list
	 * means "no restrictions" (allow everyone) — the default for backwards
	 * compatibility with deployments that don't set ownerUserIds.
	 */
	private isOwner(senderId: string): boolean {
		const owners = this.config.ownerUserIds ?? [];
		if (owners.length === 0) return true;
		return owners.includes(senderId);
	}

	/**
	 * P3: Decide what to do with a non-owner's interaction.
	 * - DM, first time: send rejection reply, mark as rejected
	 * - DM, already rejected: silent ignore
	 * - Group/supergroup/channel: silent ignore (no rejection in shared rooms)
	 */
	private resolveAccess(
		senderId: string,
		chatType: "private" | "group" | "supergroup" | "channel" | undefined,
	): "allowed" | "reject_dm" | "ignore" {
		if (this.isOwner(senderId)) return "allowed";
		if (chatType === "group" || chatType === "supergroup" || chatType === "channel") {
			return "ignore";
		}
		if (this.rejectedUsers.has(senderId)) return "ignore";
		return "reject_dm";
	}

	/**
	 * P2.4: Map a Telegraf reaction-update context to a FeedbackSignal and
	 * emit it. Best-effort — silently returns if the context is missing
	 * required fields. Telegram filters out reactions set by the bot itself
	 * server-side (per the API docs), so we don't need a self-filter here.
	 */
	private handleReactionFeedback(
		ctx: TelegrafContext,
		type: "positive" | "negative",
	): void {
		const update = ctx.update as unknown as {
			message_reaction?: {
				chat?: { id: number };
				message_id?: number;
				user?: { id: number };
			};
		};
		const mr = update.message_reaction;
		if (!mr?.chat?.id || mr.message_id === undefined || !mr.user?.id) {
			// Anonymous reactions (group chats with anonymous admin) provide
			// actor_chat instead of user. We don't accept those as feedback
			// because there's no actionable user identity for the evolution
			// signal. Silently drop.
			return;
		}

		// P3: gate reactions by owner. Non-owners' reactions don't produce
		// feedback signals — they shouldn't influence the evolution engine
		// on the owner's behalf.
		if (!this.isOwner(String(mr.user.id))) return;

		emitFeedback({
			type,
			conversationId: `telegram:${mr.chat.id}`,
			messageTs: String(mr.message_id),
			userId: String(mr.user.id),
			source: "reaction",
			timestamp: Date.now(),
		});
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
			const chatType = ctx.message.chat.type;
			const from = ctx.message.from;
			const senderId = String(from?.id ?? "unknown");

			// P3: access control gate
			const access = this.resolveAccess(senderId, chatType);
			if (access === "ignore") return;
			if (access === "reject_dm") {
				this.rejectedUsers.add(senderId);
				try {
					await this.bot?.telegram.sendMessage(chatId, REJECTION_REPLY);
				} catch (err: unknown) {
					const msg = err instanceof Error ? err.message : String(err);
					console.warn(`[telegram] Failed to send rejection reply: ${msg}`);
				}
				return;
			}

			const conversationId = `telegram:${chatId}`;

			const inbound: InboundMessage = {
				id: String(ctx.message.message_id),
				channelId: this.id,
				conversationId,
				senderId,
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

		// P2.3: Feedback button clicks are intercepted and routed to
		// emitFeedback, NOT to the runtime. Other phantom:* callbacks
		// (action-button hints from P2.5, etc.) continue to route as
		// inbound messages.
		this.bot.action(/^phantom:feedback:(positive|negative|partial)$/, async (ctx) => {
			if (ctx.answerCbQuery) await ctx.answerCbQuery();

			const senderId = String(ctx.from?.id ?? "unknown");
			if (!this.isOwner(senderId)) return; // silent drop, no rejection in callback context

			const data = ctx.callbackQuery?.data;
			const type = data ? parseFeedbackAction(data) : null;
			if (!type) return;

			const chatId = ctx.callbackQuery?.message?.chat.id;
			const messageId = ctx.callbackQuery?.message?.message_id;
			if (chatId === undefined || messageId === undefined) return;

			const conversationId = `telegram:${chatId}`;

			emitFeedback({
				type,
				conversationId,
				messageTs: String(messageId),
				userId: senderId,
				source: "button",
				timestamp: Date.now(),
			});

			// Clear the buttons so the user can't click again.
			await this.clearMessageButtons(chatId, messageId);
		});

		// Handle other inline keyboard button presses (action hints from agent)
		this.bot.action(/^phantom:(.+)$/, async (ctx) => {
			if (ctx.answerCbQuery) {
				await ctx.answerCbQuery();
			}

			const data = ctx.match?.[1];
			if (!data || !this.messageHandler) return;

			// Skip feedback callbacks — handled by the more specific handler above.
			// Telegraf calls handlers in registration order; the specific feedback
			// pattern matches first and the broader pattern wouldn't normally fire
			// for those, but we double-check for safety against framework changes.
			if (data.startsWith("feedback:")) return;

			const senderId = String(ctx.from?.id ?? "unknown");
			if (!this.isOwner(senderId)) return;

			const chatId = ctx.callbackQuery?.message?.chat.id;
			if (!chatId) return;

			const from = ctx.from;
			const conversationId = `telegram:${chatId}`;

			const inbound: InboundMessage = {
				id: `cb_${Date.now()}`,
				channelId: this.id,
				conversationId,
				senderId,
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

		// P2.4: Reaction-as-feedback. Only registered when the operator has
		// opted in via channel config. Requires the bot to be a chat admin for
		// Telegram to deliver these events at all.
		if (this.config.enableMessageReactions) {
			// 👍 / ❤ / 🔥 → positive feedback
			this.bot.reaction(["👍", "❤", "🔥"], async (ctx) => {
				this.handleReactionFeedback(ctx, "positive");
			});
			// 👎 → negative feedback
			this.bot.reaction(["👎"], async (ctx) => {
				this.handleReactionFeedback(ctx, "negative");
			});

			console.log(
				"[telegram] Reaction-as-feedback enabled; bot must be admin in " +
					"groups to receive reaction events. Has no effect in 1:1 DMs.",
			);
		}
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

		// Tear down any existing bot. Failures here are expected — the
		// connection is already broken or never started; we just need the
		// slot freed (best-effort) before re-launching.
		if (this.bot) {
			await this.stopBotWithTimeout();
			this.bot = null;
		}
		this.connectionState = "disconnected";

		// Brief delay so Telegram's server-side polling slot releases
		// before we try to claim it again. On the cold-start case where
		// the slot is held by a previous Docker container, this delay
		// is insufficient on its own — but the launch will retry through
		// the backoff loop until the slot becomes available (~90s after
		// the previous holder's last poll).
		await new Promise((resolve) => setTimeout(resolve, TelegramChannel.RECONNECT_STOP_DELAY_MS));

		if (this.shutdownRequested) {
			this.isReconnecting = false;
			return;
		}

		const launched = await this.tryLaunch();
		if (launched) {
			this.isReconnecting = false;
			console.log("[telegram] Reconnected successfully");
			return;
		}

		// Launch failed — schedule the next attempt with exponential backoff.
		this.reconnectAttempts++;
		const backoffMs = Math.min(
			TelegramChannel.RECONNECT_BACKOFF_BASE_MS * 2 ** (this.reconnectAttempts - 1),
			TelegramChannel.RECONNECT_BACKOFF_CAP_MS,
		);
		console.warn(
			`[telegram] Reconnect attempt ${this.reconnectAttempts} failed; ` +
				`retrying in ${backoffMs}ms`,
		);
		// Release the lock before scheduling, so the timer's recursive
		// call can re-acquire it.
		this.isReconnecting = false;
		setTimeout(() => {
			if (!this.shutdownRequested) void this.reconnect();
		}, backoffMs);
	}
}

function parseTelegramConversationId(conversationId: string): number {
	const chatId = conversationId.split(":")[1];
	return Number(chatId);
}
