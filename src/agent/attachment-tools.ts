/**
 * phantom_send_file: in-process MCP tool that queues a file for delivery
 * with the current turn's response.
 *
 * The collector array is created per runQuery call (same lifecycle as the
 * file tracker hooks) and closed over by the tool server, so attachments
 * never leak across turns. The runtime reads the collector back when the
 * SDK query settles and hands it to the channel layer with the response.
 */
import { stat } from "node:fs/promises";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { MAX_ATTACHMENT_BYTES, basenameOf, mimeFromFilename } from "../channels/attachments.ts";
import type { PendingAttachment } from "../channels/types.ts";

/**
 * Validate and queue one file. Split from the tool handler so tests can
 * inject the stat probe; the handler uses real stat.
 */
export async function queueAttachment(
	collector: PendingAttachment[],
	input: { path: string; caption?: string },
	statFn: typeof stat = stat,
): Promise<{ queued: true; filename: string; size: number; mimeType: string } | { queued: false; error: string }> {
	const path = input.path.trim();
	if (path.length === 0) return { queued: false, error: "path is empty" };

	let info: Awaited<ReturnType<typeof stat>>;
	try {
		info = await statFn(path);
	} catch {
		return { queued: false, error: `file not found: ${path}` };
	}
	if (!info.isFile()) return { queued: false, error: `not a regular file: ${path}` };
	if (info.size > MAX_ATTACHMENT_BYTES) {
		return { queued: false, error: `file exceeds ${Math.floor(MAX_ATTACHMENT_BYTES / (1024 * 1024))} MB limit` };
	}

	const filename = basenameOf(path);
	const mimeType = mimeFromFilename(filename);
	const existing = collector.find((a) => a.path === path);
	if (existing) {
		if (input.caption !== undefined) existing.caption = input.caption;
		return { queued: true, filename, size: info.size, mimeType };
	}

	collector.push({ path, filename, size: info.size, mimeType, caption: input.caption });
	return { queued: true, filename, size: info.size, mimeType };
}

export function createAttachmentToolServer(collector: PendingAttachment[]): McpSdkServerConfigWithInstance {
	const sendFile = tool(
		"phantom_send_file",
		"Queue a local file to be delivered as an attachment with this turn's response. " +
			"The file is sent to the user's channel (Telegram document/photo, email attachment, " +
			"Nextcloud Talk file message) when the response is delivered. " +
			"Validate the path exists first; calling this does not send anything immediately.",
		{
			path: z.string().min(1).describe("Absolute path of the file to attach"),
			caption: z.string().optional().describe("Optional caption shown with the file where the channel supports it"),
		},
		async (input) => {
			const result = await queueAttachment(collector, input);
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(result, null, 2),
					},
				],
				...(result.queued ? {} : { isError: true }),
			};
		},
	);

	return createSdkMcpServer({
		name: "phantom-attachments",
		tools: [sendFile],
	});
}
