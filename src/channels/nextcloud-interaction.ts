/**
 * Nextcloud Talk channel interaction adapter.
 *
 * Phase 1 of the Telegram parity plan: extract the Nextcloud-specific
 * orchestration code from `src/index.ts` (status reactions on the user's
 * message via the Talk Bot reactions API) into an adapter factory.
 *
 * Phase 2: Add progressive updates and feedback mechanism.
 *
 * This adapter provides:
 * - Status reactions: 👀 queued → 🧠 thinking → 🔧 tool → ✅ done/⚠ error
 * - Progressive updates: "Working on it..." → tool activity → final response
 * - Feedback mechanism: "Was this helpful? React with 👍, ❤️, or ✅ (yes) or 👎/❌ (no)"
 *
 * Nextcloud limitations (vs Telegram):
 * - No inline keyboards → use reaction-based feedback instead
 * - Message editing available but complex → use new message updates for progress
 * - No typing indicators → status reactions serve as activity indicator
 *
 * Configuration options (from NextcloudChannelConfig):
 * - enableProgressiveUpdates: Enable progressive "Working on it..." (default: true)
 * - enableFeedback: Enable feedback collection via reactions (default: true)
 * - progressiveUpdateThrottleMs: Throttle between updates (default: 1000ms)
 */

import { createProgressStream, formatToolActivity, type ProgressStream } from "./progress-stream.ts";
import type { ChannelInteractionFactory, ChannelInteractionInstance } from "./interaction-adapter.ts";
import type { NextcloudChannel } from "./nextcloud.ts";
import type { InboundMessage } from "./types.ts";
import { createStatusReactionController, type StatusEmojis, type StatusReactionController } from "./status-reactions.ts";

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
		enableProgressiveUpdates?: boolean;
		enableFeedback?: boolean;
		progressiveUpdateThrottleMs?: number;
	},
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

		// Phase 1: Status reactions (always enabled)
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

		// Phase 2: Progressive updates - DISABLED for Nextcloud
		// Note: Nextcloud's postToNextcloud() returns boolean, not message ID
		// Without message ID, we can't use the editMessage() API to update progress
		// Progressive updates would create multiple messages instead of editing one
		// Therefore, progressive updates are disabled for Nextcloud
		let progressStream: ProgressStream | undefined;
		// Explicitly disable even if config enables it
		if (false && config?.enableProgressiveUpdates !== false) {
			progressStream = createProgressStream({
				adapter: {
					postMessage: async (text) => {
						await nc.postToNextcloud(rt, text);
						return "";
					},
					updateMessage: async (_msgId, _updatedText) => {
						// Not implemented - would require message ID tracking
						console.warn("[nextcloud] Progressive updates not supported - message editing requires message ID");
					},
				},
				onError: (err) => {
					const errMsg = err instanceof Error ? err.message : String(err);
					console.warn(`[nextcloud] Progress stream error: ${errMsg}`);
				},
				onFinish: async (_msgId, text) => {
					const enableFeedback = config?.enableFeedback !== false;
					if (enableFeedback) {
						const feedbackPrompt = "\n\n💡 Was this helpful? React with 👍, ❤️, or ✅ (yes) or 👎/❌ (no)";
						await nc.postToNextcloud(rt, text + feedbackPrompt);
					} else {
						await nc.postToNextcloud(rt, text);
					}
				},
			});
		}

		return {
			statusReactions,
			progressStream,

			async onTurnStart(): Promise<void> {
				// Phase 2: Start progressive updates
				await progressStream?.start();
			},

			onRuntimeEvent(event): void {
				switch (event.type) {
					case "thinking":
						statusReactions.setThinking();
						break;
					case "tool_use":
						statusReactions.setTool(event.tool);
						// Phase 2: Add tool activity to progress stream
						if (progressStream) {
							const summary = formatToolActivity(event.tool, event.input);
							progressStream.addToolActivity(event.tool, summary);
						}
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
				// Phase 2: Use progressive updates if enabled
				if (progressStream) {
					await progressStream.finish(text);
					return true;
				}
				// Fallback: direct response delivery
				const enableFeedback = config?.enableFeedback !== false;
				if (enableFeedback) {
					const feedbackPrompt = "\n\n💡 Was this helpful? React with 👍, ❤️, or ✅ (yes) or 👎/❌ (no)";
					await nc.postToNextcloud(rt, text + feedbackPrompt);
				} else {
					await nc.postToNextcloud(rt, text);
				}
				return true;
			},

			dispose(): void {
				statusReactions.dispose();
			},
		};
	};
}
