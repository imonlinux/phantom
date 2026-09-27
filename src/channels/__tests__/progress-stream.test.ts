import { describe, expect, mock, test } from "bun:test";
import { createProgressStream, formatToolActivity } from "../progress-stream.ts";

describe("formatToolActivity", () => {
	test("formats read tool with file path", () => {
		expect(formatToolActivity("Read", { file_path: "/src/main.ts" })).toBe("Reading /src/main.ts");
	});

	test("formats write tool with file path", () => {
		expect(formatToolActivity("Write", { file_path: "/src/output.ts" })).toBe("Writing /src/output.ts");
	});

	test("formats edit tool with file path", () => {
		expect(formatToolActivity("Edit", { file_path: "/src/config.ts" })).toBe("Editing /src/config.ts");
	});

	test("formats bash tool with command", () => {
		expect(formatToolActivity("Bash", { command: "npm install" })).toBe("Running: npm install");
	});

	test("truncates long bash commands", () => {
		const longCmd = "a".repeat(80);
		const result = formatToolActivity("Bash", { command: longCmd });
		expect(result.length).toBeLessThan(80);
		expect(result).toContain("...");
	});

	test("formats grep tool", () => {
		expect(formatToolActivity("Grep")).toBe("Searching code...");
	});

	test("formats glob tool", () => {
		expect(formatToolActivity("Glob")).toBe("Finding files...");
	});

	test("formats web search tool", () => {
		expect(formatToolActivity("WebSearch")).toBe("Searching the web...");
	});

	test("formats web fetch tool", () => {
		expect(formatToolActivity("WebFetch")).toBe("Fetching web page...");
	});

	test("formats agent tool", () => {
		expect(formatToolActivity("Agent")).toBe("Delegating to sub-agent...");
	});

	test("formats unknown tool", () => {
		expect(formatToolActivity("MyCustomTool")).toBe("Using MyCustomTool...");
	});

	test("formats read tool without file path", () => {
		expect(formatToolActivity("Read")).toBe("Reading file...");
	});

	test("formats bash tool without command", () => {
		expect(formatToolActivity("Bash")).toBe("Running command...");
	});
});

describe("createProgressStream", () => {
	test("starts with a post message call", async () => {
		const postMessage = mock(async (_text: string) => "msg_123");
		const updateMessage = mock(async (_id: string, _text: string) => {});

		const stream = createProgressStream({
			adapter: { postMessage, updateMessage },
		});

		await stream.start();
		expect(postMessage).toHaveBeenCalledWith("Working on it...");
		expect(stream.getMessageId()).toBe("msg_123");
	});

	test("finish updates the message with final text", async () => {
		const postMessage = mock(async (_text: string) => "msg_123");
		const updateMessage = mock(async (_id: string, _text: string) => {});

		const stream = createProgressStream({
			adapter: { postMessage, updateMessage },
		});

		await stream.start();
		await stream.finish("Final response text");

		expect(updateMessage).toHaveBeenCalledWith("msg_123", "Final response text");
	});

	test("finish calls onFinish handler when provided", async () => {
		const postMessage = mock(async (_text: string) => "msg_123");
		const updateMessage = mock(async (_id: string, _text: string) => {});
		const onFinish = mock(async (_id: string, _text: string) => {});

		const stream = createProgressStream({
			adapter: { postMessage, updateMessage },
			onFinish,
		});

		await stream.start();
		await stream.finish("Final text");

		expect(onFinish).toHaveBeenCalledWith("msg_123", "Final text");
		// updateMessage should NOT be called when onFinish is provided
		expect(updateMessage).not.toHaveBeenCalledTimes(2);
	});

	test("addToolActivity marks stream as dirty for throttled update", async () => {
		const postMessage = mock(async (_text: string) => "msg_123");
		const updateMessage = mock(async (_id: string, _text: string) => {});

		const stream = createProgressStream({
			adapter: { postMessage, updateMessage },
		});

		await stream.start();
		stream.addToolActivity("Read", "Reading /src/main.ts");
		stream.addToolActivity("Edit", "Editing /src/config.ts");

		// The throttle hasn't fired yet, so no update call
		expect(updateMessage).not.toHaveBeenCalled();

		// Wait for throttle to fire (1000ms default + buffer)
		await new Promise((r) => setTimeout(r, 1200));
		expect(updateMessage).toHaveBeenCalled();
	});

	test("handles adapter errors gracefully", async () => {
		let errorCaught = false;
		const postMessage = mock(async (_text: string) => {
			throw new Error("Post failed");
		});
		const updateMessage = mock(async (_id: string, _text: string) => {});

		const stream = createProgressStream({
			adapter: { postMessage, updateMessage },
			onError: () => {
				errorCaught = true;
			},
		});

		await stream.start();
		expect(errorCaught).toBe(true);
		expect(stream.getMessageId()).toBeNull();
	});

	test("does not add activity after finish", async () => {
		const postMessage = mock(async (_text: string) => "msg_123");
		const updateMessage = mock(async (_id: string, _text: string) => {});

		const stream = createProgressStream({
			adapter: { postMessage, updateMessage },
		});

		await stream.start();
		await stream.finish("Done");

		// This should be silently ignored
		stream.addToolActivity("Read", "Reading...");
		await new Promise((r) => setTimeout(r, 1200));

		// Only the finish call should have happened
		expect(updateMessage).toHaveBeenCalledTimes(1);
	});

	test("uses a custom header instead of the default", async () => {
		const postMessage = mock(async (_text: string) => "msg_123");
		const updateMessage = mock(async (_id: string, _text: string) => {});

		const stream = createProgressStream({
			adapter: { postMessage, updateMessage },
			header: "⏳ Working on it...",
		});

		await stream.start();
		expect(postMessage).toHaveBeenCalledWith("⏳ Working on it...");

		stream.addToolActivity("Read", "Reading /src/main.ts");
		await new Promise((r) => setTimeout(r, 1100));
		const rendered = updateMessage.mock.calls[0][1] as string;
		expect(rendered.startsWith("⏳ Working on it...")).toBe(true);
	});

	test("respects a custom throttle interval", async () => {
		const postMessage = mock(async (_text: string) => "msg_123");
		const updateMessage = mock(async (_id: string, _text: string) => {});

		const stream = createProgressStream({
			adapter: { postMessage, updateMessage },
			throttleMs: 20,
		});

		await stream.start();
		stream.addToolActivity("Read", "Reading /src/main.ts");

		// Custom throttle (20ms) instead of the 1000ms default
		expect(updateMessage).not.toHaveBeenCalled();
		await new Promise((r) => setTimeout(r, 150));
		expect(updateMessage).toHaveBeenCalledTimes(1);
	});
});
