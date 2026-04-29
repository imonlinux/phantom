import { beforeEach, describe, expect, mock, test } from "bun:test";
import { TelegramChannel, type TelegramChannelConfig } from "../telegram.ts";

// Mock just the bot.telegram.setMessageReaction surface. Building a full
// Telegraf mock is unnecessary for these tests.
function makeChannelWithMockApi(setMessageReactionFn: (...args: any[]) => Promise<unknown>) {
	const channel = new TelegramChannel({ botToken: "test-token" } as TelegramChannelConfig);
	// Inject a mock bot directly so we don't need to actually connect to Telegram.
	(channel as unknown as { bot: unknown }).bot = {
		telegram: {
			setMessageReaction: mock(setMessageReactionFn),
			sendMessage: mock(async () => ({ message_id: 1 })),
			editMessageText: mock(async () => undefined),
			editMessageReplyMarkup: mock(async () => undefined),
			sendChatAction: mock(async () => undefined),
		},
		launch: mock(async () => undefined),
		stop: mock(() => undefined),
		command: mock(() => undefined),
		on: mock(() => undefined),
		action: mock(() => undefined),
	};
	return channel;
}

describe("TelegramChannel.setReaction", () => {
	test("returns false when bot is not connected", async () => {
		const channel = new TelegramChannel({ botToken: "x" } as TelegramChannelConfig);
		const result = await channel.setReaction(123, 456, "👀");
		expect(result).toBe(false);
	});

	test("calls setMessageReaction with the configured emoji", async () => {
		const calls: any[] = [];
		const channel = makeChannelWithMockApi(async (...args: any[]) => {
			calls.push(args);
			return undefined;
		});

		const result = await channel.setReaction(123, 456, "👀");
		expect(result).toBe(true);
		expect(calls.length).toBe(1);
		expect(calls[0][0]).toBe(123);
		expect(calls[0][1]).toBe(456);
		expect(calls[0][2]).toEqual([{ type: "emoji", emoji: "👀" }]);
	});

	test("calls setMessageReaction with empty array to clear when emoji is empty string", async () => {
		const calls: any[] = [];
		const channel = makeChannelWithMockApi(async (...args: any[]) => {
			calls.push(args);
			return undefined;
		});

		const result = await channel.setReaction(123, 456, "");
		expect(result).toBe(true);
		expect(calls[0][2]).toEqual([]);
	});

	test("trips circuit breaker on REACTION_INVALID", async () => {
		const channel = makeChannelWithMockApi(async () => {
			throw new Error("400: REACTION_INVALID");
		});

		expect(channel.isReactionDisabledFor(123)).toBe(false);
		const result = await channel.setReaction(123, 456, "👀");
		expect(result).toBe(false);
		expect(channel.isReactionDisabledFor(123)).toBe(true);
	});

	test("trips circuit breaker on generic 400 errors", async () => {
		const channel = makeChannelWithMockApi(async () => {
			throw new Error("Bad Request: chat reaction is forbidden (400)");
		});

		const result = await channel.setReaction(123, 456, "👀");
		expect(result).toBe(false);
		expect(channel.isReactionDisabledFor(123)).toBe(true);
	});

	test("does NOT trip circuit breaker on 429 flood errors", async () => {
		const channel = makeChannelWithMockApi(async () => {
			// P5.4: Use JSON format for retry_after to test parsing
			throw new Error('429: Too Many Requests, {"retry_after": 1}');
		});

		const result = await channel.setReaction(123, 456, "👀");
		expect(result).toBe(false);
		expect(channel.isReactionDisabledFor(123)).toBe(false);
	});

	test("does NOT trip circuit breaker on network errors", async () => {
		const channel = makeChannelWithMockApi(async () => {
			throw new Error("ETIMEDOUT");
		});

		const result = await channel.setReaction(123, 456, "👀");
		expect(result).toBe(false);
		expect(channel.isReactionDisabledFor(123)).toBe(false);
	});

	test("circuit breaker is per-chat", async () => {
		let shouldFail = true;
		const channel = makeChannelWithMockApi(async () => {
			if (shouldFail) throw new Error("400 REACTION_INVALID");
			return undefined;
		});

		// Chat 123 trips
		await channel.setReaction(123, 456, "👀");
		expect(channel.isReactionDisabledFor(123)).toBe(true);

		// Chat 999 still works
		shouldFail = false;
		const result = await channel.setReaction(999, 100, "👀");
		expect(result).toBe(true);
		expect(channel.isReactionDisabledFor(999)).toBe(false);
	});

	test("subsequent calls to circuit-broken chat are skipped (no API call)", async () => {
		let callCount = 0;
		const channel = makeChannelWithMockApi(async () => {
			callCount++;
			throw new Error("400 REACTION_INVALID");
		});

		await channel.setReaction(123, 456, "👀");
		expect(callCount).toBe(1);
		await channel.setReaction(123, 789, "🤔");
		expect(callCount).toBe(1); // not incremented — call was skipped
		await channel.setReaction(123, 100, "👌");
		expect(callCount).toBe(1);
	});

	test("reaction calls return true on success and never throw", async () => {
		const channel = makeChannelWithMockApi(async () => undefined);
		await expect(channel.setReaction(1, 2, "👀")).resolves.toBe(true);
		await expect(channel.setReaction(1, 2, "🤔")).resolves.toBe(true);
		await expect(channel.setReaction(1, 2, "👌")).resolves.toBe(true);
	});

	test("declares reactions capability", () => {
		const channel = new TelegramChannel({ botToken: "x" } as TelegramChannelConfig);
		expect(channel.capabilities.reactions).toBe(true);
	});
});

describe("TelegramChannel.setReaction (P5.4 retry)", () => {
	test("retries on 429 Too Many Requests with retry_after", async () => {
		let attempts = 0;
		let callCount = 0;
		const channel = makeChannelWithMockApi(async () => {
			callCount++;
			attempts++;
			// First two attempts fail with 429
			if (attempts <= 2) {
				throw new Error('429: {"retry_after": 1} Too Many Requests');
			}
			// Third attempt succeeds
			return undefined;
		});

		const result = await channel.setReaction(123, 456, "👀");

		// Should succeed after retries
		expect(result).toBe(true);
		expect(callCount).toBe(3);
	});

	test("retries on 500 Internal Server Error with exponential backoff", async () => {
		let attempts = 0;
		let callCount = 0;
		const timestamps: number[] = [];
		const channel = makeChannelWithMockApi(async () => {
			callCount++;
			timestamps.push(Date.now());
			attempts++;
			// First two attempts fail with 500
			if (attempts <= 2) {
				throw new Error("500 Internal Server Error");
			}
			// Third attempt succeeds
			return undefined;
		});

		const result = await channel.setReaction(123, 456, "👀");

		// Should succeed after retries
		expect(result).toBe(true);
		expect(callCount).toBe(3);

		// Verify exponential backoff (approximately)
		// First retry: ~1000ms, second retry: ~2000ms
		if (timestamps.length >= 3) {
			const firstDelay = timestamps[1] - timestamps[0];
			const secondDelay = timestamps[2] - timestamps[1];
			// Allow some tolerance for test execution time
			expect(firstDelay).toBeGreaterThan(900); // At least ~1s
			expect(secondDelay).toBeGreaterThan(1800); // At least ~2s
		}
	}, 10_000); // 10s timeout for exponential backoff test

	test("does not retry on 400 REACTION_INVALID (permanent error)", async () => {
		let callCount = 0;
		const channel = makeChannelWithMockApi(async () => {
			callCount++;
			throw new Error("400 REACTION_INVALID");
		});

		const result = await channel.setReaction(123, 456, "👀");

		// Should fail immediately without retries
		expect(result).toBe(false);
		expect(callCount).toBe(1); // Only one attempt
	});

	test("gives up after max retries on persistent 429", async () => {
		let callCount = 0;
		const channel = makeChannelWithMockApi(async () => {
			callCount++;
			throw new Error('429: {"retry_after": 1} Too Many Requests');
		});

		const result = await channel.setReaction(123, 456, "👀");

		// Should fail after max retries
		expect(result).toBe(false);
		expect(callCount).toBe(4); // Initial + 3 retries
	});
});
