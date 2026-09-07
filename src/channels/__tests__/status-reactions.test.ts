import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
	DEFAULT_EMOJIS,
	type ReactionAdapter,
	createStatusReactionController,
	resolveToolEmoji,
} from "../status-reactions.ts";

// Shared mock adapter state, hoisted to module scope so the stall-escalation
// and clear describe blocks can reuse the same fixture.
let addCalls: string[];
let removeCalls: string[];
let adapter: ReactionAdapter;

beforeEach(() => {
	addCalls = [];
	removeCalls = [];
	adapter = {
		addReaction: mock(async (emoji: string) => {
			addCalls.push(emoji);
		}),
		removeReaction: mock(async (emoji: string) => {
			removeCalls.push(emoji);
		}),
	};
});

describe("resolveToolEmoji", () => {
	test("returns coding emoji for read tool", () => {
		expect(resolveToolEmoji("Read", DEFAULT_EMOJIS)).toBe("computer");
	});

	test("returns coding emoji for bash tool", () => {
		expect(resolveToolEmoji("Bash", DEFAULT_EMOJIS)).toBe("computer");
	});

	test("returns web emoji for web_search", () => {
		expect(resolveToolEmoji("WebSearch", DEFAULT_EMOJIS)).toBe("globe_with_meridians");
	});

	test("returns web emoji for web_fetch", () => {
		expect(resolveToolEmoji("web_fetch", DEFAULT_EMOJIS)).toBe("globe_with_meridians");
	});

	test("returns generic tool emoji for unknown tools", () => {
		expect(resolveToolEmoji("CustomTool", DEFAULT_EMOJIS)).toBe("wrench");
	});

	test("returns generic tool emoji for undefined", () => {
		expect(resolveToolEmoji(undefined, DEFAULT_EMOJIS)).toBe("wrench");
	});

	test("returns generic tool emoji for empty string", () => {
		expect(resolveToolEmoji("", DEFAULT_EMOJIS)).toBe("wrench");
	});
});

describe("createStatusReactionController", () => {
	test("setQueued fires immediately with eyes emoji", async () => {
		const controller = createStatusReactionController({
			adapter,
			timing: { debounceMs: 0, stallSoftMs: 99999, stallHardMs: 99999 },
		});
		controller.setQueued();
		// Allow promise chain to flush
		await new Promise((r) => setTimeout(r, 50));
		expect(addCalls).toContain("eyes");
		controller.dispose();
	});

	test("setDone fires done emoji and marks finished", async () => {
		const controller = createStatusReactionController({
			adapter,
			timing: { debounceMs: 0, stallSoftMs: 99999, stallHardMs: 99999 },
		});
		await controller.setDone();
		expect(addCalls).toContain("white_check_mark");
		controller.dispose();
	});

	test("setError fires error emoji and marks finished", async () => {
		const controller = createStatusReactionController({
			adapter,
			timing: { debounceMs: 0, stallSoftMs: 99999, stallHardMs: 99999 },
		});
		await controller.setError();
		expect(addCalls).toContain("warning");
		controller.dispose();
	});

	test("setThinking transitions to brain emoji", async () => {
		const controller = createStatusReactionController({
			adapter,
			timing: { debounceMs: 0, stallSoftMs: 99999, stallHardMs: 99999 },
		});
		controller.setThinking();
		await new Promise((r) => setTimeout(r, 50));
		expect(addCalls).toContain("brain");
		controller.dispose();
	});

	test("setTool resolves correct emoji for tool type", async () => {
		const controller = createStatusReactionController({
			adapter,
			timing: { debounceMs: 0, stallSoftMs: 99999, stallHardMs: 99999 },
		});
		controller.setTool("Bash");
		await new Promise((r) => setTimeout(r, 50));
		expect(addCalls).toContain("computer");
		controller.dispose();
	});

	test("removes previous emoji when transitioning", async () => {
		const controller = createStatusReactionController({
			adapter,
			timing: { debounceMs: 0, stallSoftMs: 99999, stallHardMs: 99999 },
		});
		controller.setQueued();
		await new Promise((r) => setTimeout(r, 50));
		controller.setThinking();
		await new Promise((r) => setTimeout(r, 50));
		// Should have removed "eyes" before adding "brain"
		expect(removeCalls).toContain("eyes");
		controller.dispose();
	});

	test("does not fire after done", async () => {
		const controller = createStatusReactionController({
			adapter,
			timing: { debounceMs: 0, stallSoftMs: 99999, stallHardMs: 99999 },
		});
		await controller.setDone();
		const callsBeforeThinking = addCalls.length;
		controller.setThinking();
		await new Promise((r) => setTimeout(r, 50));
		expect(addCalls.length).toBe(callsBeforeThinking);
		controller.dispose();
	});

	test("dispose cleans up without errors", () => {
		const controller = createStatusReactionController({
			adapter,
			timing: { debounceMs: 0, stallSoftMs: 99999, stallHardMs: 99999 },
		});
		controller.setQueued();
		controller.dispose();
		// Should not throw
	});

	test("handles adapter errors gracefully", async () => {
		let errorCaught = false;
		const failingAdapter: ReactionAdapter = {
			addReaction: async () => {
				throw new Error("API error");
			},
			removeReaction: async () => {
				throw new Error("API error");
			},
		};
		const controller = createStatusReactionController({
			adapter: failingAdapter,
			timing: { debounceMs: 0, stallSoftMs: 99999, stallHardMs: 99999 },
			onError: () => {
				errorCaught = true;
			},
		});
		controller.setQueued();
		await new Promise((r) => setTimeout(r, 50));
		expect(errorCaught).toBe(true);
		controller.dispose();
	});

	test("custom emojis override defaults", async () => {
		const controller = createStatusReactionController({
			adapter,
			emojis: { queued: "wave" },
			timing: { debounceMs: 0, stallSoftMs: 99999, stallHardMs: 99999 },
		});
		controller.setQueued();
		await new Promise((r) => setTimeout(r, 50));
		expect(addCalls).toContain("wave");
		controller.dispose();
	});
});

describe("stall escalation (issue #1: hung-turn oscillator)", () => {
	test("escalates to stallHard once and then stays silent", async () => {
		let callCount = 0;
		const countingAdapter: ReactionAdapter = {
			addReaction: mock(async () => {
				callCount++;
			}),
			removeReaction: mock(async () => {
				callCount++;
			}),
		};
		const controller = createStatusReactionController({
			adapter: countingAdapter,
			timing: { debounceMs: 0, stallSoftMs: 40, stallHardMs: 80 },
		});

		// t=0: queued fires immediately (1 call)
		controller.setQueued();
		// t=60: stallSoft fired at t=40 (remove eyes + add hourglass = 3 calls)
		await new Promise((r) => setTimeout(r, 60));
		expect(callCount).toBe(3);
		// t=120: stallHard fired at t=80 (remove hourglass + add exclamation = 5 calls)
		await new Promise((r) => setTimeout(r, 60));
		expect(callCount).toBe(5);

		// The old implementation re-armed each stall timer from the other,
		// flipping the two emojis forever on a turn that never finishes.
		// The ladder must be terminal: no further calls.
		await new Promise((r) => setTimeout(r, 250));
		expect(callCount).toBe(5);
		controller.dispose();
	});

	test("runtime transitions re-arm the stall ladder", async () => {
		const controller = createStatusReactionController({
			adapter,
			timing: { debounceMs: 0, stallSoftMs: 40, stallHardMs: 80 },
		});
		controller.setQueued();
		await new Promise((r) => setTimeout(r, 30));
		// Reset the ladder at t=30: soft now fires at t=70
		controller.setThinking();
		await new Promise((r) => setTimeout(r, 60));
		expect(addCalls).toContain("hourglass_flowing_sand");
		controller.dispose();
	});
});

describe("clear (issue #1: no terminal emoji on Talk)", () => {
	test("clear removes the current reaction and finishes", async () => {
		const controller = createStatusReactionController({
			adapter,
			timing: { debounceMs: 0, stallSoftMs: 99999, stallHardMs: 99999 },
		});
		controller.setQueued();
		await new Promise((r) => setTimeout(r, 50));
		await controller.clear();
		expect(removeCalls).toContain("eyes");
		const callsAfterClear = addCalls.length + removeCalls.length;
		controller.setThinking();
		await new Promise((r) => setTimeout(r, 50));
		expect(addCalls.length + removeCalls.length).toBe(callsAfterClear);
		controller.dispose();
	});

	test("clear with no active reaction is a no-op", async () => {
		const controller = createStatusReactionController({
			adapter,
			timing: { debounceMs: 0, stallSoftMs: 99999, stallHardMs: 99999 },
		});
		await controller.clear();
		expect(addCalls).toHaveLength(0);
		expect(removeCalls).toHaveLength(0);
	});
});
