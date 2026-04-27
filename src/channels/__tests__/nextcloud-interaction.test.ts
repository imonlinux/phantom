import { describe, expect, mock, test } from "bun:test";
import { createNextcloudInteractionFactory, NEXTCLOUD_EMOJIS } from "../nextcloud-interaction.ts";
import type { InboundMessage } from "../types.ts";

function makeMockNextcloudChannel() {
	const calls = {
		setReaction: [] as Array<{ token: string; messageId: number; emoji: string; add: boolean }>,
	};
	const channel = {
		setReaction: mock(async (token: string, messageId: number, emoji: string, add: boolean) => {
			calls.setReaction.push({ token, messageId, emoji, add });
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

	test("does NOT define deliverResponse (uses default router.send)", () => {
		const { channel } = makeMockNextcloudChannel();
		const factory = createNextcloudInteractionFactory(channel);

		const instance = factory(makeNextcloudMessage());
		expect(instance?.deliverResponse).toBeUndefined();
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
		instance?.onRuntimeEvent?.({ type: "thinking", sessionId: "s1" });
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
			sessionId: "s1",
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
});
