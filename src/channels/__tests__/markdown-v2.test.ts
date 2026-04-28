import { describe, expect, test } from "bun:test";
import { escapeMarkdownV2 } from "../markdown-v2.ts";

describe("escapeMarkdownV2: spec compliance — outside-entity reserved chars", () => {
	// Per spec: _ * [ ] ( ) ~ ` > # + - = | { } . ! \ must be escaped
	test.each([
		["_", "\\_"],
		["*", "\\*"],
		["[", "\\["],
		["]", "\\]"],
		["(", "\\("],
		[")", "\\)"],
		["~", "\\~"],
		["`", "\\`"], // P5.2 fix: backtick was missing from escape regex
		[">", "\\>"],
		["#", "\\#"],
		["+", "\\+"],
		["-", "\\-"],
		["=", "\\="],
		["|", "\\|"],
		["{", "\\{"],
		["}", "\\}"],
		[".", "\\."],
		["!", "\\!"],
		["\\", "\\\\"],
	])("escapes reserved char %p as %p", (input, expected) => {
		expect(escapeMarkdownV2(input)).toBe(expected);
	});

	test("does not escape non-reserved characters", () => {
		expect(escapeMarkdownV2("Hello world")).toBe("Hello world");
		expect(escapeMarkdownV2("abc 123 XYZ")).toBe("abc 123 XYZ");
	});

	test("escapes a complex sentence with multiple reserved chars", () => {
		const input = "Hello, world! How are you?";
		// Only ! and . need escaping here
		const expected = "Hello, world\\! How are you?";
		expect(escapeMarkdownV2(input)).toBe(expected);
	});

	test("escapes URL with reserved characters", () => {
		const input = "https://example.com/path-1";
		// . and - both need escaping
		expect(escapeMarkdownV2(input)).toBe("https://example\\.com/path\\-1");
	});
});

describe("escapeMarkdownV2: code blocks (triple backtick)", () => {
	test("preserves a simple code block", () => {
		const input = "```\nhello\n```";
		expect(escapeMarkdownV2(input)).toBe("```\nhello\n```");
	});

	test("preserves a code block with language hint", () => {
		const input = "```typescript\nconst x = 5;\n```";
		// Inside the block, \ and ` would be escaped, but neither appears here.
		// The semicolon is NOT a reserved char inside the block.
		expect(escapeMarkdownV2(input)).toBe("```typescript\nconst x = 5;\n```");
	});

	test("escapes backslash inside a code block (P5.2 fix)", () => {
		// Without the fix, this fails with Telegram parse error because
		// raw \ inside a code block needs escaping.
		const input = "```\nC:\\Users\\foo\n```";
		expect(escapeMarkdownV2(input)).toBe("```\nC:\\\\Users\\\\foo\n```");
	});

	test("escapes backtick inside a code block (P5.2 fix)", () => {
		// Edge case — a code block containing a backtick (e.g., bash command
		// substitution wrapped in ```). The inner backtick must be escaped.
		const input = "```\nuse `cmd` for that\n```";
		expect(escapeMarkdownV2(input)).toBe("```\nuse \\`cmd\\` for that\n```");
	});

	test("does NOT escape MarkdownV2 reserved chars inside a code block", () => {
		// Inside pre/code, only ` and \ need escaping. Other reserved chars
		// like . ! - are literal.
		const input = "```\nfile.txt - line 1!\n```";
		expect(escapeMarkdownV2(input)).toBe("```\nfile.txt - line 1!\n```");
	});

	test("escapes outside-entity chars surrounding a code block", () => {
		const input = "Here is code:\n```\nfoo\n```\nDone!";
		expect(escapeMarkdownV2(input)).toBe("Here is code:\n```\nfoo\n```\nDone\\!");
	});

	test("handles unclosed triple backticks as literal characters (P5.2 fix)", () => {
		// Without the fix, the regex /```[\s\S]*?```/g doesn't match an
		// unclosed fence, so the literal ``` falls through to the escape
		// step — but the escape regex doesn't include `, so it stays raw
		// and Telegram fails with a parse error.
		const input = "incomplete ``` no close";
		// Expected: each ` escaped as a reserved literal
		expect(escapeMarkdownV2(input)).toBe("incomplete \\`\\`\\` no close");
	});

	test("handles multiple code blocks", () => {
		const input = "```\na\n```\ntext\n```\nb\n```";
		expect(escapeMarkdownV2(input)).toBe("```\na\n```\ntext\n```\nb\n```");
	});

	test("preserves empty code block", () => {
		const input = "``````";
		// This is `` ` ``` ` `` ``` — three opening, three closing, empty body.
		// The function detects the opener at position 0 and looks for the
		// closing ``` from position 3. It finds it at position 3. So the
		// "block" body is empty and the entity spans positions 0-5.
		expect(escapeMarkdownV2(input)).toBe("``````");
	});
});

describe("escapeMarkdownV2: inline code (single backtick)", () => {
	test("preserves a simple inline code span", () => {
		const input = "Use `foo` here";
		expect(escapeMarkdownV2(input)).toBe("Use `foo` here");
	});

	test("escapes backslash inside inline code (P5.2 fix)", () => {
		const input = "Path: `C:\\Users\\foo`";
		// Inside `, only ` and \ need escaping. The colon is literal.
		expect(escapeMarkdownV2(input)).toBe("Path: `C:\\\\Users\\\\foo`");
	});

	test("does NOT escape reserved chars inside inline code", () => {
		// `file.txt!` — period and bang are literal inside the entity
		const input = "See `file.txt!` for details.";
		expect(escapeMarkdownV2(input)).toBe("See `file.txt!` for details\\.");
	});

	test("escapes outside-entity chars around inline code", () => {
		const input = "Run `npm test` -- it works!";
		expect(escapeMarkdownV2(input)).toBe("Run `npm test` \\-\\- it works\\!");
	});

	test("handles unclosed backtick as literal escaped char (P5.2 fix)", () => {
		// "this is a stray ` here"
		// Without the fix: the regex /`[^`]+`/g doesn't match (no closing `),
		// the ` falls through to the escape step which doesn't include `, and
		// the message fails with a Telegram parse error.
		const input = "stray ` here";
		expect(escapeMarkdownV2(input)).toBe("stray \\` here");
	});

	test("handles multiple inline code spans on the same line", () => {
		const input = "Use `a` and `b` together.";
		expect(escapeMarkdownV2(input)).toBe("Use `a` and `b` together\\.");
	});

	test("handles backtick at very end of input", () => {
		const input = "trailing `";
		expect(escapeMarkdownV2(input)).toBe("trailing \\`");
	});

	test("handles two adjacent backticks (empty span) as literal", () => {
		// `` is not a valid inline code span (empty body). Treat as literal.
		const input = "empty `` here";
		// First ` has no real closing pair (the second ` is immediately after,
		// would create an empty span which is not allowed). Both treated as
		// literal escaped backticks.
		expect(escapeMarkdownV2(input)).toBe("empty \\`\\` here");
	});
});

describe("escapeMarkdownV2: code spans and code blocks combined", () => {
	test("a code block followed by an inline code span", () => {
		const input = "Block:\n```\ncode\n```\nThen `inline` here.";
		expect(escapeMarkdownV2(input)).toBe(
			"Block:\n```\ncode\n```\nThen `inline` here\\.",
		);
	});

	test("backtick-as-text after a closed code block", () => {
		const input = "```\nblock\n```\n\\`literal\\`";
		// The "\`literal\`" portion: at position 13, we have \ (escaped to \\)
		// then ` (opens inline code span). Looking for closing ` — finds it
		// at the end. The span body is "literal\" — the inner \ gets escaped
		// to \\. Result: `literal\\`. Then end of input.
		expect(escapeMarkdownV2(input)).toBe(
			"```\nblock\n```\n\\\\`literal\\\\`",
		);
	});

	test("backslash in regular text between code regions", () => {
		const input = "before \\ after";
		expect(escapeMarkdownV2(input)).toBe("before \\\\ after");
	});
});

describe("escapeMarkdownV2: realistic agent responses", () => {
	test("typical mixed-content response", () => {
		const input = "I found 3 issues in the code. Here's the first:\n```\nconst x = foo.bar(baz);\n```\nNote that `foo.bar` is deprecated.";
		const result = escapeMarkdownV2(input);
		// Sanity: the result should contain the code blocks intact and
		// have the reserved chars in the prose escaped
		expect(result).toContain("```\nconst x = foo.bar(baz);\n```"); // code block preserved
		expect(result).toContain("`foo.bar`"); // inline code preserved
		expect(result).toContain("3 issues in the code\\."); // period escaped in prose
		expect(result).toContain("Here's the first:");
		expect(result).toContain("deprecated\\.");
	});

	test("response with file paths and version numbers", () => {
		const input = "Updated src/foo.ts (was v1.2.3, now v1.2.4)";
		const expected = "Updated src/foo\\.ts \\(was v1\\.2\\.3, now v1\\.2\\.4\\)";
		expect(escapeMarkdownV2(input)).toBe(expected);
	});

	test("response with command output containing pipes and brackets", () => {
		const input = "Run: cat foo.txt | grep [a-z]";
		expect(escapeMarkdownV2(input)).toBe("Run: cat foo\\.txt \\| grep \\[a\\-z\\]");
	});

	test("response with a Markdown-style list (will render as escaped dashes)", () => {
		// Note: MarkdownV2 doesn't support markdown lists. Dashes are reserved
		// and will be escaped, rendering as literal dashes — which is the
		// correct behavior since the spec doesn't define list rendering.
		const input = "- item one\n- item two";
		expect(escapeMarkdownV2(input)).toBe("\\- item one\n\\- item two");
	});

	test("response containing JSON", () => {
		const input = '{"key": "value", "n": 42}';
		expect(escapeMarkdownV2(input)).toBe(
			'\\{"key": "value", "n": 42\\}',
		);
	});

	test("response containing a regex", () => {
		const input = "/^[a-z]+$/";
		expect(escapeMarkdownV2(input)).toBe("/^\\[a\\-z\\]\\+$/");
	});
});

describe("escapeMarkdownV2: edge cases", () => {
	test("empty string returns empty string", () => {
		expect(escapeMarkdownV2("")).toBe("");
	});

	test("single character non-reserved", () => {
		expect(escapeMarkdownV2("a")).toBe("a");
	});

	test("single character reserved", () => {
		expect(escapeMarkdownV2(".")).toBe("\\.");
	});

	test("only reserved characters", () => {
		expect(escapeMarkdownV2("...")).toBe("\\.\\.\\.");
	});

	test("input is just a single backtick", () => {
		expect(escapeMarkdownV2("`")).toBe("\\`");
	});

	test("input is just three backticks (incomplete fence)", () => {
		expect(escapeMarkdownV2("```")).toBe("\\`\\`\\`");
	});

	test("very long input is handled", () => {
		const input = "a".repeat(10_000);
		expect(escapeMarkdownV2(input)).toBe(input); // 'a' is not reserved
	});

	test("very long input with reserved chars is handled", () => {
		const input = "a.b.c.".repeat(1000); // 6000 chars, half reserved
		const result = escapeMarkdownV2(input);
		expect(result.length).toBeGreaterThan(input.length); // periods got escaped
		expect(result.includes("\\.")).toBe(true);
	});

	test("unicode characters pass through unchanged", () => {
		const input = "Hello 你好 👋 émoji";
		expect(escapeMarkdownV2(input)).toBe(input);
	});

	test("newlines are preserved", () => {
		expect(escapeMarkdownV2("line 1\nline 2")).toBe("line 1\nline 2");
	});

	test("tabs are preserved", () => {
		expect(escapeMarkdownV2("col1\tcol2")).toBe("col1\tcol2");
	});
});

describe("escapeMarkdownV2: anti-regression — the original bugs", () => {
	test("REGRESSION: stray backtick must be escaped (Bug #1)", () => {
		// The original function's regex did not include ` in the
		// outside-entity escape set. A stray backtick that didn't form a
		// pair would survive unescaped and Telegram would 400.
		expect(escapeMarkdownV2("a ` b")).toBe("a \\` b");
	});

	test("REGRESSION: code block content with backslash must be escaped (Bug #2)", () => {
		// The original function copied code blocks verbatim. Telegram requires
		// \ inside code/pre entities to be escaped as \\.
		const input = "```\nC:\\path\n```";
		expect(escapeMarkdownV2(input)).toBe("```\nC:\\\\path\n```");
	});

	test("REGRESSION: inline code content with backslash must be escaped (Bug #3)", () => {
		const input = "`\\d+`";
		// Inside the `...` span: \ → \\, but + stays literal (not reserved
		// inside pre/code entities, only ` and \ are).
		expect(escapeMarkdownV2(input)).toBe("`\\\\d+`");
	});
});
