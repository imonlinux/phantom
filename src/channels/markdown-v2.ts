/**
 * MarkdownV2 escape function for Telegram messages.
 *
 * Telegram's MarkdownV2 spec defines three escape contexts:
 *
 *   1. Outside any entity (default text):
 *      Characters _ * [ ] ( ) ~ ` > # + - = | { } . ! must be escaped with \
 *
 *   2. Inside `pre` and `code` entities (between ``` or `):
 *      Only ` and \ characters must be escaped with \
 *
 *   3. Inside (...) of inline link / custom emoji definitions:
 *      Only ) and \ must be escaped with \
 *
 * (We don't currently emit inline links from this function — the agent
 * sends bare URLs and Telegram auto-links them. So context #3 is moot.)
 *
 * The function:
 *   - Walks the input character by character (one pass)
 *   - Detects code-block starts (```), and code-span starts (single `)
 *   - Inside code regions: escapes only ` and \
 *   - Outside code regions: escapes the full reserved set including `
 *
 * Edge cases handled:
 *   - Stray (unclosed) backticks at end-of-input are escaped as ordinary chars
 *   - Code blocks may contain language hints (```typescript\n...\n```)
 *   - Backslashes already escaped in user input are double-escaped (correct
 *     per spec: any \X must become \\X to preserve the X as literal)
 */
export function escapeMarkdownV2(text: string): string {
	if (!text) return text;

	// Reserved characters outside entities.
	const OUTSIDE_RESERVED = new Set([
		"_", "*", "[", "]", "(", ")", "~", "`", ">", "#",
		"+", "-", "=", "|", "{", "}", ".", "!", "\\",
	]);
	// Reserved characters inside pre/code entities.
	const INSIDE_RESERVED = new Set(["`", "\\"]);

	let result = "";
	let i = 0;
	const n = text.length;

	while (i < n) {
		// Detect a triple-backtick code block opener.
		if (text.startsWith("```", i)) {
			// Look for the closing ```. If none, treat the opening ``` as
			// literal text — escape each character outside the entity.
			const close = text.indexOf("```", i + 3);
			if (close === -1) {
				// No closing fence — escape the literal backticks and continue.
				// Each ` is a reserved char outside an entity.
				result += "\\`\\`\\`";
				i += 3;
				continue;
			}
			// We have a complete ``` ... ``` block.
			// Emit the opening fence verbatim (it's syntax, not content).
			result += "```";
			// Escape ` and \ inside the body.
			for (let j = i + 3; j < close; j++) {
				const c = text[j];
				if (INSIDE_RESERVED.has(c)) {
					result += `\\${c}`;
				} else {
					result += c;
				}
			}
			result += "```";
			i = close + 3;
			continue;
		}

		// Detect an inline-code span: ` ... ` (no embedded backticks).
		if (text[i] === "`") {
			// Look for the closing single backtick. The body cannot contain
			// backticks (Telegram MarkdownV2 doesn't support escaped backticks
			// inside a code span — the `\` would render literally).
			let close = -1;
			for (let j = i + 1; j < n; j++) {
				if (text[j] === "`") {
					close = j;
					break;
				}
			}
			if (close === -1 || close === i + 1) {
				// No closing backtick (or empty span ``). Treat the opening
				// backtick as a literal reserved character — escape it.
				result += "\\`";
				i += 1;
				continue;
			}
			// Complete inline code span. Emit fences verbatim, escape \ inside.
			result += "`";
			for (let j = i + 1; j < close; j++) {
				const c = text[j];
				if (c === "\\") {
					result += "\\\\";
				} else {
					result += c;
				}
			}
			result += "`";
			i = close + 1;
			continue;
		}

		// Default: outside any entity. Escape if reserved.
		const c = text[i];
		if (OUTSIDE_RESERVED.has(c)) {
			result += `\\${c}`;
		} else {
			result += c;
		}
		i += 1;
	}

	return result;
}
