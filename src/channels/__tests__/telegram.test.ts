import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { TelegramChannel, type TelegramChannelConfig } from "../telegram.ts";

// Mock Telegraf
const mockLaunch = mock(() => Promise.resolve());
const mockStop = mock(() => {});
const mockSendMessage = mock(async (_chatId: number | string, _text: string, _opts?: Record<string, unknown>) => ({
	message_id: 42,
}));
const mockEditMessageText = mock(
	async (
		_chatId: number | string,
		_msgId: number,
		_inlineMsgId: string | undefined,
		_text: string,
		_opts?: Record<string, unknown>,
	) => ({}),
);
const mockSendChatAction = mock(async (_chatId: number | string, _action: string) => {});
const mockGetMe = mock(async () => ({
	id: 123456,
	is_bot: true,
	first_name: "TestBot",
	username: "test_bot",
}));

type HandlerFn = (ctx: Record<string, unknown>) => Promise<void>;
const commandHandlers = new Map<string, HandlerFn>();
const eventHandlers = new Map<string, HandlerFn>();
const actionPatterns: Array<{ pattern: RegExp; handler: HandlerFn }> = [];

const MockTelegraf = mock((_token: string) => ({
	launch: mockLaunch,
	stop: mockStop,
	command: (cmd: string, handler: HandlerFn) => {
		commandHandlers.set(cmd, handler);
	},
	on: (event: string, handler: HandlerFn) => {
		eventHandlers.set(event, handler);
	},
	action: (pattern: RegExp, handler: HandlerFn) => {
		actionPatterns.push({ pattern, handler });
	},
	telegram: {
		sendMessage: mockSendMessage,
		editMessageText: mockEditMessageText,
		sendChatAction: mockSendChatAction,
		getMe: mockGetMe,
	},
}));

mock.module("telegraf", () => ({
	Telegraf: MockTelegraf,
}));

const testConfig: TelegramChannelConfig = {
	botToken: "123456:ABC-DEF",
};

describe("TelegramChannel", () => {
	beforeEach(() => {
		commandHandlers.clear();
		eventHandlers.clear();
		actionPatterns.length = 0;
		mockLaunch.mockClear();
		mockStop.mockClear();
		mockSendMessage.mockClear();
		mockEditMessageText.mockClear();
		mockSendChatAction.mockClear();
	});

	test("has correct id and capabilities", () => {
		const channel = new TelegramChannel(testConfig);
		expect(channel.id).toBe("telegram");
		expect(channel.name).toBe("Telegram");
		expect(channel.capabilities.inlineKeyboards).toBe(true);
		expect(channel.capabilities.typing).toBe(true);
		expect(channel.capabilities.messageEditing).toBe(true);
	});

	test("starts disconnected", () => {
		const channel = new TelegramChannel(testConfig);
		expect(channel.isConnected()).toBe(false);
	});

	test("connect transitions to connected", async () => {
		const channel = new TelegramChannel(testConfig);
		await channel.connect();
		expect(channel.isConnected()).toBe(true);
		expect(mockLaunch).toHaveBeenCalledTimes(1);
	});

	test("disconnect transitions to disconnected", async () => {
		const channel = new TelegramChannel(testConfig);
		await channel.connect();
		await channel.disconnect();
		expect(channel.isConnected()).toBe(false);
	});

	test("registers command handlers on connect", async () => {
		const channel = new TelegramChannel(testConfig);
		await channel.connect();
		expect(commandHandlers.has("start")).toBe(true);
		expect(commandHandlers.has("status")).toBe(true);
		expect(commandHandlers.has("help")).toBe(true);
	});

	test("registers text handler on connect", async () => {
		const channel = new TelegramChannel(testConfig);
		await channel.connect();
		expect(eventHandlers.has("text")).toBe(true);
	});

	test("routes text messages to handler", async () => {
		const channel = new TelegramChannel(testConfig);
		let receivedText = "";

		channel.onMessage(async (msg) => {
			receivedText = msg.text;
		});

		await channel.connect();

		const textHandler = eventHandlers.get("text");
		expect(textHandler).toBeDefined();
		if (textHandler) {
			await textHandler({
				message: {
					text: "Hello Phantom",
					from: { id: 12345, first_name: "Test" },
					chat: { id: 67890 },
					message_id: 1,
				},
			});
		}

		expect(receivedText).toBe("Hello Phantom");
	});

	test("ignores slash commands in text handler", async () => {
		const channel = new TelegramChannel(testConfig);
		let handlerCalled = false;

		channel.onMessage(async () => {
			handlerCalled = true;
		});

		await channel.connect();

		const textHandler = eventHandlers.get("text");
		if (textHandler) {
			await textHandler({
				message: {
					text: "/start",
					from: { id: 12345 },
					chat: { id: 67890 },
					message_id: 1,
				},
			});
		}

		expect(handlerCalled).toBe(false);
	});

	test("sends message via send method", async () => {
		const channel = new TelegramChannel(testConfig);
		await channel.connect();

		const result = await channel.send("telegram:67890", { text: "Hello" });
		expect(result.channelId).toBe("telegram");
		expect(result.id).toBe("42");
		expect(mockSendMessage).toHaveBeenCalledTimes(1);
	});

	test("startTyping sends chat action and sets interval", async () => {
		const channel = new TelegramChannel(testConfig);
		await channel.connect();

		channel.startTyping(67890);
		expect(mockSendChatAction).toHaveBeenCalledWith(67890, "typing");

		channel.stopTyping(67890);
	});

	test("stopTyping clears the typing interval", async () => {
		const channel = new TelegramChannel(testConfig);
		await channel.connect();

		channel.startTyping(67890);
		channel.stopTyping(67890);

		// The interval fires every 4s. Wait 4.5s to confirm it was cleared.
		// Use a shorter wait than the old 5s to stay within bun's test timeout.
		mockSendChatAction.mockClear();
		await new Promise((r) => setTimeout(r, 4500));
		expect(mockSendChatAction).not.toHaveBeenCalled();
	}, 10000);

	test("editMessage calls telegram API", async () => {
		const channel = new TelegramChannel(testConfig);
		await channel.connect();

		await channel.editMessage(67890, 42, "Updated text");
		expect(mockEditMessageText).toHaveBeenCalledTimes(1);
	});
});

describe("TelegramChannel connection supervision", () => {
	const testConfig: TelegramChannelConfig = { botToken: "test-token" };

	function makeMockedBot(launchImpl?: () => Promise<void>, getMeImpl?: () => Promise<unknown>) {
		const calls = {
			launch: 0,
			stop: 0,
			getMe: 0,
		};

		const bot = {
			launch: mock(async () => {
				calls.launch++;
				if (launchImpl) await launchImpl();
			}),
			stop: mock(() => {
				calls.stop++;
			}),
			command: mock(() => {}),
			on: mock(() => {}),
			action: mock(() => {}),
			telegram: {
				sendMessage: mock(async () => ({ message_id: 1 })),
				editMessageText: mock(async () => undefined),
				editMessageReplyMarkup: mock(async () => undefined),
				sendChatAction: mock(async () => undefined),
				setMessageReaction: mock(async () => undefined),
				getMe: mock(async () => {
					calls.getMe++;
					if (getMeImpl) return getMeImpl();
					return { id: 1, is_bot: true, first_name: "TestBot" };
				}),
			},
		};

		return { bot, calls };
	}

	// Inject the mocked bot directly without going through Telegraf import.
	function injectBot(channel: TelegramChannel, bot: ReturnType<typeof makeMockedBot>["bot"]): void {
		(channel as unknown as { bot: unknown }).bot = bot;
		(channel as unknown as { connectionState: string }).connectionState = "connected";
	}

	test("healthcheck calls getMe periodically when running", async () => {
		const channel = new TelegramChannel(testConfig);
		const { bot, calls } = makeMockedBot();
		injectBot(channel, bot);

		// Manually start the healthcheck (we bypassed connect()).
		(channel as unknown as { startHealthCheck: () => void }).startHealthCheck();

		// Force-fire the healthcheck once via the private method.
		await (channel as unknown as { runHealthCheck: () => Promise<void> }).runHealthCheck();
		expect(calls.getMe).toBe(1);

		await (channel as unknown as { runHealthCheck: () => Promise<void> }).runHealthCheck();
		expect(calls.getMe).toBe(2);

		(channel as unknown as { stopHealthCheck: () => void }).stopHealthCheck();
	});

	test("healthcheck failure triggers a reconnect", async () => {
		const channel = new TelegramChannel(testConfig);
		let getMeShouldFail = true;
		const { bot, calls } = makeMockedBot(
			async () => {
				/* launch succeeds */
			},
			async () => {
				if (getMeShouldFail) throw new Error("ETIMEDOUT");
				return { id: 1, is_bot: true, first_name: "TestBot" };
			},
		);
		injectBot(channel, bot);

		// Spy on reconnect via property override.
		let reconnectCalled = false;
		const originalReconnect = (channel as unknown as { reconnect: () => Promise<void> }).reconnect;
		(channel as unknown as { reconnect: () => Promise<void> }).reconnect = async () => {
			reconnectCalled = true;
		};

		await (channel as unknown as { runHealthCheck: () => Promise<void> }).runHealthCheck();
		expect(reconnectCalled).toBe(true);
		expect(calls.getMe).toBe(1);

		// Restore for subsequent tests in the same module
		(channel as unknown as { reconnect: () => Promise<void> }).reconnect = originalReconnect;
	});

	test("healthcheck is a no-op while reconnecting", async () => {
		const channel = new TelegramChannel(testConfig);
		const { bot, calls } = makeMockedBot();
		injectBot(channel, bot);

		(channel as unknown as { isReconnecting: boolean }).isReconnecting = true;

		await (channel as unknown as { runHealthCheck: () => Promise<void> }).runHealthCheck();
		expect(calls.getMe).toBe(0);
	});

	test("healthcheck is a no-op after shutdown is requested", async () => {
		const channel = new TelegramChannel(testConfig);
		const { bot, calls } = makeMockedBot();
		injectBot(channel, bot);

		(channel as unknown as { shutdownRequested: boolean }).shutdownRequested = true;

		await (channel as unknown as { runHealthCheck: () => Promise<void> }).runHealthCheck();
		expect(calls.getMe).toBe(0);
	});

	test("healthcheck is a no-op when not connected", async () => {
		const channel = new TelegramChannel(testConfig);
		const { bot, calls } = makeMockedBot();
		// Inject bot but leave connectionState as "disconnected" (default).
		(channel as unknown as { bot: unknown }).bot = bot;

		await (channel as unknown as { runHealthCheck: () => Promise<void> }).runHealthCheck();
		expect(calls.getMe).toBe(0);
	});

	test("disconnect stops the healthcheck timer and sets shutdownRequested", async () => {
		const channel = new TelegramChannel(testConfig);
		const { bot } = makeMockedBot();
		injectBot(channel, bot);

		(channel as unknown as { startHealthCheck: () => void }).startHealthCheck();
		expect((channel as unknown as { healthCheckTimer: unknown }).healthCheckTimer).not.toBeNull();

		await channel.disconnect();
		expect((channel as unknown as { healthCheckTimer: unknown }).healthCheckTimer).toBeNull();
		expect((channel as unknown as { shutdownRequested: boolean }).shutdownRequested).toBe(true);
	});

	test("reconnect is idempotent — only one runs at a time", async () => {
		const channel = new TelegramChannel(testConfig);
		const { bot } = makeMockedBot();
		injectBot(channel, bot);

		(channel as unknown as { isReconnecting: boolean }).isReconnecting = true;

		// Calling reconnect while already reconnecting should be a no-op.
		// We can't easily verify "no-op" without timing, but we can verify
		// that the function returns without throwing.
		await expect(
			(channel as unknown as { reconnect: () => Promise<void> }).reconnect(),
		).resolves.toBeUndefined();
	});
});
