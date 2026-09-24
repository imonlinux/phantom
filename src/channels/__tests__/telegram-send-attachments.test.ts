import { afterEach, describe, expect, mock, test } from "bun:test";
import { unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MAX_ATTACHMENT_BYTES } from "../attachments.ts";
import { TelegramChannel, type TelegramChannelConfig } from "../telegram.ts";

// Outbound attachment sends read real temp files: no node:fs module mocking
// here, so this file stays safe to run in the same process as the suites
// that mock module-level dependencies.

function makeChannelWithMockBot(config: TelegramChannelConfig) {
	const channel = new TelegramChannel(config);
	const sent: Array<{ method: string; chatId: number | string; input: unknown; options: unknown }> = [];
	const mockBot = {
		launch: mock(async () => undefined),
		stop: mock(() => undefined),
		telegram: {
			sendMessage: mock(async () => ({ message_id: 1 })),
			sendPhoto: mock(async (chatId: number | string, input: unknown, options: unknown) => {
				sent.push({ method: "sendPhoto", chatId, input, options });
				return { message_id: 2 };
			}),
			sendDocument: mock(async (chatId: number | string, input: unknown, options: unknown) => {
				sent.push({ method: "sendDocument", chatId, input, options });
				return { message_id: 3 };
			}),
		},
	};
	(channel as unknown as { bot: unknown }).bot = mockBot;
	return { channel, sent };
}

describe("sendAttachments", () => {
	const tmpFiles: string[] = [];

	async function tmpFile(name: string, content: string): Promise<string> {
		const p = path.join(os.tmpdir(), `phantom-tg-att-${Date.now()}-${name}`);
		await Bun.write(p, content);
		tmpFiles.push(p);
		return p;
	}

	afterEach(async () => {
		for (const p of tmpFiles.splice(0)) {
			await unlink(p).catch(() => {});
		}
	});

	test("sends images as photos and other files as documents, with captions", async () => {
		const { channel, sent } = makeChannelWithMockBot({ botToken: "test" });
		const image = await tmpFile("chart.png", "png-bytes");
		const doc = await tmpFile("report.pdf", "pdf-bytes");

		const failed = await channel.sendAttachments(100, [
			{ path: image, filename: "chart.png", size: 9, mimeType: "image/png", caption: "the chart" },
			{ path: doc, filename: "report.pdf", size: 9, mimeType: "application/pdf" },
		]);

		expect(failed).toEqual([]);
		expect(sent.map((s) => s.method)).toEqual(["sendPhoto", "sendDocument"]);
		const photo = sent[0];
		expect(photo.input).toMatchObject({ filename: "chart.png" });
		expect(photo.options).toEqual({ caption: "the chart" });
	});

	test("collects failures instead of throwing, per attachment", async () => {
		const { channel, sent } = makeChannelWithMockBot({ botToken: "test" });
		const good = await tmpFile("ok.txt", "text-bytes");

		const failed = await channel.sendAttachments(100, [
			{ path: "/tmp/phantom-missing-4t8x.bin", filename: "gone.bin", size: 1, mimeType: "application/octet-stream" },
			{ path: good, filename: "ok.txt", size: 10, mimeType: "text/plain" },
		]);

		expect(failed.length).toBe(1);
		expect(failed[0].name).toBe("gone.bin");
		// The healthy attachment still went out
		expect(sent.length).toBe(1);
		expect(sent[0].method).toBe("sendDocument");
	});

	test("rejects oversize queues without any API call", async () => {
		const { channel, sent } = makeChannelWithMockBot({ botToken: "test" });

		const failed = await channel.sendAttachments(100, [
			{
				path: "/tmp/whatever.bin",
				filename: "whatever.bin",
				size: MAX_ATTACHMENT_BYTES + 1,
				mimeType: "application/octet-stream",
			},
		]);

		expect(failed.length).toBe(1);
		expect(failed[0].error).toContain("50 MB");
		expect(sent.length).toBe(0);
	});
});
