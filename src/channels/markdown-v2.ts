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

/**
 * P5.3: Maximum Telegram message length (4096 chars)
 */
export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

/**
 * P5.3: Split long text into chunks ≤ TELEGRAM_MAX_MESSAGE_LENGTH after
 * MarkdownV2 escaping. Handles code blocks as atomic units.
 *
 * Tokenization:
 * - Code blocks (triple-backtick fences) are atomic — never split internally
 * - Prose paragraphs are split greedily on paragraph boundaries
 * - Over-limit prose paragraphs: sentence > word > hard-cut boundaries
 *
 * @param text Raw text to split and escape
 * @param limit Telegram message length limit (default TELEGRAM_MAX_MESSAGE_LENGTH)
 * @param maxChunks Maximum number of chunks to emit (default 5)
 * @returns Array of escaped chunks, each ≤ limit
 */
export function splitForTelegram(
	text: string,
	limit = TELEGRAM_MAX_MESSAGE_LENGTH,
	maxChunks = 5,
): string[] {
	// Helper: escape and check if fits
	const fitsLimit = (chunk: string): boolean => {
		const escaped = escapeMarkdownV2(chunk);
		return escaped.length <= limit;
	};

	// 1. If whole text fits, return escaped
	if (fitsLimit(text)) {
		return [escapeMarkdownV2(text)];
	}

	// 2. Tokenize into atoms: code blocks (atomic) + prose paragraphs
	const atoms: string[] = [];
	const codeBlockRegex = /```[\s\S]*?```/g;
	let lastIndex = 0;
	let match;

	// Extract code blocks as atomic units
	while ((match = codeBlockRegex.exec(text)) !== null) {
		// Text before code block: split into prose paragraphs
		if (match.index > lastIndex) {
			const beforeText = text.slice(lastIndex, match.index);
			const paragraphs = beforeText.split(/\n\n+/);
			atoms.push(...paragraphs);
		}
		// Code block as atomic unit
		atoms.push(match[0]);
		lastIndex = match.index + match[0].length;
	}
	// Remaining text after last code block
	if (lastIndex < text.length) {
		const remainingText = text.slice(lastIndex);
		const paragraphs = remainingText.split(/\n\n+/);
		atoms.push(...paragraphs);
	}

	// 3. Greedily pack atoms into chunks
	const chunks: string[] = [];
	const escapedChunks: string[] = [];

	for (const atom of atoms) {
		// Check if adding this atom would exceed limit
		const testChunk =
			chunks.length > 0 ? chunks[chunks.length - 1] + "\n\n" + atom : atom;

		if (fitsLimit(testChunk)) {
			// Add to current chunk
			if (chunks.length > 0) {
				chunks[chunks.length - 1] = testChunk;
			} else {
				chunks.push(atom);
			}
		} else {
			// Current chunk full, finalize it and start new
			if (chunks.length > 0) {
				escapedChunks.push(escapeMarkdownV2(chunks[chunks.length - 1]));
			}

			// Check if this single atom exceeds limit
			if (!fitsLimit(atom)) {
				if (atom.startsWith("```")) {
					// Code block exceeds limit — known limitation
					console.warn(
						`[telegram] Code block exceeds ${limit} chars after escape; ` +
							"sending over-limit (parse-error fallback may trigger)",
					);
					// Emit it anyway; parse-error fallback will handle rejection
					const escaped = escapeMarkdownV2(atom);
					escapedChunks.push(escaped);
				} else {
					// Prose paragraph exceeds limit — split further
					// splitProseParagraph returns escaped chunks, add them directly
					const subChunks = splitProseParagraph(atom, limit);
					escapedChunks.push(...subChunks);
				}
			} else {
				// Atom fits within limit, start a new chunk with it
				chunks.push(atom);
			}
		}
	}

	// Finalize remaining chunks
	for (const chunk of chunks) {
		escapedChunks.push(escapeMarkdownV2(chunk));
	}

	// 4. Apply max chunks cap
	const cappedChunks = escapedChunks.slice(0, maxChunks);
	if (escapedChunks.length > maxChunks) {
		const lastChunk = cappedChunks[cappedChunks.length - 1];
		cappedChunks[cappedChunks.length - 1] =
			lastChunk + "\n\n...response truncated, see logs for full output";
	}

	return cappedChunks.length > 0 ? cappedChunks : [escapeMarkdownV2(text).slice(0, limit)];
}

/**
 * Helper: split prose paragraph that exceeds limit
 * Tries sentence > word > hard-cut boundaries
 * Returns already-escaped chunks ready to send
 */
function splitProseParagraph(text: string, limit: number): string[] {
	const chunks: string[] = [];

	// Try sentence boundaries first
	const sentences = text.split(/(?<=[.!?])\s+/);
	let currentChunk = "";

	for (const sentence of sentences) {
		const testChunk = currentChunk + (currentChunk ? " " : "") + sentence;
		if (escapeMarkdownV2(testChunk).length <= limit) {
			currentChunk = testChunk;
		} else {
			if (currentChunk) {
				chunks.push(escapeMarkdownV2(currentChunk));
			}
			currentChunk = sentence;
		}
	}
	if (currentChunk) {
		chunks.push(escapeMarkdownV2(currentChunk));
	}

	// If sentence splitting didn't help, try word boundaries
	if (chunks.length === 1 && chunks[0].length > limit) {
		const words = text.split(/\s+/);
		const wordChunks: string[] = [];
		let currentWordChunk = "";
		let currentEscapedChunk = "";

		for (const word of words) {
			const testChunk = currentWordChunk + (currentWordChunk ? " " : "") + word;
			const testEscaped = escapeMarkdownV2(testChunk);
			if (testEscaped.length <= limit) {
				currentWordChunk = testChunk;
				currentEscapedChunk = testEscaped;
			} else {
				if (currentWordChunk) {
					wordChunks.push(currentEscapedChunk);
				}
				currentWordChunk = word;
				currentEscapedChunk = escapeMarkdownV2(word);
			}
		}
		if (currentWordChunk) {
			wordChunks.push(currentEscapedChunk);
		}
		return wordChunks;
	}

	return chunks;
}
