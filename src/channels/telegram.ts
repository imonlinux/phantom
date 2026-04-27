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

	constructor(config: TelegramChannelConfig) {
		this.config = config;
	}

	async connect(): Promise<void> {
		if (this.connectionState === "connected") return;
		this.connectionState = "connecting";

		try {
			const { Telegraf } = await import("telegraf");
			this.bot = new Telegraf(this.config.botToken) as unknown as TelegrafBot;

			this.registerHandlers();
			await this.bot.launch();
			this.connectionState = "connected";
			console.log("[telegram] Bot connected via long polling");
		} catch (err: unknown) {
			this.connectionState = "error";
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`[telegram] Failed to connect: ${msg}`);
			throw err;
		}
	}

	async disconnect(): Promise<void> {
		if (this.connectionState === "disconnected") return;

		for (const timer of this.typingTimers.values()) {
			clearInterval(timer);
		}
		this.typingTimers.clear();

		try {
			this.bot?.stop();
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`[telegram] Error during disconnect: ${msg}`);
		}

		this.connectionState = "disconnected";
		console.log("[telegram] Disconnected");
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
		// (kept thin in this snapshot; the existing implementation in the repo
		// stays as-is. The new behaviors land via the interaction adapter.)
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
