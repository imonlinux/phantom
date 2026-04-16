import { describe, expect, mock, test } from "bun:test";
import { parseJobDescription } from "../parse-with-sonnet.ts";

type FakeContentBlock = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown };

function makeClient(handler: () => Promise<{ content: FakeContentBlock[] }>) {
	return { messages: { create: mock(handler) } };
}

function hnToolUse(): FakeContentBlock[] {
	return [
		{
			type: "tool_use",
			id: "tool_01",
			name: "propose_job",
			input: {
				name: "hn-digest",
				description: "Top Hacker News stories every 6 hours",
				task: "Fetch the top 10 Hacker News stories and post a brief summary to Slack.",
				schedule: { kind: "every", intervalMs: 21_600_000 },
				delivery: { channel: "slack", target: "owner" },
			},
		},
	];
}

describe("parseJobDescription", () => {
	test("returns 503 when ANTHROPIC_API_KEY is unset", async () => {
		const result = await parseJobDescription("anything", { apiKey: null });
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected failure");
		expect(result.status).toBe(503);
		expect(result.error).toContain("ANTHROPIC_API_KEY");
	});

	test("happy path: Sonnet returns a valid proposal", async () => {
		const client = makeClient(async () => ({ content: hnToolUse() }));
		const result = await parseJobDescription("Pull top HN stories every 6 hours and post a summary to my Slack DM", {
			apiKey: "test-key",
			clientFactory: () => client as never,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected success");
		expect(result.proposal.name).toBe("hn-digest");
		expect(result.proposal.schedule).toEqual({ kind: "every", intervalMs: 21_600_000 });
		expect(result.proposal.delivery).toEqual({ channel: "slack", target: "owner" });
	});

	test("forces tool_choice to propose_job", async () => {
		const seen: Array<unknown> = [];
		const createMock = mock(async (args: unknown) => {
			seen.push(args);
			return { content: hnToolUse() };
		});
		const client = { messages: { create: createMock } };
		await parseJobDescription("schedule anything", {
			apiKey: "test-key",
			clientFactory: () => client as never,
		});

		expect(createMock).toHaveBeenCalledTimes(1);
		const args = seen[0] as {
			tool_choice?: { type: string; name: string };
			tools?: Array<{ name: string }>;
			model?: string;
		};
		expect(args.tool_choice).toEqual({ type: "tool", name: "propose_job" });
		expect(args.tools?.[0]?.name).toBe("propose_job");
		expect(args.model).toBe("claude-sonnet-4-6");
	});

	test("422 when Sonnet returns no tool_use block", async () => {
		const client = makeClient(async () => ({
			content: [{ type: "text", text: "Sorry, I cannot help." }],
		}));

		const result = await parseJobDescription("vague description", {
			apiKey: "test-key",
			clientFactory: () => client as never,
		});

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected failure");
		expect(result.status).toBe(422);
	});

	test("422 when Sonnet returns a malformed tool input", async () => {
		const client = makeClient(async () => ({
			content: [
				{
					type: "tool_use",
					id: "tool_01",
					name: "propose_job",
					// Missing required `schedule`, `task`; out-of-shape name.
					input: { name: 123, foo: "bar" },
				},
			],
		}));

		const result = await parseJobDescription("try me", {
			apiKey: "test-key",
			clientFactory: () => client as never,
		});

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected failure");
		expect(result.status).toBe(422);
	});

	test("504 when the SDK throws an abort/timeout error", async () => {
		const client = makeClient(async () => {
			const err = new Error("Request was aborted.");
			(err as unknown as { name: string }).name = "AbortError";
			throw err;
		});

		const result = await parseJobDescription("anything", {
			apiKey: "test-key",
			clientFactory: () => client as never,
		});

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected failure");
		expect(result.status).toBe(504);
	});

	test("422 when the SDK throws a non-timeout error", async () => {
		const client = makeClient(async () => {
			throw new Error("Internal server error");
		});

		const result = await parseJobDescription("anything", {
			apiKey: "test-key",
			clientFactory: () => client as never,
		});

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected failure");
		expect(result.status).toBe(422);
	});

	test("cron schedules round-trip through the schema", async () => {
		const client = makeClient(async () => ({
			content: [
				{
					type: "tool_use",
					id: "tool_02",
					name: "propose_job",
					input: {
						name: "daily-standup",
						task: "Summarize overnight activity and list three priorities.",
						schedule: { kind: "cron", expr: "0 9 * * 1-5", tz: "America/Los_Angeles" },
						delivery: { channel: "slack", target: "owner" },
					},
				},
			],
		}));

		const result = await parseJobDescription("9am weekdays standup", {
			apiKey: "test-key",
			clientFactory: () => client as never,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected success");
		expect(result.proposal.schedule).toEqual({ kind: "cron", expr: "0 9 * * 1-5", tz: "America/Los_Angeles" });
	});

	test("at schedules accept ISO with offset", async () => {
		const client = makeClient(async () => ({
			content: [
				{
					type: "tool_use",
					id: "tool_03",
					name: "propose_job",
					input: {
						name: "one-time-health",
						task: "Verify the deploy succeeded.",
						schedule: { kind: "at", at: "2026-04-18T15:00:00-07:00" },
						delivery: { channel: "slack", target: "owner" },
					},
				},
			],
		}));

		const result = await parseJobDescription("check at 3pm tomorrow", {
			apiKey: "test-key",
			clientFactory: () => client as never,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected success");
		expect(result.proposal.schedule).toEqual({ kind: "at", at: "2026-04-18T15:00:00-07:00" });
	});

	test("uses the ANTHROPIC_API_KEY env var when no apiKey passed", async () => {
		const prev = process.env.ANTHROPIC_API_KEY;
		process.env.ANTHROPIC_API_KEY = "env-key";
		try {
			const client = makeClient(async () => ({ content: hnToolUse() }));
			const result = await parseJobDescription("every 6h HN digest", {
				clientFactory: () => client as never,
			});
			expect(result.ok).toBe(true);
		} finally {
			if (prev === undefined) process.env.ANTHROPIC_API_KEY = undefined;
			else process.env.ANTHROPIC_API_KEY = prev;
		}
	});
});
