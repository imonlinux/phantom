import { describe, expect, test } from "bun:test";
import type { PendingAttachment } from "../../channels/types.ts";
import { queueAttachment } from "../attachment-tools.ts";

type StatFn = Parameters<typeof queueAttachment>[2];

function statFnFactory(overrides?: { isFile?: boolean; size?: number; throw?: boolean }) {
	const calls: string[] = [];
	const fn = (async (p: string) => {
		calls.push(p);
		if (overrides?.throw) throw new Error("ENOENT: no such file");
		return {
			isFile: () => overrides?.isFile ?? true,
			size: overrides?.size ?? 2048,
		};
	}) as unknown as StatFn;
	return { fn, calls };
}

describe("queueAttachment", () => {
	test("queues a valid file with derived filename and mime type", async () => {
		const collector: PendingAttachment[] = [];
		const { fn } = statFnFactory({ size: 4096 });
		const result = await queueAttachment(collector, { path: "/tmp/out/report.pdf" }, fn);
		expect(result).toEqual({ queued: true, filename: "report.pdf", size: 4096, mimeType: "application/pdf" });
		expect(collector.length).toBe(1);
		expect(collector[0].path).toBe("/tmp/out/report.pdf");
	});

	test("rejects missing paths, directories, and oversize files", async () => {
		const missing: PendingAttachment[] = [];
		const missingStat = statFnFactory({ throw: true });
		expect((await queueAttachment(missing, { path: "/tmp/gone.bin" }, missingStat.fn)).queued).toBe(false);

		const dirStat = statFnFactory({ isFile: false });
		const dirResult = await queueAttachment([], { path: "/tmp" }, dirStat.fn);
		expect(dirResult.queued).toBe(false);
		if (!dirResult.queued) expect(dirResult.error).toContain("not a regular file");

		const bigStat = statFnFactory({ size: 51 * 1024 * 1024 });
		const bigResult = await queueAttachment([], { path: "/tmp/huge.bin" }, bigStat.fn);
		expect(bigResult.queued).toBe(false);
		if (!bigResult.queued) expect(bigResult.error).toContain("50 MB");
	});

	test("rejects empty paths", async () => {
		const result = await queueAttachment([], { path: "   " });
		expect(result.queued).toBe(false);
		if (!result.queued) expect(result.error).toContain("path is empty");
	});

	test("dedupes by path and updates the caption", async () => {
		const collector: PendingAttachment[] = [];
		const { fn } = statFnFactory();
		await queueAttachment(collector, { path: "/tmp/a.md" }, fn);
		await queueAttachment(collector, { path: "/tmp/a.md", caption: "latest" }, fn);
		expect(collector.length).toBe(1);
		expect(collector[0].caption).toBe("latest");
	});

	test("carries an optional caption through", async () => {
		const collector: PendingAttachment[] = [];
		const { fn } = statFnFactory();
		await queueAttachment(collector, { path: "/tmp/a.png", caption: "the chart" }, fn);
		expect(collector[0].caption).toBe("the chart");
		expect(collector[0].mimeType).toBe("image/png");
	});
});
