/**
 * Telegram channel interaction adapter.
 *
 * Phase 2.1: status reactions via setMessageReaction (TELEGRAM_EMOJIS map).
 * Phase 2.2: progressStream wired to postProgressMessage / updateProgressMessage /
 *   finishProgressMessage.
 * Phase 2.3 (this file): finishProgressMessage now receives attachFeedback=true,
 *   which appends inline-keyboard feedback buttons (👍 / 👎 / 🤔) to the final
 *   response. The Telegram channel's bot.action handler intercepts those button
 *   clicks and routes them to emitFeedback() — see telegram.ts.
 */

import type { ChannelInteractionFactory, ChannelInteractionInstance } from "./interaction-adapter.ts";
import { createProgressStream, formatToolActivity, type ProgressStream } from "./progress-stream.ts";
import {
	createStatusReactionController,
	type StatusEmojis,
	type StatusReactionController,
} from "./status-reactions.ts";
import type { TelegramChannel } from "./telegram.ts";
import type { InboundMessage } from "./types.ts";

export const TELEGRAM_EMOJIS: StatusEmojis = {
	queued: "👀",
	thinking: "🤔",
	tool: "👨\u200d💻",
	coding: "👨\u200d💻",
	web: "👨\u200d💻",
	done: "👌",
	error: "😱",
	stallSoft: "🥱",
	stallHard: "😨",
};

export const TELEGRAM_TIMING = {
	debounceMs: 1100,
	stallSoftMs: 10_000,
	stallHardMs: 30_000,
};

export function createTelegramInteractionFactory(
	telegramChannel: TelegramChannel | null,
): ChannelInteractionFactory {
	return (msg: InboundMessage): ChannelInteractionInstance | null => {
		if (!telegramChannel || msg.channelId !== "telegram" || !msg.metadata) return null;

		const chatId = msg.metadata.telegramChatId as number | undefined;
		const messageId = msg.metadata.telegramMessageId as number | undefined;
		if (chatId === undefined) return null;

		const tc = telegramChannel;
		const cid = chatId;

		let statusReactions: StatusReactionController | undefined;
		if (messageId !== undefined) {
			const mid = messageId;
			statusReactions = createStatusReactionController({
				adapter: {
					addReaction: async (emoji) => {
						await tc.setReaction(cid, mid, emoji);
					},
					removeReaction: async (_emoji) => {
						// no-op: setMessageReaction replaces atomically
					},
				},
				emojis: TELEGRAM_EMOJIS,
				timing: TELEGRAM_TIMING,
				onError: (err) => {
					const errMsg = err instanceof Error ? err.message : String(err);
					console.warn(`[telegram] Reaction error: ${errMsg}`);
				},
			});
			statusReactions.setQueued();
		}

		const progressStream: ProgressStream = createProgressStream({
			adapter: {
				postMessage: async (_text) => {
					const id = await tc.postProgressMessage(cid);
					return id !== null ? String(id) : "";
				},
				updateMessage: async (msgId, updatedText) => {
					const numericId = Number(msgId);
					if (Number.isNaN(numericId)) return;
					await tc.updateProgressMessage(cid, numericId, updatedText);
				},
			},
			onFinish: async (msgId, text) => {
				const numericId = Number(msgId);
				if (Number.isNaN(numericId)) {
					console.warn("[telegram] Progress message id missing at finish");
					return;
				}
				// P2.3: attach feedback buttons to the final response.
				// Always attached (even on errors — the user can flag bad errors).
				await tc.finishProgressMessage(cid, numericId, text, true);
			},
			onError: (err) => {
				const errMsg = err instanceof Error ? err.message : String(err);
				console.warn(`[telegram] Progress stream error: ${errMsg}`);
			},
		});

		return {
			statusReactions,
			progressStream,

			async onTurnStart(): Promise<void> {
				tc.startTyping(cid);
				await progressStream.start();
			},

			onRuntimeEvent(event): void {
				switch (event.type) {
					case "thinking":
						statusReactions?.setThinking();
						break;
					case "tool_use":
						statusReactions?.setTool(event.tool);
						const summary = formatToolActivity(event.tool, event.input);
						progressStream.addToolActivity(event.tool, summary);
						break;
					case "error":
						statusReactions?.setError();
						break;
				}
			},

			async onTurnEnd(): Promise<void> {
				tc.stopTyping(cid);
			},

			async deliverResponse({ text }): Promise<boolean> {
				const progressMessageId = progressStream.getMessageId();
				if (progressMessageId) {
					await progressStream.finish(text);
					return true;
				}
				return false;
			},

			dispose(): void {
				statusReactions?.dispose();
			},
		};
	};
}
