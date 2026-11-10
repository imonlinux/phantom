import { afterEach, describe, expect, test } from "bun:test";
import type { AgentRuntime } from "../../agent/runtime.ts";
import {
	buildContrastDiff,
	buildContrastJudgePrompt,
	judgeOutcomeFromVerdicts,
	runContrastJudge,
	__setContrastJudgeForTest,
} from "../contrast-judge.ts";
import type { ContrastJudgeInput, ContrastVerdict } from "../contrast-judge.ts";
import type { QueuedSession } from "../queue.ts";
import type { DirectorySnapshot, EvolutionVersion, VersionChange } from "../types.ts";

function makeSnapshot(files: Record<string, string>): DirectorySnapshot {
	const version: EvolutionVersion = {
		version: 0,
		parent: null,
		timestamp: "2026-11-10T00:00:00Z",
		changes: [],
		metrics_at_change: { session_count: 0, success_rate_7d: 0 },
	};
	return { version, files: new Map(Object.entries(files)) };
}

function makeChange(overrides: Partial<VersionChange> = {}): VersionChange {
	return {
		file: "user-profile.md",
		type: "edit",
		summary: "added a bullet",
		rationale: "drain=test sessions=1",
		session_ids: ["s1"],
		predicted_effect: "agent greets users by name",
		...overrides,
	};
}

function makeQueued(): QueuedSession {
	return {
		id: 1,
		session_id: "s1",
		session_key: "slack:C1:T1",
		gate_decision: { fire: true, source: "haiku", reason: "test", haiku_cost_usd: 0 },
		session_summary: {
			session_id: "s1",
			session_key: "slack:C1:T1",
			user_id: "u1",
			user_messages: ["remember my name is James"],
			assistant_messages: ["noted"],
			tools_used: [],
			files_tracked: [],
			outcome: "success",
			cost_usd: 0.01,
			started_at: "2026-11-10T10:00:00Z",
			ended_at: "2026-11-10T10:01:00Z",
		},
		enqueued_at: "2026-11-10T10:02:00Z",
		retry_count: 0,
	};
}

function makeInput(overrides: Partial<ContrastJudgeInput> = {}): ContrastJudgeInput {
	const baseFiles = {
		"persona.md": "# Persona\n",
		"user-profile.md": "# User Profile\n\n- existing bullet.\n",
		"domain-knowledge.md": "# Domain\n",
		"memory/corrections.md": "# Corrections\n",
		"constitution.md": "# Constitution\n",
	};
	const before = makeSnapshot({ ...baseFiles });
	const after = makeSnapshot({
		...baseFiles,
		"user-profile.md": "# User Profile\n\n- existing bullet.\n- name is James.\n",
	});
	return {
		runtime: null,
		model: "claude-sonnet-4-6",
		changes: [makeChange()],
		before,
		after,
		batch: [makeQueued()],
		...overrides,
	};
}

afterEach(() => {
	__setContrastJudgeForTest(null);
});

describe("buildContrastDiff", () => {
	test("edit shows removed and added lines", () => {
		const diff = buildContrastDiff("a\nb\nc\n", "a\nb\nd\n");
		expect(diff).toContain("- c");
		expect(diff).toContain("+ d");
	});

	test("new file shape", () => {
		const diff = buildContrastDiff(null, "# Domain\n- fact\n");
		expect(diff).toContain("(new file)");
		expect(diff).toContain("- fact");
	});

	test("deleted file shape", () => {
		expect(buildContrastDiff("content\n", null)).toContain("(file deleted)");
	});

	test("identical content reports no line-level changes", () => {
		expect(buildContrastDiff("same\n", "same\n")).toContain("(no line-level changes)");
	});

	test("line counts beyond the cap are truncated with a marker", () => {
		const before = "";
		const after = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
		const diff = buildContrastDiff(before, after);
		expect(diff).toContain("... (40 more added)");
	});
});

describe("buildContrastJudgePrompt", () => {
	test("carries predicted_effect, batch evidence, and scoped files", () => {
		const prompt = buildContrastJudgePrompt(makeInput());
		expect(prompt.user).toContain("predicted_effect: agent greets users by name");
		expect(prompt.user).toContain("[success] \"remember my name is James\"");
		expect(prompt.user).toContain("- user-profile.md");
		expect(prompt.user).toContain("- domain-knowledge.md");
		// Readable-but-not-writable files stay out of the judged scope.
		expect(prompt.user).not.toContain("constitution.md");
		expect(prompt.user).not.toContain("session-log");
		expect(prompt.user).toContain("+ - name is James.");
	});

	test("missing predicted_effect renders a placeholder, not undefined", () => {
		const input = makeInput({ changes: [makeChange({ predicted_effect: undefined })] });
		const prompt = buildContrastJudgePrompt(input);
		expect(prompt.user).toContain("predicted_effect: (none declared)");
	});
});

describe("judgeOutcomeFromVerdicts", () => {
	test("all plausible means not rejected", () => {
		const verdicts: ContrastVerdict[] = [{ file: "user-profile.md", plausible: true, reason: "follows" }];
		const outcome = judgeOutcomeFromVerdicts(verdicts, [makeChange()]);
		expect(outcome.outcome).toBe("ok");
		expect(outcome.outcome === "ok" && outcome.rejected).toBe(false);
	});

	test("any implausible verdict rejects the drain", () => {
		const verdicts: ContrastVerdict[] = [{ file: "user-profile.md", plausible: false, reason: "diff says nothing about names" }];
		const outcome = judgeOutcomeFromVerdicts(verdicts, [makeChange()]);
		expect(outcome.outcome === "ok" && outcome.rejected).toBe(true);
	});

	test("uncovered changes are an error, not a silent pass", () => {
		const verdicts: ContrastVerdict[] = [];
		const outcome = judgeOutcomeFromVerdicts(verdicts, [makeChange()]);
		expect(outcome.outcome).toBe("error");
	});
});

describe("runContrastJudge", () => {
	test("no runtime and no override is a fail-open error", async () => {
		const outcome = await runContrastJudge(makeInput({ runtime: null }));
		expect(outcome.outcome).toBe("error");
	});

	test("judge throw is captured as an error outcome", async () => {
		const runtime = {
			judgeQuery: async () => {
				throw new Error("provider timeout");
			},
		} as unknown as AgentRuntime;
		const outcome = await runContrastJudge(makeInput({ runtime }));
		expect(outcome.outcome).toBe("error");
		expect(outcome.outcome === "error" && outcome.error).toContain("provider timeout");
	});

	test("override receives the input and its verdict routes through", async () => {
		__setContrastJudgeForTest(async (input) => {
			expect(input.changes[0]?.file).toBe("user-profile.md");
			return {
				outcome: "ok",
				rejected: true,
				verdicts: [{ file: "user-profile.md", plausible: false, reason: "no basis" }],
			};
		});
		const outcome = await runContrastJudge(makeInput({ runtime: null }));
		expect(outcome.outcome).toBe("ok");
		expect(outcome.outcome === "ok" && outcome.rejected).toBe(true);
	});
});
