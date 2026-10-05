import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
	type ActionHint,
	FEEDBACK_ACTION_IDS,
	type FeedbackSignal,
	buildActionBlocks,
	buildFeedbackAckBlocks,
	buildFeedbackBlocks,
	buildFeedbackContext,
	buildFeedbackInlineKeyboard,
	emitFeedback,
	feedbackToOutcome,
	parseFeedbackAction,
	setFeedbackHandler,
} from "../feedback.ts";

describe("buildFeedbackBlocks", () => {
	test("returns divider and actions block", () => {
		const blocks = buildFeedbackBlocks("msg_123");
		expect(blocks.length).toBe(2);
		expect(blocks[0].type).toBe("divider");
		expect(blocks[1].type).toBe("actions");
	});

	test("has three feedback buttons", () => {
		const blocks = buildFeedbackBlocks("msg_123");
		expect(blocks[1].elements?.length).toBe(3);
	});

	test("includes message id in block_id", () => {
		const blocks = buildFeedbackBlocks("msg_123");
		expect(blocks[1].block_id).toBe("phantom_feedback_msg_123");
	});

	test("buttons have correct action_ids", () => {
		const blocks = buildFeedbackBlocks("msg_123");
		const elements = blocks[1].elements as Array<Record<string, unknown>>;
		const actionIds = elements.map((e) => e.action_id);
		expect(actionIds).toContain("phantom:feedback:positive");
		expect(actionIds).toContain("phantom:feedback:negative");
		expect(actionIds).toContain("phantom:feedback:partial");
	});
});

// P2.3: new tests for the Telegram inline-keyboard helper
describe("buildFeedbackInlineKeyboard (P2.3)", () => {
	test("returns a single row of three buttons", () => {
		const keyboard = buildFeedbackInlineKeyboard();
		expect(keyboard.length).toBe(1);
		expect(keyboard[0].length).toBe(3);
	});

	test("buttons have callback_data matching Slack action_ids", () => {
		const keyboard = buildFeedbackInlineKeyboard();
		const callbackData = keyboard[0].map((b) => b.callback_data);
		expect(callbackData).toContain("phantom:feedback:positive");
		expect(callbackData).toContain("phantom:feedback:negative");
		expect(callbackData).toContain("phantom:feedback:partial");
	});

	test("button labels include emoji prefixes", () => {
		const keyboard = buildFeedbackInlineKeyboard();
		const labels = keyboard[0].map((b) => b.text);
		expect(labels.some((l) => l.includes("👍"))).toBe(true);
		expect(labels.some((l) => l.includes("👎"))).toBe(true);
		expect(labels.some((l) => l.includes("🤔"))).toBe(true);
	});

	test("callback_data fits within Telegram's 64-byte limit", () => {
		const keyboard = buildFeedbackInlineKeyboard();
		for (const button of keyboard[0]) {
			expect(Buffer.byteLength(button.callback_data, "utf8")).toBeLessThanOrEqual(64);
		}
	});

	test("parseFeedbackAction works on the keyboard's callback_data", () => {
		const keyboard = buildFeedbackInlineKeyboard();
		const types = keyboard[0].map((b) => parseFeedbackAction(b.callback_data));
		expect(types).toEqual(["positive", "negative", "partial"]);
	});
});

describe("buildFeedbackAckBlocks", () => {
	test("returns positive acknowledgment", () => {
		const blocks = buildFeedbackAckBlocks("positive");
		const section = blocks[1];
		expect(section.text?.text).toContain("Thanks for the feedback");
	});

	test("returns negative acknowledgment", () => {
		const blocks = buildFeedbackAckBlocks("negative");
		const section = blocks[1];
		expect(section.text?.text).toContain("Sorry about that");
	});

	test("returns partial acknowledgment", () => {
		const blocks = buildFeedbackAckBlocks("partial");
		const section = blocks[1];
		expect(section.text?.text).toContain("work on improving");
	});

	test("returns fallback for unknown choice", () => {
		const blocks = buildFeedbackAckBlocks("unknown");
		const section = blocks[1];
		expect(section.text?.text).toContain("Feedback recorded");
	});
});

describe("buildActionBlocks", () => {
	test("returns empty array for no actions", () => {
		const blocks = buildActionBlocks([]);
		expect(blocks.length).toBe(0);
	});

	test("builds buttons from action hints", () => {
		const actions: ActionHint[] = [{ label: "Apply Fix", style: "primary" }, { label: "Skip" }];
		const blocks = buildActionBlocks(actions);
		expect(blocks.length).toBe(1);
		expect(blocks[0].type).toBe("actions");
		expect(blocks[0].elements?.length).toBe(2);
	});

	test("truncates labels to 75 chars", () => {
		const longLabel = "a".repeat(100);
		const actions: ActionHint[] = [{ label: longLabel }];
		const blocks = buildActionBlocks(actions);
		const element = blocks[0].elements?.[0] as Record<string, unknown>;
		const text = element.text as Record<string, string>;
		expect(text.text.length).toBeLessThanOrEqual(75);
	});

	test("limits to 5 buttons max", () => {
		const actions: ActionHint[] = Array.from({ length: 8 }, (_, i) => ({
			label: `Action ${i}`,
		}));
		const blocks = buildActionBlocks(actions);
		expect(blocks[0].elements?.length).toBe(5);
	});
});

describe("parseFeedbackAction", () => {
	test("parses positive feedback", () => {
		expect(parseFeedbackAction("phantom:feedback:positive")).toBe("positive");
	});

	test("parses negative feedback", () => {
		expect(parseFeedbackAction("phantom:feedback:negative")).toBe("negative");
	});

	test("parses partial feedback", () => {
		expect(parseFeedbackAction("phantom:feedback:partial")).toBe("partial");
	});

	test("returns null for non-feedback actions", () => {
		expect(parseFeedbackAction("phantom:action:0")).toBeNull();
	});

	test("returns null for invalid feedback type", () => {
		expect(parseFeedbackAction("phantom:feedback:unknown")).toBeNull();
	});
});

describe("FEEDBACK_ACTION_IDS", () => {
	test("contains all three feedback types", () => {
		expect(FEEDBACK_ACTION_IDS.length).toBe(3);
		expect(FEEDBACK_ACTION_IDS).toContain("phantom:feedback:positive");
		expect(FEEDBACK_ACTION_IDS).toContain("phantom:feedback:negative");
		expect(FEEDBACK_ACTION_IDS).toContain("phantom:feedback:partial");
	});
});

describe("feedback handler", () => {
	beforeEach(() => {
		setFeedbackHandler(null as unknown as (signal: FeedbackSignal) => void);
	});

	test("emitFeedback calls registered handler", () => {
		const handler = mock((_signal: FeedbackSignal) => {});
		setFeedbackHandler(handler);

		const signal: FeedbackSignal = {
			type: "positive",
			conversationId: "slack:C123:ts",
			messageTs: "ts",
			userId: "U123",
			source: "button",
			timestamp: Date.now(),
		};

		emitFeedback(signal);
		expect(handler).toHaveBeenCalledWith(signal);
	});

	test("emitFeedback does nothing without handler", () => {
		emitFeedback({
			type: "negative",
			conversationId: "test",
			messageTs: "ts",
			userId: "U123",
			source: "reaction",
			timestamp: Date.now(),
		});
	});
});

describe("feedbackToOutcome", () => {
	test("maps positive to success", () => {
		expect(feedbackToOutcome("positive")).toBe("success");
	});

	test("maps negative to failure", () => {
		// Regression: partial types used to fall through to success, which
		// let a thumbs-down fire the gate with a "success" outcome.
		expect(feedbackToOutcome("negative")).toBe("failure");
	});

	test("maps partial to partial, not success", () => {
		expect(feedbackToOutcome("partial")).toBe("partial");
	});
});

describe("buildFeedbackContext", () => {
	const NOW = Date.now();

	test("returns undefined for a missing entry", () => {
		expect(buildFeedbackContext(undefined, NOW)).toBeUndefined();
	});

	test("returns undefined when the entry has no responseAt", () => {
		expect(buildFeedbackContext({ user: "hi", response: "hello" }, NOW)).toBeUndefined();
	});

	test("returns undefined when the exchange is older than 24h", () => {
		const stale = { user: "hi", response: "hello", responseAt: NOW - (24 * 60 * 60 * 1000 + 1) };
		expect(buildFeedbackContext(stale, NOW)).toBeUndefined();
	});

	test("keeps an exchange right at the 24h boundary", () => {
		const entry = { response: "answer", responseAt: NOW - 24 * 60 * 60 * 1000 };
		const context = buildFeedbackContext(entry, NOW);
		expect(context?.lastResponseText).toBe("answer");
	});

	test("builds context with user text, response text, and ISO responseAt", () => {
		const entry = { user: "why did it fail?", response: "lockfile drift", responseAt: NOW };
		const context = buildFeedbackContext(entry, NOW);
		expect(context?.lastUserText).toBe("why did it fail?");
		expect(context?.lastResponseText).toBe("lockfile drift");
		expect(context?.responseAt).toBe(new Date(NOW).toISOString());
	});

	test("omits fields that are absent instead of writing empty strings", () => {
		const context = buildFeedbackContext({ response: "only response", responseAt: NOW }, NOW);
		expect(context?.lastUserText).toBeUndefined();
		expect(context?.lastResponseText).toBe("only response");
	});

	test("returns undefined when both texts are absent", () => {
		expect(buildFeedbackContext({ responseAt: NOW }, NOW)).toBeUndefined();
	});

	test("truncates texts to 4000 chars", () => {
		const long = "x".repeat(5000);
		const context = buildFeedbackContext({ user: long, response: long, responseAt: NOW }, NOW);
		expect(context?.lastUserText?.length).toBe(4000);
		expect(context?.lastResponseText?.length).toBe(4000);
	});
});
