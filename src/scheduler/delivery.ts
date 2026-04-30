import type { SlackChannel } from "../channels/slack.ts";
import type { NextcloudChannel } from "../channels/nextcloud.ts";
import type { TelegramChannel } from "../channels/telegram.ts";
import type { ScheduledJob } from "./types.ts";

/**
 * Outcome string stored in scheduled_jobs.last_delivery_status.
 * null (column default) means "never attempted".
 * Anything returned from deliverResult is a concrete attempt outcome.
 */
export type DeliveryOutcome =
	| "delivered"
	| "skipped:channel_none"
	| "dropped:slack_channel_unset"
	| "dropped:nextcloud_channel_unset"
	| "dropped:telegram_channel_unset"
	| "dropped:owner_user_id_unset"
	| `dropped:unknown_target:${string}`
	| `error:${string}`;

export type DeliveryContext = {
	slackChannel: SlackChannel | undefined;
	nextcloudChannel: NextcloudChannel | undefined;
	telegramChannel: TelegramChannel | undefined;
	ownerUserId: string | null;
	nextcloudOwnerUsername?: string | null;
	telegramOwnerChatId?: string | null;
};

/**
 * Send the job's run text to its configured delivery target and report the
 * outcome. Every exit path returns a concrete outcome so the scheduler can
 * persist it and so operators never see a silently dropped message.
 *
 * Channel-specific delivery methods catch errors internally and return
 * `null` on failure rather than throwing. We treat a null return as an error
 * outcome so real outages surface as "error:<channel>_returned_null"
 * instead of being stamped "delivered" in last_delivery_status. The try/catch
 * remains as a belt-and-braces guard in case a future channel layer change
 * starts throwing instead.
 *
 * Target validation already happened at creation time. The runtime fallthrough
 * branch here is the safety net for the "channel configured but owner missing"
 * case and for any future target shape the validator misses.
 */
export async function deliverResult(job: ScheduledJob, text: string, ctx: DeliveryContext): Promise<DeliveryOutcome> {
	if (job.delivery.channel === "none") {
		return "skipped:channel_none";
	}

	const channel = job.delivery.channel;
	const target = job.delivery.target;

	try {
		switch (channel) {
			case "slack": {
				if (!ctx.slackChannel) {
					console.error(
						`[scheduler] Delivery dropped for job "${job.name}": Slack channel is not wired. Configure channels.yaml with slack.enabled=true, bot_token, app_token.`,
					);
					return "dropped:slack_channel_unset";
				}

				if (target === "owner") {
					if (!ctx.ownerUserId) {
						console.error(
							`[scheduler] Delivery dropped for job "${job.name}": target=owner but channels.yaml slack.owner_user_id is not configured. Set owner_user_id or use an explicit user (U...) or channel (C...) target.`,
						);
						return "dropped:owner_user_id_unset";
					}
					const ts = await ctx.slackChannel.sendDm(ctx.ownerUserId, text);
					if (ts === null) {
						console.error(
							`[scheduler] Delivery error for job "${job.name}" target=owner: Slack sendDm returned null (upstream API failure)`,
						);
						return "error:slack_returned_null";
					}
					return "delivered";
				}
				if (target.startsWith("C")) {
					const ts = await ctx.slackChannel.postToChannel(target, text);
					if (ts === null) {
						console.error(
							`[scheduler] Delivery error for job "${job.name}" target=${target}: Slack postToChannel returned null (upstream API failure)`,
						);
						return "error:slack_returned_null";
					}
					return "delivered";
				}
				if (target.startsWith("U")) {
					const ts = await ctx.slackChannel.sendDm(target, text);
					if (ts === null) {
						console.error(
							`[scheduler] Delivery error for job "${job.name}" target=${target}: Slack sendDm returned null (upstream API failure)`,
						);
						return "error:slack_returned_null";
					}
					return "delivered";
				}

				// Defensive: the creation-time validator should never let us reach here.
				console.error(`[scheduler] Delivery dropped for job "${job.name}": unknown target format: ${target}`);
				return `dropped:unknown_target:${target}`;
			}

			case "nextcloud": {
				if (!ctx.nextcloudChannel) {
					console.error(
						`[scheduler] Delivery dropped for job "${job.name}": Nextcloud channel is not wired. Configure channels.yaml with nextcloud.enabled=true.`,
					);
					return "dropped:nextcloud_channel_unset";
				}

				// Resolve "owner" target
				const username = target === "owner" ? ctx.nextcloudOwnerUsername ?? null : target;
				if (!username) {
					console.error(
						`[scheduler] Delivery dropped for job "${job.name}": target=owner but channels.yaml nextcloud.owner_username is not configured.`,
					);
					return "dropped:owner_user_id_unset";
				}

				// For Nextcloud, we send via postToNextcloud using the configured room
				const success = await ctx.nextcloudChannel.sendDirectMessage(username, text);
				if (!success) {
					console.error(
						`[scheduler] Delivery error for job "${job.name}" target=${username}: Nextcloud sendDirectMessage failed`,
					);
					return "error:nextcloud_send_failed";
				}
				return "delivered";
			}

			case "telegram": {
				if (!ctx.telegramChannel) {
					console.error(
						`[scheduler] Delivery dropped for job "${job.name}": Telegram channel is not wired. Configure channels.yaml with telegram.enabled=true.`,
					);
					return "dropped:telegram_channel_unset";
				}

				// Resolve "owner" target
				const chatId = target === "owner" ? ctx.telegramOwnerChatId ?? null : target;
				if (!chatId) {
					console.error(
						`[scheduler] Delivery dropped for job "${job.name}": target=owner but channels.yaml telegram.owner_chat_id is not configured.`,
					);
					return "dropped:owner_user_id_unset";
				}

				const numericChatId = parseInt(chatId, 10);
				const success = await ctx.telegramChannel.sendDirectMessage(numericChatId, text);
				if (!success) {
					console.error(
						`[scheduler] Delivery error for job "${job.name}" target=${chatId}: Telegram sendDirectMessage failed`,
					);
					return "error:telegram_send_failed";
				}
				return "delivered";
			}

			default:
				return `dropped:unknown_target:${channel}`;
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`[scheduler] Delivery error for job "${job.name}" channel="${channel}" target="${target}": ${msg}`);
		// Compact the error so it fits in the status column without leaking newlines.
		const compact = msg.replace(/\s+/g, " ").slice(0, 200);
		return `error:${compact}`;
	}
}
