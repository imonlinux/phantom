import { describe, expect, mock, test } from "bun:test";
import { NEXTCLOUD_EMOJIS, createNextcloudInteractionFactory } from "../nextcloud-interaction.ts";
import type { InboundMessage } from "../types.ts";

function makeMockNextcloudChannel() {
	const calls = {
		setReaction: [] as Array<{ token: string; messageId: number; emoji: string; add: boolean }>,
		postToNextcloud: [] as Array<{ token: string; text: string }>,
	};
	const channel = {
		setReaction: mock(async (token: string, messageId: number, emoji: string, add: boolean) => {
			calls.setReaction.push({ token, messageId, emoji, add });
		}),
		postToNextcloud: mock(async (token: string, text: string) => {
			calls.postToNextcloud.push({ token, text });
		}),
	};
	return {
		channel: channel as unknown as Parameters<typeof createNextcloudInteractionFactory>[0],
		calls,
	};
}

function makeNextcloudMessage(metadata: Record<string, unknown> = {}): InboundMessage {
	return {
		id: "msg-id",
		channelId: "nextcloud",
		conversationId: "nextcloud:room1:42",
		senderId: "user1",
		text: "hello",
		timestamp: new Date(),
		metadata: {
			nextcloudRoomToken: "room1",
			nextcloudMessageId: 42,
			...metadata,
		},
	};
}

describe("NEXTCLOUD_EMOJIS", () => {
	test("uses ⚠ without VS-16 (Fix #8)", () => {
		expect(NEXTCLOUD_EMOJIS.error).toBe("\u26A0");
		expect(NEXTCLOUD_EMOJIS.error).not.toMatch(/\uFE0F/);
	});

	test("provides all StatusEmojis fields", () => {
		expect(NEXTCLOUD_EMOJIS.queued).toBeDefined();
		expect(NEXTCLOUD_EMOJIS.thinking).toBeDefined();
		expect(NEXTCLOUD_EMOJIS.tool).toBeDefined();
		expect(NEXTCLOUD_EMOJIS.coding).toBeDefined();
		expect(NEXTCLOUD_EMOJIS.web).toBeDefined();
		expect(NEXTCLOUD_EMOJIS.done).toBeDefined();
		expect(NEXTCLOUD_EMOJIS.error).toBeDefined();
		expect(NEXTCLOUD_EMOJIS.stallSoft).toBeDefined();
		expect(NEXTCLOUD_EMOJIS.stallHard).toBeDefined();
	});
});

describe("createNextcloudInteractionFactory", () => {
	test("returns null when nextcloudChannel is null", () => {
		const factory = createNextcloudInteractionFactory(null);
		expect(factory(makeNextcloudMessage())).toBeNull();
	});

	test("returns null for non-nextcloud messages", () => {
		const { channel } = makeMockNextcloudChannel();
		const factory = createNextcloudInteractionFactory(channel);

		const slackMsg: InboundMessage = {
			id: "x",
			channelId: "slack",
			conversationId: "slack:C:t",
			senderId: "u",
			text: "hi",
			timestamp: new Date(),
			metadata: { slackChannel: "C", slackMessageTs: "t" },
		};
		expect(factory(slackMsg)).toBeNull();
	});

	test("returns null for nextcloud messages without metadata", () => {
		const { channel } = makeMockNextcloudChannel();
		const factory = createNextcloudInteractionFactory(channel);

		const noMeta: InboundMessage = {
			id: "x",
			channelId: "nextcloud",
			conversationId: "nextcloud:room:42",
			senderId: "u",
			text: "hi",
			timestamp: new Date(),
		};
		expect(factory(noMeta)).toBeNull();
	});

	test("returns null when roomToken is missing", () => {
		const { channel } = makeMockNextcloudChannel();
		const factory = createNextcloudInteractionFactory(channel);

		const noToken = makeNextcloudMessage({ nextcloudRoomToken: undefined });
		expect(factory(noToken)).toBeNull();
	});

	test("returns null when messageId is missing", () => {
		const { channel } = makeMockNextcloudChannel();
		const factory = createNextcloudInteractionFactory(channel);

		const noMessageId = makeNextcloudMessage({ nextcloudMessageId: undefined });
		expect(factory(noMessageId)).toBeNull();
	});

	test("creates an instance with statusReactions when metadata is complete", () => {
		const { channel } = makeMockNextcloudChannel();
		const factory = createNextcloudInteractionFactory(channel);

		const instance = factory(makeNextcloudMessage());
		expect(instance).not.toBeNull();
		expect(instance?.statusReactions).toBeDefined();
		expect(instance?.progressStream).toBeUndefined();
	});

	// Stale since Phase 2: deliverResponse IS defined and posts directly via
	// the channel; the old assertion expected the router.send fallback.
	test("deliverResponse posts the final text via the channel (Phase 2)", async () => {
		const { channel, calls } = makeMockNextcloudChannel();
		const factory = createNextcloudInteractionFactory(channel, { enableFeedback: false });

		const instance = factory(makeNextcloudMessage());
		const delivered = await instance?.deliverResponse?.({ text: "final answer", isError: false });
		expect(delivered).toBe(true);
		expect(calls.postToNextcloud).toEqual([{ token: "room1", text: "final answer" }]);
	});

	test("setQueued fires the configured queued emoji on instance creation", async () => {
		const { channel, calls } = makeMockNextcloudChannel();
		const factory = createNextcloudInteractionFactory(channel);

		factory(makeNextcloudMessage());
		await new Promise((r) => setTimeout(r, 50));
		const queuedCall = calls.setReaction.find((c) => c.emoji === NEXTCLOUD_EMOJIS.queued && c.add === true);
		expect(queuedCall).toBeDefined();
		expect(queuedCall?.token).toBe("room1");
		expect(queuedCall?.messageId).toBe(42);
	});

	test("onRuntimeEvent thinking transitions to brain emoji", async () => {
		const { channel, calls } = makeMockNextcloudChannel();
		const factory = createNextcloudInteractionFactory(channel);

		const instance = factory(makeNextcloudMessage());
		instance?.onRuntimeEvent?.({ type: "thinking" });
		await new Promise((r) => setTimeout(r, 600));
		const thinkingCall = calls.setReaction.find((c) => c.emoji === NEXTCLOUD_EMOJIS.thinking && c.add === true);
		expect(thinkingCall).toBeDefined();
	});

	test("onRuntimeEvent tool_use transitions to a tool emoji", async () => {
		const { channel, calls } = makeMockNextcloudChannel();
		const factory = createNextcloudInteractionFactory(channel);

		const instance = factory(makeNextcloudMessage());
		instance?.onRuntimeEvent?.({
			type: "tool_use",
			tool: "Read",
			input: { file_path: "/x.ts" },
		});
		await new Promise((r) => setTimeout(r, 600));
		// Read maps to coding via resolveToolEmoji
		const toolCall = calls.setReaction.find((c) => c.emoji === NEXTCLOUD_EMOJIS.coding && c.add === true);
		expect(toolCall).toBeDefined();
	});

	test("onRuntimeEvent error transitions to error emoji (⚠ without VS-16)", async () => {
		const { channel, calls } = makeMockNextcloudChannel();
		const factory = createNextcloudInteractionFactory(channel);

		const instance = factory(makeNextcloudMessage());
		instance?.onRuntimeEvent?.({ type: "error", message: "boom" });
		await new Promise((r) => setTimeout(r, 50));
		const errCall = calls.setReaction.find((c) => c.emoji === "\u26A0" && c.add === true);
		expect(errCall).toBeDefined();
	});

	test("dispose does not throw", () => {
		const { channel } = makeMockNextcloudChannel();
		const factory = createNextcloudInteractionFactory(channel);

		const instance = factory(makeNextcloudMessage());
		expect(() => instance?.dispose?.()).not.toThrow();
	});

	test("setDone removes the reaction instead of applying a done emoji (issue #1)", async () => {
		const { channel, calls } = makeMockNextcloudChannel();
		const factory = createNextcloudInteractionFactory(channel);

		const instance = factory(makeNextcloudMessage());
		await new Promise((r) => setTimeout(r, 50)); // let setQueued apply
		await instance?.statusReactions?.setDone();

		const doneAdd = calls.setReaction.find((c) => c.emoji === NEXTCLOUD_EMOJIS.done && c.add === true);
		expect(doneAdd).toBeUndefined();
		const removeCall = calls.setReaction.find((c) => c.emoji === NEXTCLOUD_EMOJIS.queued && c.add === false);
		expect(removeCall).toBeDefined();
	});

	test("setError still leaves the error emoji", async () => {
		const { channel, calls } = makeMockNextcloudChannel();
		const factory = createNextcloudInteractionFactory(channel);

		const instance = factory(makeNextcloudMessage());
		await new Promise((r) => setTimeout(r, 50)); // let setQueued apply
		await instance?.statusReactions?.setError();

		const errCall = calls.setReaction.find((c) => c.emoji === "\u26A0" && c.add === true);
		expect(errCall).toBeDefined();
	});

	test("full lifecycle transitions then clears without a terminal emoji", async () => {
		const { channel, calls } = makeMockNextcloudChannel();
		const factory = createNextcloudInteractionFactory(channel);

		const instance = factory(makeNextcloudMessage());
		instance?.onRuntimeEvent?.({ type: "thinking" });
		await new Promise((r) => setTimeout(r, 600)); // debounce 500ms
		await instance?.statusReactions?.setDone();

		const doneAdd = calls.setReaction.find((c) => c.emoji === NEXTCLOUD_EMOJIS.done && c.add === true);
		expect(doneAdd).toBeUndefined();
		const thinkingRemove = calls.setReaction.find((c) => c.emoji === NEXTCLOUD_EMOJIS.thinking && c.add === false);
		expect(thinkingRemove).toBeDefined();
	});
});

// Mock channel extended with the service-account user chat API surface that
// working text rides on (postChatMessage / editChatMessage / deleteChatMessage).
function makeWorkingTextChannel(options?: {
	hasServiceAccount?: boolean;
	postToNextcloudResult?: boolean;
	postChatMessageResult?: number | null;
}) {
	const calls = {
		setReaction: [] as Array<{ token: string; messageId: number; emoji: string; add: boolean }>,
		postToNextcloud: [] as Array<{ token: string; text: string; threadId?: number }>,
		postChatMessage: [] as Array<{
			token: string;
			message: string;
			opts?: { silent?: boolean; threadId?: number };
		}>,
		editChatMessage: [] as Array<{ token: string; messageId: number; message: string }>,
		deleteChatMessage: [] as Array<{ token: string; messageId: number }>,
	};
	let nextPlaceholderId = 1000;

	const channel = {
		setReaction: mock(async (token: string, messageId: number, emoji: string, add: boolean) => {
			calls.setReaction.push({ token, messageId, emoji, add });
		}),
		postToNextcloud: mock(async (token: string, text: string, _opts?: unknown, threadId?: number) => {
			calls.postToNextcloud.push({ token, text, threadId });
			return options?.postToNextcloudResult ?? true;
		}),
		hasServiceAccount: mock(() => options?.hasServiceAccount ?? true),
		postChatMessage: mock(async (token: string, message: string, opts?: { silent?: boolean; threadId?: number }) => {
			calls.postChatMessage.push({ token, message, opts });
			if (options?.postChatMessageResult !== undefined) return options.postChatMessageResult;
			return ++nextPlaceholderId;
		}),
		editChatMessage: mock(async (token: string, messageId: number, message: string) => {
			calls.editChatMessage.push({ token, messageId, message });
			return true;
		}),
		deleteChatMessage: mock(async (token: string, messageId: number) => {
			calls.deleteChatMessage.push({ token, messageId });
			return true;
		}),
	};
	return {
		channel: channel as unknown as Parameters<typeof createNextcloudInteractionFactory>[0],
		calls,
	};
}

function makeWorkingTextFactory(
	channel: Parameters<typeof createNextcloudInteractionFactory>[0],
	config?: { enableFeedback?: boolean; progressiveUpdateThrottleMs?: number },
) {
	return createNextcloudInteractionFactory(channel, {
		enableProgressiveUpdates: true,
		progressiveUpdateThrottleMs: 20,
		...config,
	});
}

describe("working text (progressive updates)", () => {
	test("no placeholder before the first tool activity, queued reaction on arrival", async () => {
		const { channel, calls } = makeWorkingTextChannel();
		const factory = makeWorkingTextFactory(channel);

		const instance = factory(makeNextcloudMessage());
		expect(instance?.progressStream).toBeDefined();
		await new Promise((r) => setTimeout(r, 50));
		const queuedCall = calls.setReaction.find((c) => c.emoji === NEXTCLOUD_EMOJIS.queued && c.add === true);
		expect(queuedCall).toBeDefined();
		expect(calls.postChatMessage).toHaveLength(0);
	});

	test("the first tool activity posts a silent placeholder with the working-text header", async () => {
		const { channel, calls } = makeWorkingTextChannel();
		const factory = makeWorkingTextFactory(channel);

		const instance = factory(makeNextcloudMessage());
		instance?.onRuntimeEvent?.({ type: "tool_use", tool: "Read", input: { file_path: "/src/main.ts" } });
		await new Promise((r) => setTimeout(r, 60));

		expect(calls.postChatMessage).toHaveLength(1);
		const call = calls.postChatMessage[0];
		expect(call.token).toBe("room1");
		expect(call.message).toBe("⏳ Working on it...");
		expect(call.opts?.silent).toBe(true);
	});

	test("thread-scoped messages post the placeholder into the Talk thread", async () => {
		const { channel, calls } = makeWorkingTextChannel();
		const factory = makeWorkingTextFactory(channel);

		const instance = factory(makeNextcloudMessage({ nextcloudThreadId: 77 }));
		instance?.onRuntimeEvent?.({ type: "tool_use", tool: "Read", input: {} });
		await new Promise((r) => setTimeout(r, 60));

		expect(calls.postChatMessage[0].opts?.threadId).toBe(77);
	});

	test("tool activity edits the placeholder through the throttled stream", async () => {
		const { channel, calls } = makeWorkingTextChannel();
		const factory = makeWorkingTextFactory(channel);

		const instance = factory(makeNextcloudMessage());
		instance?.onRuntimeEvent?.({ type: "tool_use", tool: "Read", input: { file_path: "/src/main.ts" } });
		await new Promise((r) => setTimeout(r, 120));

		expect(calls.editChatMessage).toHaveLength(1);
		const edit = calls.editChatMessage[0];
		expect(edit.token).toBe("room1");
		expect(edit.messageId).toBe(1001);
		expect(edit.message).toContain("⏳ Working on it...");
		expect(edit.message).toContain("Reading /src/main.ts");
	});

	test("a tool burst starts the stream exactly once", async () => {
		const { channel, calls } = makeWorkingTextChannel();
		const factory = makeWorkingTextFactory(channel);

		const instance = factory(makeNextcloudMessage());
		instance?.onRuntimeEvent?.({ type: "tool_use", tool: "Read", input: {} });
		instance?.onRuntimeEvent?.({ type: "tool_use", tool: "Grep", input: {} });
		await new Promise((r) => setTimeout(r, 60));

		expect(calls.postChatMessage).toHaveLength(1);
	});

	test("reaction ladder runs alongside the placeholder in working-text mode", async () => {
		const { channel, calls } = makeWorkingTextChannel();
		const factory = makeWorkingTextFactory(channel);

		const instance = factory(makeNextcloudMessage());
		instance?.onRuntimeEvent?.({ type: "thinking" });
		instance?.onRuntimeEvent?.({ type: "tool_use", tool: "Grep", input: {} });
		await new Promise((r) => setTimeout(r, 600)); // past the reaction debounce

		// The debounce coalesces queued/thinking/tool fired in a burst into
		// the final state; Grep maps to coding via resolveToolEmoji
		const toolCall = calls.setReaction.find((c) => c.emoji === NEXTCLOUD_EMOJIS.coding && c.add === true);
		expect(toolCall).toBeDefined();
		// The placeholder still posted with the tool activity
		expect(calls.postChatMessage).toHaveLength(1);
	});

	test("error events still raise the ⚠ reaction in working-text mode", async () => {
		const { channel, calls } = makeWorkingTextChannel();
		const factory = makeWorkingTextFactory(channel);

		const instance = factory(makeNextcloudMessage());
		instance?.onRuntimeEvent?.({ type: "error", message: "boom" });
		await new Promise((r) => setTimeout(r, 700)); // error debounce 500ms

		const errCall = calls.setReaction.find((c) => c.emoji === "\u26A0" && c.add === true);
		expect(errCall).toBeDefined();
	});

	test("successful delivery deletes the placeholder after posting the response", async () => {
		const { channel, calls } = makeWorkingTextChannel();
		const factory = makeWorkingTextFactory(channel, { enableFeedback: false });

		const instance = factory(makeNextcloudMessage());
		instance?.onRuntimeEvent?.({ type: "tool_use", tool: "Read", input: {} });
		await new Promise((r) => setTimeout(r, 60));
		await instance?.deliverResponse?.({ text: "final answer", isError: false });

		expect(calls.postToNextcloud).toEqual([{ token: "room1", text: "final answer", threadId: undefined }]);
		expect(calls.deleteChatMessage).toEqual([{ token: "room1", messageId: 1001 }]);
		// The placeholder must never be edited with the final body
		const folded = calls.editChatMessage.find((c) => c.message.includes("final answer"));
		expect(folded).toBeUndefined();
	});

	test("a turn without tool activity leaves no placeholder and deletes nothing", async () => {
		const { channel, calls } = makeWorkingTextChannel();
		const factory = makeWorkingTextFactory(channel, { enableFeedback: false });

		const instance = factory(makeNextcloudMessage());
		await instance?.deliverResponse?.({ text: "final answer", isError: false });

		expect(calls.postToNextcloud).toHaveLength(1);
		expect(calls.postChatMessage).toHaveLength(0);
		expect(calls.editChatMessage).toHaveLength(0);
		expect(calls.deleteChatMessage).toHaveLength(0);
	});

	test("failed delivery folds the response into the placeholder instead of deleting", async () => {
		const { channel, calls } = makeWorkingTextChannel({ postToNextcloudResult: false });
		const factory = makeWorkingTextFactory(channel, { enableFeedback: false });

		const instance = factory(makeNextcloudMessage());
		instance?.onRuntimeEvent?.({ type: "tool_use", tool: "Read", input: {} });
		await new Promise((r) => setTimeout(r, 60));
		await instance?.deliverResponse?.({ text: "final answer", isError: false });

		const folded = calls.editChatMessage.find((c) => c.message === "final answer");
		expect(folded).toBeDefined();
		expect(calls.deleteChatMessage).toHaveLength(0);
	});

	test("dispose deletes a placeholder that was never settled", async () => {
		const { channel, calls } = makeWorkingTextChannel();
		const factory = makeWorkingTextFactory(channel);

		const instance = factory(makeNextcloudMessage());
		instance?.onRuntimeEvent?.({ type: "tool_use", tool: "Read", input: {} });
		await new Promise((r) => setTimeout(r, 60));
		instance?.dispose?.();
		await new Promise((r) => setTimeout(r, 50));

		expect(calls.deleteChatMessage).toHaveLength(1);
	});

	test("placeholder post failure degrades to a no-op lifecycle", async () => {
		const { channel, calls } = makeWorkingTextChannel({ postChatMessageResult: null });
		const factory = makeWorkingTextFactory(channel, { enableFeedback: false });

		const instance = factory(makeNextcloudMessage());
		instance?.onRuntimeEvent?.({ type: "tool_use", tool: "Read", input: {} });
		await new Promise((r) => setTimeout(r, 120));
		await instance?.deliverResponse?.({ text: "final answer", isError: false });
		instance?.dispose?.();
		await new Promise((r) => setTimeout(r, 50));

		// Response still delivers, but there is nothing to edit or delete
		expect(calls.postToNextcloud).toHaveLength(1);
		expect(calls.editChatMessage).toHaveLength(0);
		expect(calls.deleteChatMessage).toHaveLength(0);
	});

	test("falls back to the reaction ladder without a service account", async () => {
		const { channel, calls } = makeWorkingTextChannel({ hasServiceAccount: false });
		const factory = makeWorkingTextFactory(channel);

		const instance = factory(makeNextcloudMessage());
		expect(instance?.progressStream).toBeUndefined();

		await new Promise((r) => setTimeout(r, 50));
		const queuedCall = calls.setReaction.find((c) => c.emoji === NEXTCLOUD_EMOJIS.queued && c.add === true);
		expect(queuedCall).toBeDefined();
		expect(calls.postChatMessage).toHaveLength(0);
	});
});
