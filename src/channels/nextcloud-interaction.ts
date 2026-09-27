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
 * - Working text (progressive updates): a transient placeholder posted via
 *   the service-account USER chat API, edited with tool activity while the
 *   turn runs, and deleted once the bot response is delivered. The Bot API
 *   itself still carries no message ID and has no edit endpoint, so the
 *   placeholder must come from the service account (Talk 20+ user API:
 *   edit-messages/delete-messages). While working text is active the emoji
 *   ladder is suppressed — the placeholder carries the state, and Talk
 *   renders every bot reaction change as a "Deleted user" system message.
 *   Errors keep the ⚠ reaction so failed turns stay identifiable.
 * - Feedback mechanism: "Was this helpful? React with 👍, ❤️, or ✅ (yes) or 👎/❌ (no)"
 * - Thread awareness: responses follow the conversation's Talk thread when
 *   the session is thread-scoped (Talk 24+)
 *
 * Nextcloud limitations (vs Telegram):
 * - No inline keyboards → use reaction-based feedback instead
 * - No typing indicators: typing state only travels over Talk's signaling
 *   websocket, which has no REST surface the service account could use
 *
 * Configuration options (from NextcloudChannelConfig):
 * - enableFeedback: Enable feedback collection via reactions (default: true)
 * - enableProgressiveUpdates: Enable working text (requires service account)
 * - progressiveUpdateThrottleMs: Minimum interval between placeholder edits
 */

import type { ChannelInteractionFactory, ChannelInteractionInstance } from "./interaction-adapter.ts";
import { registerInFlightMessage, unregisterInFlightMessage } from "./interrupt.ts";
import type { NextcloudChannel } from "./nextcloud.ts";
import { type ProgressStream, createProgressStream, formatToolActivity } from "./progress-stream.ts";
import {
	type StatusEmojis,
	type StatusReactionController,
	createStatusReactionController,
} from "./status-reactions.ts";
import type { InboundMessage } from "./types.ts";

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
		enableProgressiveUpdates?: boolean;
		progressiveUpdateThrottleMs?: number;
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

		// Working text needs the user chat API, which needs the service
		// account. Without it, fall back to the reaction ladder.
		const workingText = Boolean(config?.enableProgressiveUpdates) && nc.hasServiceAccount();

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
		// The reaction ladder runs in both modes: the emoji on the owner's
		// message is the glanceable state, the working-text placeholder (tool
		// turns only) is the detailed activity log.
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
		const deliverText = async (text: string): Promise<boolean> => nc.postToNextcloud(rt, text, undefined, threadId);

		// Working text: the placeholder lifecycle. postChatMessage is the one
		// send path that returns a real message ID (user API), which the
		// ProgressStream then edits and this closure deletes at delivery time.
		// The placeholder posts lazily on the first tool activity, so short
		// conversational turns leave no placeholder and no delete tombstone.
		let placeholderId: number | null = null;
		let placeholderSettled = false;
		const settlePlaceholder = async (finalText: string | null): Promise<void> => {
			if (placeholderSettled) return;
			placeholderSettled = true;
			if (placeholderId === null) return;
			if (finalText === null) {
				await nc.deleteChatMessage(rt, placeholderId);
			} else {
				await nc.editChatMessage(rt, placeholderId, finalText);
			}
		};

		const progressStream: ProgressStream | undefined = workingText
			? createProgressStream({
					adapter: {
						postMessage: async (text) => {
							const id = await nc.postChatMessage(rt, text, { silent: true, threadId });
							if (placeholderSettled) {
								// The turn settled while this lazy start was still in
								// flight; delete the orphan instead of adopting it.
								if (id !== null) await nc.deleteChatMessage(rt, id);
								return "";
							}
							placeholderId = id;
							return id !== null ? String(id) : "";
						},
						updateMessage: async (msgId, updatedText) => {
							const numericId = Number(msgId);
							if (Number.isNaN(numericId)) return;
							await nc.editChatMessage(rt, numericId, updatedText);
						},
					},
					// finish() only stops the throttle timer here; delivery settles
					// the placeholder itself (delete on success, fold-over on failure)
					onFinish: async () => {},
					header: "⏳ Working on it...",
					throttleMs: config?.progressiveUpdateThrottleMs,
					onError: (err) => {
						const errMsg = err instanceof Error ? err.message : String(err);
						console.warn(`[nextcloud] Working text error: ${errMsg}`);
					},
				})
			: undefined;

		// First tool activity is what makes the placeholder worth posting, so
		// the stream starts then, not at turn start. The flag is set before
		// the await so concurrent tool events cannot double-post; events that
		// land while the post is in flight are queued as dirty lines and flush
		// once the message ID exists.
		let progressStarted = false;
		const startProgressOnFirstActivity = async (tool: string, summary: string): Promise<void> => {
			if (!progressStream) return;
			if (!progressStarted) {
				progressStarted = true;
				await progressStream.start();
			}
			progressStream.addToolActivity(tool, summary);
		};

		return {
			statusReactions,
			progressStream,

			onRuntimeEvent(event): void {
				switch (event.type) {
					case "thinking":
						statusReactions.setThinking();
						break;
					case "tool_use":
						statusReactions.setTool(event.tool);
						void startProgressOnFirstActivity(event.tool, formatToolActivity(event.tool, event.input));
						break;
					case "error":
						statusReactions.setError();
						break;
				}
			},

			async onTurnEnd(): Promise<void> {
				// Placeholder settling happens in deliverResponse, after the
				// response has actually been posted (or failed to post)
			},

			async deliverResponse({ text, attachments }): Promise<boolean> {
				// Outbound files are room-shared so Talk posts the file_shared
				// chat message; the returned note (link/folder/failed) may be
				// empty when every file rode the room share.
				let fullText = text;
				if (attachments && attachments.length > 0) {
					fullText += await nc.uploadTalkAttachments(rt, attachments);
				}
				const enableFeedback = config?.enableFeedback !== false;
				const body = enableFeedback
					? `${fullText}\n\n💡 Was this helpful? React with 👍, ❤️, or ✅ (yes) or 👎/❌ (no)`
					: fullText;
				const posted = await deliverText(body);

				if (progressStream) {
					// Stop any pending throttle flush before settling
					await progressStream.finish("");
					if (posted) {
						await settlePlaceholder(null);
					} else {
						// Delivery failed: fold the response into the placeholder so
						// the turn still leaves content behind instead of deleting
						// everything. Unconditional so an in-flight lazy start is
						// still marked settled and its post gets deleted.
						await settlePlaceholder(body);
					}
				}
				return true;
			},

			dispose(): void {
				unregisterInFlightMessage("nextcloud", mid);
				statusReactions.dispose();
				// Safety net: never leave a placeholder behind if delivery never
				// ran (early return, throw in the orchestration, etc.). Marking
				// settled even with no placeholder also orphans an in-flight
				// lazy start into deleting its own post.
				if (progressStream) {
					void settlePlaceholder(null).catch(() => {});
				}
			},
		};
	};
}
