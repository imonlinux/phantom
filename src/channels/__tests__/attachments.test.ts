import { afterEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	MAX_ATTACHMENT_BYTES,
	attachmentFailureNote,
	attachmentsFallbackNote,
	basenameOf,
	mimeFromFilename,
	readAttachmentBuffer,
} from "../attachments.ts";
import type { PendingAttachment } from "../types.ts";

function pending(overrides?: Partial<PendingAttachment>): PendingAttachment {
	return { path: "/tmp/report.pdf", filename: "report.pdf", size: 100, mimeType: "application/pdf", ...overrides };
}

describe("mimeFromFilename", () => {
	test("maps known extensions", () => {
		expect(mimeFromFilename("photo.PNG")).toBe("image/png");
		expect(mimeFromFilename("notes.md")).toBe("text/markdown");
		expect(mimeFromFilename("sheet.XLSX")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
	});

	test("falls back to octet-stream for unknown or missing extensions", () => {
		expect(mimeFromFilename("blob.bin")).toBe("application/octet-stream");
		expect(mimeFromFilename("noext")).toBe("application/octet-stream");
	});
});

describe("basenameOf", () => {
	test("strips directories", () => {
		expect(basenameOf("/app/data/attachments/out.txt")).toBe("out.txt");
		expect(basenameOf("plain.txt")).toBe("plain.txt");
	});

	test("ignores trailing slashes", () => {
		expect(basenameOf("/tmp/dir/")).toBe("dir");
	});
});

describe("attachmentsFallbackNote", () => {
	test("empty list yields no note", () => {
		expect(attachmentsFallbackNote([])).toBe("");
	});

	test("names each file and its server-side path", () => {
		const note = attachmentsFallbackNote([
			pending(),
			pending({ path: "/tmp/a.md", filename: "a.md", mimeType: "text/markdown" }),
		]);
		expect(note).toContain("report.pdf (available at /tmp/report.pdf)");
		expect(note).toContain("a.md (available at /tmp/a.md)");
	});
});

describe("attachmentFailureNote", () => {
	test("names each failure with its reason", () => {
		expect(attachmentFailureNote([{ name: "a.pdf", error: "GET 500" }])).toBe("(Could not attach: a.pdf (GET 500))");
	});
});

describe("readAttachmentBuffer", () => {
	const originalFetch = globalThis.fetch;
	let tmpFile = "";

	afterEach(async () => {
		globalThis.fetch = originalFetch;
		if (tmpFile) {
			await unlink(tmpFile).catch(() => {});
			tmpFile = "";
		}
	});

	test("loads bytes from a real file", async () => {
		tmpFile = path.join(os.tmpdir(), `phantom-attach-test-${Date.now()}.txt`);
		await Bun.write(tmpFile, "attachment-bytes");
		const result = await readAttachmentBuffer(pending({ path: tmpFile, size: 16 }));
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.buffer.toString()).toBe("attachment-bytes");
	});

	test("rejects when the queued size exceeds the limit without touching disk", async () => {
		const result = await readAttachmentBuffer(pending({ size: MAX_ATTACHMENT_BYTES + 1 }));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("50 MB");
	});

	test("rejects missing files with a readable error", async () => {
		const result = await readAttachmentBuffer(pending({ path: "/tmp/phantom-does-not-exist-9x7.bin" }));
		expect(result.ok).toBe(false);
	});

	test("rejects directories", async () => {
		const result = await readAttachmentBuffer(pending({ path: os.tmpdir() }));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("not a regular file");
	});
});
