import { describe, expect, mock, test } from "bun:test";
import { type TelegrafContext, TelegramChannel, type TelegramChannelConfig, formatQuotedReply } from "../telegram.ts";
import type { InboundMessage } from "../types.ts";

// Quote-reply passthrough: the Bot API delivers the parent message on
// reply_to_message; the adapter must prepend it as a quoted block instead
// of routing the reply as contextless text.

function makeChannelWithMockBot(config: TelegramChannelConfig) {
	const channel = new TelegramChannel(config);

	const handlers = {
		text: null as ((ctx: TelegrafContext) => Promise<void>) | null,
	};

	const mockBot = {
		launch: mock(async () => undefined),
		stop: mock(() => undefined),
		command: mock((_cmd: string, _h: (ctx: TelegrafContext) => Promise<void>) => undefined),
		on: mock((event: string, h: (ctx: TelegrafContext) => Promise<void>) => {
			if (event === "text") handlers.text = h;
		}),
		action: mock((_pattern: RegExp, _h: (ctx: TelegrafContext) => Promise<void>) => undefined),
		reaction: mock((_emoji: string | string[], _h: (ctx: TelegrafContext) => Promise<void>) => undefined),
		telegram: {
			sendMessage: mock(async () => ({ message_id: 1 })),
			sendChatAction: mock(async () => undefined),
			setMessageReaction: mock(async () => undefined),
			getMe: mock(async () => ({ id: 999, is_bot: true, first_name: "Bot" })),
		},
	};

	(channel as unknown as { bot: unknown }).bot = mockBot;
	(channel as unknown as { registerHandlers: () => void }).registerHandlers();

	return { channel, handlers };
}

function makeTextCtx(args: {
	text: string;
	replyTo?: { from?: { first_name?: string; username?: string }; text?: string; caption?: string };
}): TelegrafContext {
	return {
		message: {
			text: args.text,
			from: { id: 5, first_name: "James" },
			chat: { id: 100, type: "private" },
			message_id: 77,
			...(args.replyTo !== undefined ? { reply_to_message: args.replyTo } : {}),
		},
		reply: async () => ({ message_id: 99 }),
	} as unknown as TelegrafContext;
}

async function captureInbound(channel: TelegramChannel): Promise<InboundMessage[]> {
	const seen: InboundMessage[] = [];
	channel.onMessage(async (msg) => {
		seen.push(msg);
	});
	return seen;
}

describe("Telegram quote-reply passthrough", () => {
	test("prepends the quoted parent text for swipe-replies", async () => {
		const { channel, handlers } = makeChannelWithMockBot({ botToken: "test" });
		const seen = await captureInbound(channel);

		await handlers.text?.(
			makeTextCtx({
				text: "What did you mean by that?",
				replyTo: { from: { id: 999, first_name: "Phantom" }, text: "The sync landed cleanly." },
			}),
		);

		expect(seen).toHaveLength(1);
		expect(seen[0].text).toBe("[Quoting Phantom]\n> The sync landed cleanly.\n\nWhat did you mean by that?");
	});

	test("multi-line parent messages render as blockquote lines", async () => {
		const { channel, handlers } = makeChannelWithMockBot({ botToken: "test" });
		const seen = await captureInbound(channel);

		await handlers.text?.(
			makeTextCtx({
				text: "look at line 2",
				replyTo: { from: { id: 999, first_name: "Phantom" }, text: "line one\nline two" },
			}),
		);

		expect(seen[0].text).toBe("[Quoting Phantom]\n> line one\n> line two\n\nlook at line 2");
	});

	test("falls back to the caption when the parent is a media message", async () => {
		const { channel, handlers } = makeChannelWithMockBot({ botToken: "test" });
		const seen = await captureInbound(channel);

		await handlers.text?.(
			makeTextCtx({
				text: "explain this",
				replyTo: { from: { id: 999, first_name: "Phantom" }, caption: "error screenshot" },
			}),
		);

		expect(seen[0].text).toBe("[Quoting Phantom]\n> error screenshot\n\nexplain this");
	});

	test("replies to textless parents carry a no-text marker", async () => {
		const { channel, handlers } = makeChannelWithMockBot({ botToken: "test" });
		const seen = await captureInbound(channel);

		await handlers.text?.(
			makeTextCtx({ text: "what is this?", replyTo: { from: { id: 999, first_name: "Phantom" } } }),
		);

		expect(seen[0].text).toBe("[Quoting Phantom: (no text)]\n\nwhat is this?");
	});

	test("quotes are bounded at 500 characters", async () => {
		const { channel, handlers } = makeChannelWithMockBot({ botToken: "test" });
		const seen = await captureInbound(channel);

		const long = "x".repeat(700);
		await handlers.text?.(
			makeTextCtx({ text: "summarize", replyTo: { from: { id: 999, first_name: "Phantom" }, text: long } }),
		);

		const quoted = (seen[0].text ?? "").split("\n\n")[1] ?? "";
		expect(quoted).toBe("summarize");
		const block = (seen[0].text ?? "").split("\n\n")[0];
		expect(block).toContain("[Quoting Phantom]");
		expect(block.endsWith("xxxxx...")).toBe(true);
		expect(block.length).toBeLessThan(700);
	});

	test("non-reply messages pass through unchanged", async () => {
		const { channel, handlers } = makeChannelWithMockBot({ botToken: "test" });
		const seen = await captureInbound(channel);

		await handlers.text?.(makeTextCtx({ text: "plain message" }));

		expect(seen[0].text).toBe("plain message");
	});

	test("formatQuotedReply returns null when the message is not a reply", () => {
		expect(formatQuotedReply(undefined)).toBeNull();
	});
});
