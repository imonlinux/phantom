/**
 * Telegram channel interaction adapter.
 *
 * Phase 1 of the Telegram parity plan: this adapter currently wires only
 * the existing typing-indicator behavior that lived in `src/index.ts`.
 * Phase 2 will populate the rest (status reactions via setMessageReaction,
 * progressive editMessageText updates, inline-keyboard feedback buttons,
 * and the action-button hint surface).
 *
 * Keeping this file thin in Phase 1 — even though it's almost a no-op —
 * has two benefits:
 *
 *   1. The orchestration in `src/index.ts` becomes uniform across all
 *      three messaging channels (Slack/Nextcloud/Telegram), eliminating
 *      the per-channel `if` ladder.
 *   2. Phase 2 has a clear seam to extend, with tests that already
 *      validate the lifecycle contract.
 */

import type { ChannelInteractionFactory, ChannelInteractionInstance } from "./interaction-adapter.ts";
import type { TelegramChannel } from "./telegram.ts";
import type { InboundMessage } from "./types.ts";

/**
 * Build a factory that produces Telegram interaction adapters when the
 * inbound message originates from the given Telegram channel instance.
 *
 * Returns null for non-Telegram messages or when the channel argument
 * is null (Telegram not configured).
 */
export function createTelegramInteractionFactory(
	telegramChannel: TelegramChannel | null,
): ChannelInteractionFactory {
	return (msg: InboundMessage): ChannelInteractionInstance | null => {
		if (!telegramChannel || msg.channelId !== "telegram" || !msg.metadata) return null;

		const chatId = msg.metadata.telegramChatId as number | undefined;
		if (chatId === undefined) return null;

		const tc = telegramChannel;
		const cid = chatId;

		return {
			async onTurnStart(): Promise<void> {
				tc.startTyping(cid);
			},

			async onTurnEnd(): Promise<void> {
				tc.stopTyping(cid);
			},

			// No deliverResponse: Telegram uses the default router.send path.

			// No dispose: typing is already stopped in onTurnEnd. The startTyping
			// keepalive in the channel itself handles its own lifecycle.
		};
	};
}
