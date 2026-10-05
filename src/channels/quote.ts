/**
 * Quote-reply passthrough shared by the Telegram and Nextcloud Talk
 * adapters. Both platforms deliver the full parent message on a reply
 * (reply_to_message / inReplyTo), but the agent only ever received the
 * new message's text, so reply-quotes arrived as contextless text.
 * The parent is prepended as a bounded quoted block instead.
 */

export const MAX_QUOTED_TEXT_LENGTH = 500;

/**
 * Formats a quoted parent message for prepending to the inbound text.
 * Multi-line parents are rendered as "> " blockquote lines so the body
 * stays visually distinct from the user's own message.
 */
export function formatQuotedBlock(
	name: string,
	rawText: string | undefined | null,
	missingTextNote = "(no text)",
): string {
	const label = name?.trim() || "unknown";
	const body = (rawText ?? "").trim();
	if (body.length === 0) {
		return `[Quoting ${label}: ${missingTextNote}]`;
	}
	let bounded = body;
	if (bounded.length > MAX_QUOTED_TEXT_LENGTH) {
		bounded = `${bounded.slice(0, MAX_QUOTED_TEXT_LENGTH)}...`;
	}
	const quoted = bounded
		.split("\n")
		.map((line) => `> ${line}`)
		.join("\n");
	return `[Quoting ${label}]\n${quoted}`;
}
