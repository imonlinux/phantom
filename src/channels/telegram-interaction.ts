/**
 * Telegram channel interaction adapter.
 *
 * Phase 2.1: status reactions via setMessageReaction (TELEGRAM_EMOJIS map).
 * Phase 2.2 (this file): progressStream wired to postProgressMessage /
 *   updateProgressMessage / finishProgressMessage. deliverResponse claims
 *   the response by replacing the progress message with the final text.
 *
 * The progress message and the status reactions are complementary and run
 * in parallel: the user's message gets the reaction state machine
 * (👀 → 🤔 → 👨‍💻 → 👌), and the bot posts a separate "Working on it…"
 * message that updates with activity (`> Reading /x.ts`, `> Running: ...`)
 * and finally edits in place to show the response. Same UX as Slack.
 *
 * Phases 2.3–2.5 will populate inline-keyboard feedback buttons and
 * action-button hint rendering in deliverResponse.
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

		// P2.1: status reactions on the user's message. Skipped if messageId
		// is missing (older metadata, callback queries that don't carry it).
		let statusReactions: StatusReactionController | undefined;
		if (messageId !== undefined) {
			const mid = messageId;
			statusReactions = createStatusReactionController({
				adapter: {
					addReaction: async (emoji) => {
						await tc.setReaction(cid, mid, emoji);
					},
					// Telegram's setMessageReaction replaces atomically, so the
					// controller's "remove old then add new" pattern collapses
					// to a single call. The remove side is a no-op.
					removeReaction: async (_emoji) => {
						// no-op
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

		// P2.2: progress stream — posts "Working on it…" and updates with
		// tool activity, then replaces with the final response on finish.
		// Reuses progress-stream.ts (same module Slack uses); the THROTTLE_MS
		// of 1000ms in that module aligns with Telegram's per-chat rate limit.
		const progressStream: ProgressStream = createProgressStream({
			adapter: {
				postMessage: async (_text) => {
					// Ignore the text param — postProgressMessage hardcodes
					// "Working on it..." which matches the controller's default.
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
					// postProgressMessage failed earlier and returned "". The
					// controller still calls finish with the final text — fall
					// back to a fresh send. We don't have a great way to do
					// this from inside onFinish since we don't get the channel
					// directly; rely on the deliverResponse fallback chain
					// below to handle it. For now, log and skip.
					console.warn("[telegram] Progress message id missing at finish; deliverResponse will fall back");
					return;
				}
				await tc.finishProgressMessage(cid, numericId, text);
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
						// P2.2: append activity to the progress stream.
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

			/**
			 * P2.2: claim the response by finishing the progress stream.
			 * On success (progressStream.finish completes), the orchestration
			 * skips router.send entirely. If we couldn't post a progress
			 * message earlier (postProgressMessage returned null), the
			 * progress stream's getMessageId() returns null and finish
			 * silently no-ops — we fall through and let router.send deliver
			 * the response as a fresh message.
			 */
			async deliverResponse({ text }): Promise<boolean> {
				// If the progress message was posted successfully, finish
				// claims delivery. progress-stream.finish() calls our
				// onFinish hook which calls finishProgressMessage().
				const progressMessageId = progressStream.getMessageId();
				if (progressMessageId) {
					await progressStream.finish(text);
					return true;
				}
				// Progress message couldn't be posted (network blip during
				// onTurnStart, e.g.). Let router.send handle delivery.
				return false;
			},

			dispose(): void {
				statusReactions?.dispose();
			},
		};
	};
}
