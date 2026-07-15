/**
 * Pure formatting and classification helpers for the Email channel.
 *
 * Extracted from email.ts so that file stays under the 300-line budget.
 * These functions are stateless and have no IMAP/SMTP dependencies, so
 * they are trivially testable in isolation.
 */

/**
 * Render plain text agent output as a simple HTML body with Phantom
 * branding. Escapes HTML special chars first, then applies code block
 * and inline code styling.
 */
export function textToHtml(text: string): string {
	const html = text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\n/g, "<br>")
		.replace(
			/```([\s\S]*?)```/g,
			'<pre style="background:#f4f4f4;padding:12px;border-radius:4px;font-family:monospace;font-size:13px">$1</pre>',
		)
		.replace(
			/`([^`]+)`/g,
			'<code style="background:#f0f0f0;padding:2px 4px;border-radius:3px;font-size:13px">$1</code>',
		);

	return `
<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;font-size:14px;line-height:1.6;color:#333">
${html}
<br><br>
<div style="color:#999;font-size:12px;border-top:1px solid #eee;padding-top:8px;margin-top:16px">
${"\u2014"} Phantom, your AI co-worker
</div>
</div>`.trim();
}

/**
 * Pull the body text out of a raw RFC 822 message source. Strips HTML
 * tags and decodes a small set of common entities. Good enough for
 * agent input; not a full MIME parser.
 */
export function extractBodyText(source: string): string {
	// Simple extraction: get text after headers (double newline)
	const headerEnd = source.indexOf("\r\n\r\n");
	if (headerEnd === -1) return source;
	const body = source.slice(headerEnd + 4);

	// Strip HTML tags if present
	return body
		.replace(/<[^>]*>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.trim();
}

/**
 * Detect auto-reply messages so Phantom can ignore them. Matches the
 * common OOO / vacation / DSN phrases in subject and body combined.
 */
export function isAutoReply(subject: string, body: string): boolean {
	const autoReplyIndicators = [
		"out of office",
		"automatic reply",
		"auto-reply",
		"autoreply",
		"vacation reply",
		"delivery status notification",
		"undeliverable",
		"mailer-daemon",
	];
	const combined = `${subject} ${body}`.toLowerCase();
	return autoReplyIndicators.some((indicator) => combined.includes(indicator));
}
