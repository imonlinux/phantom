/**
 * Feedback button handling and evolution engine wiring.
 * Renders feedback buttons after agent responses and routes
 * button clicks to the evolution engine as positive/negative signals.
 *
 * The Cardinal Rule applies: TypeScript renders the mechanism,
 * the agent decides what buttons to show via response hints.
 */

export type FeedbackSignal = {
	type: "positive" | "negative" | "partial";
	conversationId: string;
	messageTs: string;
	userId: string;
	source: "button" | "reaction";
	timestamp: number;
};

export type FeedbackHandler = (signal: FeedbackSignal) => void;

let feedbackHandler: FeedbackHandler | null = null;
const FEEDBACK_ACTION_PREFIX = "phantom:feedback:";

export function setFeedbackHandler(handler: FeedbackHandler): void {
	feedbackHandler = handler;
}

export function getFeedbackHandler(): FeedbackHandler | null {
	return feedbackHandler;
}

export function emitFeedback(signal: FeedbackSignal): void {
	feedbackHandler?.(signal);
}

/**
 * Build Slack Block Kit feedback buttons.
 * Appended after the agent's response message.
 */
export function buildFeedbackBlocks(messageId: string): SlackBlock[] {
	return [
		{ type: "divider" },
		{
			type: "actions",
			block_id: `phantom_feedback_${messageId}`,
			elements: [
				{
					type: "button",
					text: { type: "plain_text", text: "Helpful", emoji: true },
					action_id: `${FEEDBACK_ACTION_PREFIX}positive`,
					style: "primary",
					value: messageId,
				},
				{
					type: "button",
					text: { type: "plain_text", text: "Not helpful", emoji: true },
					action_id: `${FEEDBACK_ACTION_PREFIX}negative`,
					style: "danger",
					value: messageId,
				},
				{
					type: "button",
					text: { type: "plain_text", text: "Could be better", emoji: true },
					action_id: `${FEEDBACK_ACTION_PREFIX}partial`,
					value: messageId,
				},
			],
		},
	];
}

/**
 * Build the updated blocks after a user clicks a feedback button.
 */
export function buildFeedbackAckBlocks(choice: string): SlackBlock[] {
	const labels: Record<string, string> = {
		positive: "Thanks for the feedback!",
		negative: "Sorry about that. I'll try to do better.",
		partial: "Thanks - I'll work on improving.",
	};
	return [
		{ type: "divider" },
		{
			type: "section",
			text: {
				type: "mrkdwn",
				text: `_${labels[choice] ?? "Feedback recorded."}_`,
			},
		},
	];
}

export function buildActionBlocks(actions: ActionHint[]): SlackBlock[] {
	if (actions.length === 0) return [];
	const elements = actions.slice(0, 5).map((action, i) => ({
		type: "button" as const,
		text: { type: "plain_text" as const, text: action.label.slice(0, 75) },
		action_id: `phantom:action:${i}`,
		value: JSON.stringify({ label: action.label, payload: action.payload }),
		...(action.style ? { style: action.style } : {}),
	}));
	return [
		{
			type: "actions",
			block_id: "phantom_actions",
			elements,
		},
	];
}

export function parseFeedbackAction(actionId: string): "positive" | "negative" | "partial" | null {
	if (!actionId.startsWith(FEEDBACK_ACTION_PREFIX)) return null;
	const type = actionId.slice(FEEDBACK_ACTION_PREFIX.length);
	if (type === "positive" || type === "negative" || type === "partial") return type;
	return null;
}

export const FEEDBACK_ACTION_IDS = [
	`${FEEDBACK_ACTION_PREFIX}positive`,
	`${FEEDBACK_ACTION_PREFIX}negative`,
	`${FEEDBACK_ACTION_PREFIX}partial`,
];

/**
 * P2.3: Telegram inline keyboard for feedback buttons.
 *
 * Returns the structure passed as `reply_markup.inline_keyboard` to
 * Telegram's sendMessage / editMessageReplyMarkup. The callback_data
 * matches Slack's action_id format so parseFeedbackAction works on both
 * channels uniformly.
 *
 * Telegram callback_data has a hard 64-byte limit; the message context
 * (chat_id, message_id) comes from the callback_query payload, so we
 * don't need to encode it in the data string itself.
 */
export type TelegramInlineKeyboardButton = {
	text: string;
	callback_data: string;
};

export function buildFeedbackInlineKeyboard(): TelegramInlineKeyboardButton[][] {
	return [
		[
			{ text: "👍 Helpful", callback_data: `${FEEDBACK_ACTION_PREFIX}positive` },
			{ text: "👎 Not helpful", callback_data: `${FEEDBACK_ACTION_PREFIX}negative` },
			{ text: "🤔 Could be better", callback_data: `${FEEDBACK_ACTION_PREFIX}partial` },
		],
	];
}

export type ActionHint = {
	label: string;
	payload?: string;
	style?: "primary" | "danger";
};

export type SlackBlock = {
	type: string;
	block_id?: string;
	text?: { type: string; text: string };
	elements?: Array<Record<string, unknown>>;
};
