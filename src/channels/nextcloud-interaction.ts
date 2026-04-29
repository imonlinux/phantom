/**
 * Nextcloud Talk channel interaction adapter - Phase 2 Enhanced Interactions
 *
 * Phase 1: Extract status reactions into adapter factory
 * Phase 2: Add progressive updates and feedback mechanism (mirrors Telegram pattern)
 *
 * This adapter provides:
 * - Status reactions: 👀 queued → 🤔 thinking → 👨‍💻 tool → 👌 done/😱 error
 * - Progressive updates: "Working on it..." → tool activity → final response
 * - Feedback mechanism: "Was this helpful? React with 👍 or 👎" (reaction-based)
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

// Phase 2: Enhanced emoji map for Nextcloud (no allowlist restrictions)
export const NEXTCLOUD_EMOJIS: StatusEmojis = {
	queued: "👀",
	thinking: "🤔",
	tool: "👨‍💻",
	coding: "👨‍💻",
	web: "🌐",
	done: "👌",
	error: "😱",
	stallSoft: "⏳",
	stallHard: "😱",
};

// Phase 2: Timing configuration (matches Telegram)
export const NEXTCLOUD_TIMING = {
	debounceMs: 1100,
	stallSoftMs: 10_000,
	stallHardMs: 30_000,
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
			timing: NEXTCLOUD_TIMING,
			onError: (err) => {
				const errMsg = err instanceof Error ? err.message : String(err);
				console.warn(`[nextcloud] Reaction error: ${errMsg}`);
			},
		});
		statusReactions.setQueued();

		// Phase 2: Progressive updates (configurable, default: enabled)
		let progressStream: ProgressStream | undefined;
		if (config?.enableProgressiveUpdates !== false) {
			progressStream = createProgressStream({
				adapter: {
					postMessage: async (text) => {
						// Post initial "Working on it..." message
						const success = await nc.postToNextcloud(rt, text);
						// Return a tracking ID for the progress message
						return success ? `progress_${mid}_${Date.now()}` : "";
					},
					updateMessage: async (msgId, updatedText) => {
						// Update the progress message with new content
						// For Nextcloud, we post new messages since editing is complex
						// This can be improved later to use the editMessage API
						if (msgId.startsWith("progress_")) {
							await nc.postToNextcloud(rt, updatedText);
						}
					},
				},
				onError: (err) => {
					const errMsg = err instanceof Error ? err.message : String(err);
					console.warn(`[nextcloud] Progress stream error: ${errMsg}`);
				},
				onFinish: async (_msgId, text) => {
					// Phase 2: When agent finishes, post the final response
					// and attach feedback prompt if enabled
					const enableFeedback = config?.enableFeedback !== false;
					if (enableFeedback) {
						const feedbackPrompt = "\n\nWas this helpful? React with 👍 or 👎";
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
					const feedbackPrompt = "\n\nWas this helpful? React with 👍 or 👎";
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
}
