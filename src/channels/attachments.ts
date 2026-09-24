/**
 * Shared outbound attachment plumbing.
 *
 * The agent queues files during a turn via the phantom_send_file tool;
 * the runtime hands the queue to the channel layer with the response.
 * Each channel either has a native transport (Telegram documents, email
 * attachments, Talk conversation-folder uploads) or degrades to a note
 * naming the path, so a file is never silently dropped.
 */
import { Buffer } from "node:buffer";
import { stat } from "node:fs/promises";
import type { PendingAttachment } from "./types.ts";

export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

export function basenameOf(path: string): string {
	return path.replace(/\/+$/, "").split("/").pop() ?? path;
}

const MIME_BY_EXT: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	svg: "image/svg+xml",
	pdf: "application/pdf",
	txt: "text/plain",
	md: "text/markdown",
	csv: "text/csv",
	json: "application/json",
	xml: "application/xml",
	html: "text/html",
	zip: "application/zip",
	gz: "application/gzip",
	tar: "application/x-tar",
	doc: "application/msword",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	xls: "application/vnd.ms-excel",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	ppt: "application/vnd.ms-powerpoint",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	mp3: "audio/mpeg",
	wav: "audio/wav",
	ogg: "audio/ogg",
	m4a: "audio/mp4",
	mp4: "video/mp4",
	webm: "video/webm",
	mov: "video/quicktime",
};

export function mimeFromFilename(name: string): string {
	const ext = name.includes(".") ? (name.split(".").pop() ?? "").toLowerCase() : "";
	return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/**
 * Validate a queued path and load its bytes. Returns a structured error
 * instead of throwing so channel transports can degrade per attachment.
 */
export async function readAttachmentBuffer(
	attachment: PendingAttachment,
): Promise<{ ok: true; buffer: Buffer } | { ok: false; error: string }> {
	if (attachment.size > MAX_ATTACHMENT_BYTES) {
		return { ok: false, error: `exceeds ${Math.floor(MAX_ATTACHMENT_BYTES / (1024 * 1024))} MB limit` };
	}
	try {
		const info = await stat(attachment.path);
		if (!info.isFile()) return { ok: false, error: "not a regular file" };
		const buffer = Buffer.from(await Bun.file(attachment.path).arrayBuffer());
		return { ok: true, buffer };
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, error: msg };
	}
}

/**
 * Degrade note for channels with no attachment transport. Appended to the
 * response text so the file stays discoverable instead of vanishing.
 */
export function attachmentsFallbackNote(attachments: PendingAttachment[]): string {
	if (attachments.length === 0) return "";
	const items = attachments.map((a) => `${a.filename} (available at ${a.path})`);
	return `\n\n(Attachment not sendable on this channel: ${items.join(", ")})`;
}

/** Note naming files whose transport send failed, with the server-side reason. */
export function attachmentFailureNote(failed: Array<{ name: string; error: string }>): string {
	const items = failed.map((f) => `${f.name} (${f.error})`);
	return `(Could not attach: ${items.join(", ")})`;
}
