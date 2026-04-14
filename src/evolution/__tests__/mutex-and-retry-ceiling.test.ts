import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { JudgeSubprocessError } from "../../agent/judge-query.ts";
import type { AgentRuntime } from "../../agent/runtime.ts";
import type { PhantomConfig } from "../../config/types.ts";
import { ConstitutionChecker } from "../constitution.ts";
import { EvolutionEngine } from "../engine.ts";
import type { ConfigDelta, EvolvedConfig, SessionSummary } from "../types.ts";
import { CycleAborted, MAX_JUDGE_FAILURES_PER_CYCLE, validateAllWithJudges } from "../validation.ts";

// Phase 0 safety floor tests. These cover the three additions that make the
// evolution engine safe to run in a constrained environment:
//  1. Process-wide mutex around `afterSession` so overlapping turns cannot
//     stack evolution cycles on top of each other.
//  2. Cycle-local failure ceiling inside `validateAllWithJudges` so a second
//     judge subprocess failure in the same cycle aborts the remaining
//     deltas instead of spawning more subprocesses into a failing environment.
//  3. Partial cost capture on SIGKILL-era `JudgeSubprocessError` so fork-bomb
//     API spend is at least partially visible in the log stream.

const TEST_DIR = "/tmp/phantom-test-phase-0";
const CONFIG_PATH = `${TEST_DIR}/config/evolution.yaml`;

function setupTestEnvironment(): void {
	mkdirSync(`${TEST_DIR}/config`, { recursive: true });
	mkdirSync(`${TEST_DIR}/phantom-config/meta`, { recursive: true });
	mkdirSync(`${TEST_DIR}/phantom-config/strategies`, { recursive: true });
	mkdirSync(`${TEST_DIR}/phantom-config/memory`, { recursive: true });

	writeFileSync(
		CONFIG_PATH,
		[
			"cadence:",
			"  reflection_interval: 1",
			"  consolidation_interval: 10",
			"gates:",
			"  drift_threshold: 0.7",
			"  max_file_lines: 200",
			"  auto_rollback_threshold: 0.1",
			"  auto_rollback_window: 5",
			"reflection:",
			'  model: "claude-sonnet-4-20250514"',
			"judges:",
			'  enabled: "never"',
			"paths:",
			`  config_dir: "${TEST_DIR}/phantom-config"`,
			`  constitution: "${TEST_DIR}/phantom-config/constitution.md"`,
			`  version_file: "${TEST_DIR}/phantom-config/meta/version.json"`,
			`  metrics_file: "${TEST_DIR}/phantom-config/meta/metrics.json"`,
			`  evolution_log: "${TEST_DIR}/phantom-config/meta/evolution-log.jsonl"`,
			`  golden_suite: "${TEST_DIR}/phantom-config/meta/golden-suite.jsonl"`,
			`  session_log: "${TEST_DIR}/phantom-config/memory/session-log.jsonl"`,
		].join("\n"),
		"utf-8",
	);

	writeFileSync(
		`${TEST_DIR}/phantom-config/constitution.md`,
		["1. Honesty", "2. Safety", "3. Privacy", "4. Transparency", "5. Boundaries"].join("\n"),
		"utf-8",
	);
	writeFileSync(`${TEST_DIR}/phantom-config/persona.md`, "# Persona\n\n- Be direct.\n", "utf-8");
	writeFileSync(
		`${TEST_DIR}/phantom-config/user-profile.md`,
		"# User Profile\n\nPreferences learned from interactions.\n",
		"utf-8",
	);
	writeFileSync(`${TEST_DIR}/phantom-config/domain-knowledge.md`, "# Domain Knowledge\n", "utf-8");
	writeFileSync(`${TEST_DIR}/phantom-config/strategies/task-patterns.md`, "# Task Patterns\n", "utf-8");
	writeFileSync(`${TEST_DIR}/phantom-config/strategies/tool-preferences.md`, "# Tool Preferences\n", "utf-8");
	writeFileSync(`${TEST_DIR}/phantom-config/strategies/error-recovery.md`, "# Error Recovery\n", "utf-8");
	writeFileSync(`${TEST_DIR}/phantom-config/memory/session-log.jsonl`, "", "utf-8");
	writeFileSync(`${TEST_DIR}/phantom-config/memory/principles.md`, "# Principles\n", "utf-8");
	writeFileSync(`${TEST_DIR}/phantom-config/memory/corrections.md`, "# Corrections\n", "utf-8");

	writeFileSync(
		`${TEST_DIR}/phantom-config/meta/version.json`,
		JSON.stringify({
			version: 0,
			parent: null,
			timestamp: "2026-03-25T00:00:00Z",
			changes: [],
			metrics_at_change: { session_count: 0, success_rate_7d: 0, correction_rate_7d: 0 },
		}),
		"utf-8",
	);
	writeFileSync(
		`${TEST_DIR}/phantom-config/meta/metrics.json`,
		JSON.stringify({
			session_count: 0,
			success_count: 0,
			failure_count: 0,
			correction_count: 0,
			evolution_count: 0,
			rollback_count: 0,
			last_session_at: null,
			last_evolution_at: null,
			success_rate_7d: 0,
			correction_rate_7d: 0,
			sessions_since_consolidation: 0,
		}),
		"utf-8",
	);
	writeFileSync(`${TEST_DIR}/phantom-config/meta/evolution-log.jsonl`, "", "utf-8");
	writeFileSync(`${TEST_DIR}/phantom-config/meta/golden-suite.jsonl`, "", "utf-8");
}

function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
	return {
		session_id: "session-mutex",
		session_key: "cli:main",
		user_id: "user-1",
		user_messages: ["No, always use TypeScript not JavaScript"],
		assistant_messages: ["Understood."],
		tools_used: [],
		files_tracked: [],
		outcome: "success",
		cost_usd: 0.05,
		started_at: "2026-03-25T10:00:00Z",
		ended_at: "2026-03-25T10:05:00Z",
		...overrides,
	};
}

function makeDelta(overrides: Partial<ConfigDelta> = {}): ConfigDelta {
	return {
		file: "user-profile.md",
		type: "append",
		content: "- User prefers TypeScript",
		rationale: "User correction",
		session_ids: ["session-mutex"],
		tier: "free",
		...overrides,
	};
}

function makeEvolvedConfig(): EvolvedConfig {
	return {
		constitution: "1. Honesty\n2. Safety\n",
		persona: "# Persona",
		userProfile: "# User Profile",
		domainKnowledge: "# Domain Knowledge",
		strategies: { taskPatterns: "", toolPreferences: "", errorRecovery: "" },
		meta: { version: 0, metricsSnapshot: { session_count: 0, success_rate_7d: 0, correction_rate_7d: 0 } },
	};
}

// Minimum surface area of AgentRuntime the evolution engine actually calls
// during Phase 0. Only `getPhantomConfig` (for resolveJudgeMode) and
// `judgeQuery` (for every judge subprocess) are touched. Anything else would
// be a test of a different code path and belongs elsewhere.
type FakeRuntimeShape = {
	getPhantomConfig: () => PhantomConfig;
	// biome-ignore lint/suspicious/noExplicitAny: test double accepts any judge query shape
	judgeQuery: (options: any) => Promise<unknown>;
};

function fakePhantomConfig(): PhantomConfig {
	return {
		name: "test-phantom",
		port: 3100,
		role: "swe",
		model: "claude-opus-4-6",
		provider: { type: "anthropic" },
		effort: "max",
		max_budget_usd: 0,
		timeout_minutes: 240,
	};
}

describe("Phase 0 mutex guard", () => {
	beforeEach(() => {
		setupTestEnvironment();
	});

	afterEach(() => {
		rmSync(TEST_DIR, { recursive: true, force: true });
	});

	test("runs the second call of two overlapping afterSession calls as a skipped cycle", async () => {
		// Build an engine whose runtime hangs the very first judge query forever.
		// That blocks `afterSession` call A on the observation-extraction step.
		// While A is blocked, call B arrives, sees `activeCycle !== null`, logs
		// the skip, and returns a skipped-result without spawning any judge.
		let judgeCallCount = 0;
		// Explicit variable-scoped type so the closure assignment below does not
		// narrow to `never` (tsc strict control-flow analysis flags the callback
		// as unreachable otherwise).
		type Releaser = (reason: unknown) => void;
		const releaseHangRef: { fn: Releaser | null } = { fn: null };
		const hangUntilAborted = new Promise<never>((_resolve, reject) => {
			releaseHangRef.fn = reject;
		});

		const runtime: FakeRuntimeShape = {
			getPhantomConfig: fakePhantomConfig,
			judgeQuery: async () => {
				judgeCallCount++;
				// Hang so the mutex stays locked for the entire test.
				return hangUntilAborted;
			},
		};

		const engine = new EvolutionEngine(CONFIG_PATH, runtime as unknown as AgentRuntime);
		// Force judges on so the engine calls into `runtime.judgeQuery` and
		// hits our hanging fake. Without this the heuristic fallback would
		// complete synchronously and the mutex would open immediately.
		(engine as unknown as { llmJudgesEnabled: boolean }).llmJudgesEnabled = true;

		const callA = engine.afterSession(makeSession({ session_id: "sess-A" }));
		// Yield to the microtask queue so call A can start and register its
		// activeCycle promise before call B is issued. Without this yield,
		// both calls can race past the `if (this.activeCycle !== null)` check.
		await Promise.resolve();
		await Promise.resolve();
		const callB = engine.afterSession(makeSession({ session_id: "sess-B" }));
		const callC = engine.afterSession(makeSession({ session_id: "sess-C" }));

		const resultB = await callB;
		const resultC = await callC;

		// Skipped results carry zero applied and zero rejected changes and do
		// not advance the version. Exactly the shape `runCycle` would return if
		// there were no observations at all, which is fine for Phase 0: we are
		// dropping the session on the floor deliberately.
		expect(resultB.changes_applied).toHaveLength(0);
		expect(resultB.changes_rejected).toHaveLength(0);
		expect(resultC.changes_applied).toHaveLength(0);
		expect(resultC.changes_rejected).toHaveLength(0);

		// Only the first call should have reached the judge subprocess.
		expect(judgeCallCount).toBe(1);

		// Release the hanging call A so the process does not leak the promise.
		releaseHangRef.fn?.(new Error("released by test teardown"));
		try {
			await callA;
		} catch {
			// expected: the hang was released with a synthetic error
		}
	});

	test("clears the mutex after a thrown cycle so the next call can run", async () => {
		// If a cycle throws uncleanly, the `finally` in `afterSession` must
		// clear `activeCycle` so the engine is not permanently wedged.
		let calls = 0;
		const runtime: FakeRuntimeShape = {
			getPhantomConfig: fakePhantomConfig,
			judgeQuery: async () => {
				calls++;
				if (calls === 1) throw new Error("fake transient failure");
				// Second call: just resolve to something unparseable so the
				// heuristic path handles it cleanly without spawning real judges.
				throw new Error("second call also fails but mutex is released");
			},
		};

		const engine = new EvolutionEngine(CONFIG_PATH, runtime as unknown as AgentRuntime);
		(engine as unknown as { llmJudgesEnabled: boolean }).llmJudgesEnabled = true;

		// First call throws inside observation extraction, which falls back to
		// heuristic and returns a normal result. The mutex should be cleared
		// afterwards so the second call can proceed.
		await engine.afterSession(makeSession({ session_id: "sess-1" }));
		expect((engine as unknown as { activeCycle: unknown }).activeCycle).toBeNull();

		await engine.afterSession(makeSession({ session_id: "sess-2" }));
		expect((engine as unknown as { activeCycle: unknown }).activeCycle).toBeNull();
	});
});

describe("Phase 0 cycle-local failure ceiling", () => {
	beforeEach(() => {
		setupTestEnvironment();
	});

	afterEach(() => {
		rmSync(TEST_DIR, { recursive: true, force: true });
	});

	test("validateAllWithJudges aborts on the second judge failure and drops remaining deltas", async () => {
		const evolutionConfig = {
			cadence: {
				reflection_interval: 1,
				consolidation_interval: 10,
				full_review_interval: 50,
				drift_check_interval: 20,
			},
			gates: { drift_threshold: 0.7, max_file_lines: 200, auto_rollback_threshold: 0.1, auto_rollback_window: 5 },
			reflection: { model: "claude-sonnet-4-20250514", effort: "high" as const, max_budget_usd: 0.5 },
			judges: { enabled: "always" as const, cost_cap_usd_per_day: 50.0, max_golden_suite_size: 50 },
			paths: {
				config_dir: `${TEST_DIR}/phantom-config`,
				constitution: `${TEST_DIR}/phantom-config/constitution.md`,
				version_file: `${TEST_DIR}/phantom-config/meta/version.json`,
				metrics_file: `${TEST_DIR}/phantom-config/meta/metrics.json`,
				evolution_log: `${TEST_DIR}/phantom-config/meta/evolution-log.jsonl`,
				golden_suite: `${TEST_DIR}/phantom-config/meta/golden-suite.jsonl`,
				session_log: `${TEST_DIR}/phantom-config/memory/session-log.jsonl`,
			},
		};
		const checker = new ConstitutionChecker(evolutionConfig);

		let judgeCalls = 0;
		// Each `runConstitutionJudge` call triggers multiJudge which fans out to
		// three parallel judgeQuery calls. We want to fail on EVERY judgeQuery so
		// the first delta's constitution gate raises once, and the second delta's
		// constitution gate raises a second time, pushing failureCount past the
		// ceiling and triggering `CycleAborted`.
		const runtime: FakeRuntimeShape = {
			getPhantomConfig: fakePhantomConfig,
			judgeQuery: async () => {
				judgeCalls++;
				throw new JudgeSubprocessError("simulated subprocess SIGKILL", {
					inputTokens: 1234,
					outputTokens: 0,
					costUsd: 0.0042,
					model: "claude-sonnet",
					durationMs: 17,
				});
			},
		};

		const deltas = [
			makeDelta({ content: "- delta 1", session_ids: ["s1"] }),
			makeDelta({ content: "- delta 2", session_ids: ["s2"] }),
			makeDelta({ content: "- delta 3", session_ids: ["s3"] }),
			makeDelta({ content: "- delta 4", session_ids: ["s4"] }),
		];

		let aborted: CycleAborted | null = null;
		try {
			await validateAllWithJudges(
				runtime as unknown as AgentRuntime,
				deltas,
				checker,
				[],
				evolutionConfig,
				makeEvolvedConfig(),
			);
		} catch (err: unknown) {
			if (err instanceof CycleAborted) aborted = err;
		}

		expect(aborted).not.toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: asserted above
		const a = aborted!;
		expect(a.failureCount).toBeGreaterThanOrEqual(MAX_JUDGE_FAILURES_PER_CYCLE);
		// Delta 1: constitution fails (failure 1). Regression passes on empty
		// golden suite without spawning a subprocess. Safety fails (failure 2)
		// and triggers abort after recording delta 1's result. Remaining 3
		// deltas are dropped, so deltasDropped is exactly 3.
		expect(a.deltasDropped).toBe(3);
		// At least one judge subprocess fired. The ceiling prevented the cycle
		// from fanning out across all 4 deltas (which would have been 4x3=12
		// constitution subprocesses alone plus 4x3 for safety in the unbounded
		// behavior prior to Phase 0).
		expect(judgeCalls).toBeGreaterThan(0);
		expect(judgeCalls).toBeLessThan(12);
	});

	test("MAX_JUDGE_FAILURES_PER_CYCLE is 2 so the second failure aborts", () => {
		// This guards against a future edit that silently relaxes the ceiling.
		// Two failures is the operational floor the Phase 0 brief mandates.
		expect(MAX_JUDGE_FAILURES_PER_CYCLE).toBe(2);
	});
});

describe("Phase 0 partial cost capture", () => {
	test("JudgeSubprocessError carries partial cost diagnostics", () => {
		const err = new JudgeSubprocessError("simulated SIGKILL", {
			inputTokens: 7500,
			outputTokens: 0,
			costUsd: 0.0225,
			model: "claude-sonnet-4-5",
			durationMs: 3421,
		});
		expect(err.name).toBe("JudgeSubprocessError");
		expect(err.message).toContain("SIGKILL");
		expect(err.partialCost.inputTokens).toBe(7500);
		expect(err.partialCost.outputTokens).toBe(0);
		expect(err.partialCost.costUsd).toBeCloseTo(0.0225, 4);
		expect(err.partialCost.model).toBe("claude-sonnet-4-5");
		expect(err.partialCost.durationMs).toBe(3421);
	});

	test("JudgeSubprocessError is an Error subclass that survives `instanceof Error`", () => {
		const err = new JudgeSubprocessError("fail", {
			inputTokens: 0,
			outputTokens: 0,
			costUsd: 0,
			model: "m",
			durationMs: 0,
		});
		expect(err).toBeInstanceOf(Error);
		expect(err).toBeInstanceOf(JudgeSubprocessError);
	});
});
