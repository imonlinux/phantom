/**
 * Telegram channel interaction adapter.
 *
 * Phase 2.1 of the Telegram parity plan: status reactions via Bot API 7.0+
 * setMessageReaction. The reaction-API research (telegram-reaction-api-research.md)
 * established the constraints this implementation respects:
 *
 * - The accepted-emoji set is a fixed server-side allowlist of ~70 emoji.
 *   Several intuitive picks (✅, 🛠/🔧, 💻, ⚠) are NOT on the list, so the
 *   Telegram emoji map differs materially from Slack's defaults.
 * - Bots can have only one reaction per message. setMessageReaction
 *   replaces; the controller's "remove old then add new" pattern collapses
 *   to a single API call here.
 * - Per-chat rate limit is ~1 call/sec. The controller's debounceMs is
 *   bumped to 1100ms for Telegram to stay under the ceiling, with terminal
 *   states (done/error) firing immediately and accepting the rare 429.
 * - REACTION_INVALID disables reactions for the chat for the rest of the
 *   session — handled inside TelegramChannel.setReaction; the controller
 *   sees only successful or skipped calls.
 *
 * Phase 1 typing behavior is preserved.
 *
 * Phases 2.2-2.5 will populate progressStream, deliverResponse with
 * inline-keyboard feedback, and action-button hint rendering.
 */

import type { ChannelInteractionFactory, ChannelInteractionInstance } from "./interaction-adapter.ts";
import type { TelegramChannel } from "./telegram.ts";
import type { InboundMessage } from "./types.ts";
import {
	createStatusReactionController,
	type StatusEmojis,
	type StatusReactionController,
} from "./status-reactions.ts";

/**
 * Telegram emoji map. Locked to the Bot API allowlist; substitutions per
 * the reaction-API research:
 *
 *   queued     👀  (allowed; direct match for Slack's eyes)
 *   thinking   🤔  (🧠 NOT allowed; closest concept)
 *   tool       👨‍💻 (🛠/🔧 NOT allowed; reused for coding/web — no subdivision)
 *   coding     👨‍💻 (alias for tool — Telegram doesn't subdivide)
 *   web        👨‍💻 (alias for tool — 🌐 NOT allowed)
 *   done       👌  (✅ NOT allowed; calmer than 🎉 for routine completions)
 *   error      😱  (⚠ NOT allowed; on-tone alternative)
 *   stallSoft  🥱  ("this is taking a while" without alarm)
 *   stallHard  😨  (escalated concern; ❗ NOT allowed)
 */
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

/**
 * Telegram debounce. Per-chat rate limit is ~1 call/sec; we use 1100ms with
 * implicit jitter from the runtime event timing to stay safely under.
 * Terminal states (setDone/setError) bypass the debounce and fire immediately.
 */
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

		// P2.1: status reactions on the user's message. Requires both chatId
		// and messageId. If messageId is missing for some reason (older
		// metadata, callback queries from buttons that don't carry it), the
		// reaction surface is skipped and we fall through to typing-only.
		let statusReactions: StatusReactionController | undefined;
		if (messageId !== undefined) {
			const mid = messageId;
			statusReactions = createStatusReactionController({
				adapter: {
					addReaction: async (emoji) => {
						await tc.setReaction(cid, mid, emoji);
					},
					// Telegram bots have at most one reaction at a time —
					// setReaction with a new emoji replaces the old one
					// server-side. The "remove" call here is a no-op the
					// controller invokes before each transition; we honor
					// the contract by clearing only when asked to remove
					// the currently-set emoji (i.e., final cleanup).
					removeReaction: async (_emoji) => {
						// No-op: see comment above. The next addReaction will
						// replace any existing emoji atomically.
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

		return {
			statusReactions,

			async onTurnStart(): Promise<void> {
				tc.startTyping(cid);
			},

			onRuntimeEvent(event): void {
				switch (event.type) {
					case "thinking":
						statusReactions?.setThinking();
						break;
					case "tool_use":
						statusReactions?.setTool(event.tool);
						break;
					case "error":
						statusReactions?.setError();
						break;
				}
			},

			async onTurnEnd(): Promise<void> {
				tc.stopTyping(cid);
			},

			// No deliverResponse yet (P2.3 will add inline-keyboard feedback).
			// Phase 1 routes Telegram through the default router.send path.

			dispose(): void {
				statusReactions?.dispose();
			},
		};
	};
}
