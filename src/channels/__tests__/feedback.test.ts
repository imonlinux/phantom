import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
	type ActionHint,
	FEEDBACK_ACTION_IDS,
	type FeedbackSignal,
	buildActionBlocks,
	buildFeedbackAckBlocks,
	buildFeedbackBlocks,
	buildFeedbackInlineKeyboard,
	emitFeedback,
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
