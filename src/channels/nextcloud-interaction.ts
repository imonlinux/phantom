/**
 * Nextcloud Talk channel interaction adapter.
 *
 * Phase 1 of the Telegram parity plan: extract the Nextcloud-specific
 * orchestration code from `src/index.ts` (status reactions on the user's
 * message via the Talk Bot reactions API) into an adapter factory.
 *
 * This adapter provides:
 * - Status reactions: 👀 queued → 🧠 thinking → 🔧 tool → removed on done / ⚠ error
 *   (Talk renders every reaction change as a chat system message, so a
 *   successful turn clears the reaction instead of parking a ✅ on the
 *   message; see issue #1)
 * - Feedback mechanism: "Was this helpful? React with 👍, ❤️, or ✅ (yes) or 👎/❌ (no)"
 * - Thread awareness: responses follow the conversation's Talk thread when
 *   the session is thread-scoped (Talk 24+)
 *
 * Nextcloud limitations (vs Telegram):
 * - No inline keyboards → use reaction-based feedback instead
 * - Bot POST responses carry no message ID and no edit endpoint exists →
 *   progressive updates are impossible; each update would be a new message
 * - No typing indicators → status reactions serve as activity indicator
 *
 * Configuration options (from NextcloudChannelConfig):
 * - enableFeedback: Enable feedback collection via reactions (default: true)
 */

import type { ChannelInteractionFactory, ChannelInteractionInstance } from "./interaction-adapter.ts";
import type { NextcloudChannel } from "./nextcloud.ts";
import type { InboundMessage } from "./types.ts";
import { createStatusReactionController, type StatusEmojis, type StatusReactionController } from "./status-reactions.ts";
import { registerInFlightMessage, unregisterInFlightMessage } from "./interrupt.ts";

// Phase 1: Enhanced emoji map for Nextcloud (matches Slack defaults)
export const NEXTCLOUD_EMOJIS: StatusEmojis = {
	queued: "👀",
	thinking: "🧠",
	tool: "🔧",
	coding: "💻",
	web: "🌐",
	done: "✅",
	error: "⚠",
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
	config?: {
		enableFeedback?: boolean;
	},
): ChannelInteractionFactory {
	return (msg: InboundMessage): ChannelInteractionInstance | null => {
		if (!nextcloudChannel || msg.channelId !== "nextcloud" || !msg.metadata) return null;

		const roomToken = msg.metadata.nextcloudRoomToken as string | undefined;
		const messageId = msg.metadata.nextcloudMessageId as number | undefined;
		const threadId = msg.metadata.nextcloudThreadId as number | undefined;

		// Both must be set for reactions; otherwise this turn gets no
		// channel-specific signaling. Return an empty instance so the
		// orchestration treats Nextcloud as "we know it's Nextcloud, just
		// don't do anything special" — equivalent to the old code path
		// where the `if` check failed and statusReactions stayed null.
		if (!roomToken || messageId === undefined) return null;

		const nc = nextcloudChannel;
		const rt = roomToken;
		const mid = messageId;

		// Phase 1: Status reactions (always enabled)
		const inner = createStatusReactionController({
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
		// Talk logs every reaction change as a chat system message, and bot
		// actors render as "Deleted user" in that log. On success the turn
		// therefore removes the reaction entirely (the response message is
		// the done signal) instead of applying a terminal ✅. Errors keep
		// the ⚠ from setError so failed turns stay identifiable in history.
		const statusReactions: StatusReactionController = {
			...inner,
			setDone: () => inner.clear(),
		};
		statusReactions.setQueued();

		// Anchor this turn's in-flight message so a stop-emoji reaction on it
		// can be resolved back to the conversation (agent interrupt). The
		// dispose() cleanup always runs, even on throw (issue: agent interrupt)
		registerInFlightMessage("nextcloud", mid, {
			channelId: "nextcloud",
			conversationId: msg.conversationId,
		});

		// Thread-scoped sessions (Talk 24+) post responses back into the Talk
		// thread; undefined threadId keeps the plain room-level behavior.
		const deliverText = async (text: string): Promise<void> => {
			await nc.postToNextcloud(rt, text, undefined, threadId);
		};

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

			async onTurnEnd(): Promise<void> {
				// Nextcloud doesn't have typing indicators like Telegram
				// Status reactions serve as the activity indicator
			},

			async deliverResponse({ text }): Promise<boolean> {
				const enableFeedback = config?.enableFeedback !== false;
				if (enableFeedback) {
					const feedbackPrompt = "\n\n💡 Was this helpful? React with 👍, ❤️, or ✅ (yes) or 👎/❌ (no)";
					await deliverText(text + feedbackPrompt);
				} else {
					await deliverText(text);
				}
				return true;
			},

			dispose(): void {
				unregisterInFlightMessage("nextcloud", mid);
				statusReactions.dispose();
			},
		};
	};
}
