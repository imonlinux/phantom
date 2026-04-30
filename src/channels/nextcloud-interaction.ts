/**
 * Nextcloud Talk channel interaction adapter.
 *
 * Phase 1 of the Telegram parity plan: extract the Nextcloud-specific
 * orchestration code from `src/index.ts` (status reactions on the user's
 * message via the Talk Bot reactions API) into an adapter factory.
 *
 * This is a direct lift of the existing logic — no behavior change.
 * Existing Nextcloud tests must continue to pass unchanged after the
 * rewire in `src/index.ts`.
 *
 * Note: Nextcloud Talk uses raw Unicode reactions (not Slack-style short
 * names). The NEXTCLOUD_EMOJIS map is owned here now since it's only used
 * by the Nextcloud adapter. ⚠ uses U+26A0 without VS-16 per Fix #8 to
 * avoid validation issues on some Talk deployments.
 */

import type { ChannelInteractionFactory, ChannelInteractionInstance } from "./interaction-adapter.ts";
import type { NextcloudChannel } from "./nextcloud.ts";
import type { InboundMessage } from "./types.ts";
import { createStatusReactionController, type StatusEmojis, type StatusReactionController } from "./status-reactions.ts";

export const NEXTCLOUD_EMOJIS: StatusEmojis = {
	queued: "👀",
	thinking: "🧠",
	tool: "🔧",
	coding: "💻",
	web: "🌐",
	done: "✅",
	error: "\u26A0",
	stallSoft: "⏳",
	stallHard: "❗",
};

/**
 * Build a factory that produces Nextcloud interaction adapters when the
 * inbound message originates from the given Nextcloud channel instance.
 *
 * Returns null for non-Nextcloud messages or when the channel argument
 * is null (Nextcloud not configured).
 */
export function createNextcloudInteractionFactory(
	nextcloudChannel: NextcloudChannel | null,
): ChannelInteractionFactory {
	return (msg: InboundMessage): ChannelInteractionInstance | null => {
		if (!nextcloudChannel || msg.channelId !== "nextcloud" || !msg.metadata) return null;

		const roomToken = msg.metadata.nextcloudRoomToken as string | undefined;
		const messageId = msg.metadata.nextcloudMessageId as number | undefined;

		// Both must be set for reactions; otherwise this turn gets no
		// channel-specific signaling. Return an empty instance so the
		// orchestration treats Nextcloud as "we know it's Nextcloud, just
		// don't do anything special" — equivalent to the old code path
		// where the `if` check failed and statusReactions stayed null.
		if (!roomToken || messageId === undefined) return null;

		const nc = nextcloudChannel;
		const rt = roomToken;
		const mid = messageId;

		const statusReactions: StatusReactionController = createStatusReactionController({
			adapter: {
				addReaction: async (emoji) => {
					await nc.setReaction(rt, mid, emoji, true);
				},
				removeReaction: async (emoji) => {
					await nc.setReaction(rt, mid, emoji, false);
				},
			},
			emojis: NEXTCLOUD_EMOJIS,
			onError: (err) => {
				const errMsg = err instanceof Error ? err.message : String(err);
				console.warn(`[nextcloud] Reaction error: ${errMsg}`);
			},
		});
		statusReactions.setQueued();

		return {
			statusReactions,

			onRuntimeEvent(event): void {
				switch (event.type) {
					case "thinking":
						statusReactions.setThinking();
						break;
					case "tool_use":
						statusReactions.setTool(event.tool);
						break;
					case "error":
						statusReactions.setError();
						break;
				}
			},

			// No deliverResponse override: Nextcloud uses the default router.send
			// path. The original code explicitly handled the replyToId via the
			// outbound message's `replyToId` field, which is constructed by the
			// orchestration based on `msg.metadata.nextcloudMessageId`.

			dispose(): void {
				statusReactions.dispose();
			},
		};
	};
}
