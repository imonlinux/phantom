import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { MIGRATIONS } from "../../db/schema.ts";
import { processBatch } from "../batch-processor.ts";
import { DEFAULT_CADENCE_CONFIG, EvolutionCadence, loadCadenceConfig } from "../cadence.ts";
import type { EvolutionConfig } from "../config.ts";
import type { EvolutionEngine } from "../engine.ts";
import type { GateDecision } from "../gate-types.ts";
import type { QueuedSession } from "../queue.ts";
import { EvolutionQueue } from "../queue.ts";
import type { ReflectionSubprocessResult, SessionSummary } from "../types.ts";

// Phase 3 cadence + batch processor tests. The batch processor now runs the
// reflection subprocess once per drain instead of iterating per session, so
// the fake engine simulates a single `runDrainPipeline` call per batch.

const TEST_DIR = "/tmp/phantom-test-cadence";

function setupEnv(): EvolutionConfig {
	mkdirSync(`${TEST_DIR}/phantom-config/meta`, { recursive: true });
	writeFileSync(`${TEST_DIR}/phantom-config/meta/metrics.json`, "{}", "utf-8");
	return {
		reflection: { enabled: "never" },
		paths: {
			config_dir: `${TEST_DIR}/phantom-config`,
			constitution: `${TEST_DIR}/phantom-config/constitution.md`,
			version_file: `${TEST_DIR}/phantom-config/meta/version.json`,
			metrics_file: `${TEST_DIR}/phantom-config/meta/metrics.json`,
			evolution_log: `${TEST_DIR}/phantom-config/meta/evolution-log.jsonl`,
			session_log: `${TEST_DIR}/phantom-config/memory/session-log.jsonl`,
		},
	};
}

function newDb(): Database {
	const db = new Database(":memory:");
	db.run("PRAGMA journal_mode = WAL");
	for (const stmt of MIGRATIONS) db.run(stmt);
	return db;
}

function makeSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
	const sessionId = overrides.session_id ?? "s1";
	return {
		session_id: sessionId,
		session_key: `slack:C-${sessionId}:T-${sessionId}`,
		user_id: "u1",
		user_messages: ["help"],
		assistant_messages: ["ok"],
		tools_used: ["Read"],
		files_tracked: [],
		outcome: "success",
		cost_usd: 0.04,
		started_at: "2026-04-14T10:00:00Z",
		ended_at: "2026-04-14T10:01:00Z",
		...overrides,
	};
}

const DECISION: GateDecision = {
	fire: true,
	source: "haiku",
	reason: "haiku said evolve",
	haiku_cost_usd: 0.0006,
};

function okResult(): ReflectionSubprocessResult {
	return {
		drainId: "drain-test",
		status: "ok",
		tier: "haiku",
		escalatedFromTier: null,
		version: 1,
		changes: [],
		invariantHardFailures: [],
		invariantSoftWarnings: [],
		costUsd: 0.001,
		durationMs: 5,
		error: null,
		incrementRetryOnFailure: false,
		statsDelta: { drains: 1 },
	};
}

function skipResult(): ReflectionSubprocessResult {
	return { ...okResult(), status: "skip" };
}

function invariantFailResult(): ReflectionSubprocessResult {
	return {
		...okResult(),
		status: "ok",
		invariantHardFailures: [{ check: "I1", message: "bad scope" }],
		incrementRetryOnFailure: true,
		error: "I1: bad scope",
	};
}

function fakeEngine(options: {
	onDrain?: (batch: QueuedSession[]) => Promise<ReflectionSubprocessResult>;
	onDrainCalls?: QueuedSession[][];
}): EvolutionEngine {
	const run = options.onDrain ?? (async (): Promise<ReflectionSubprocessResult> => okResult());
	const shape = {
		runDrainPipeline: async (batch: QueuedSession[]) => {
			options.onDrainCalls?.push(batch);
			return run(batch);
		},
	};
	return shape as unknown as EvolutionEngine;
}

describe("loadCadenceConfig", () => {
	beforeEach(() => setupEnv());
	afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

	test("returns defaults when evolution.json is absent", () => {
		const config = setupEnv();
		const cadence = loadCadenceConfig(config);
		expect(cadence).toEqual(DEFAULT_CADENCE_CONFIG);
	});

	test("reads cadence_minutes and demand_trigger_depth overrides", () => {
		const config = setupEnv();
		writeFileSync(
			`${TEST_DIR}/phantom-config/meta/evolution.json`,
			JSON.stringify({ cadence_minutes: 240, demand_trigger_depth: 10 }),
			"utf-8",
		);
		const cadence = loadCadenceConfig(config);
		expect(cadence.cadenceMinutes).toBe(240);
		expect(cadence.demandTriggerDepth).toBe(10);
	});

	test("falls back to defaults on malformed evolution.json", () => {
		const config = setupEnv();
		writeFileSync(`${TEST_DIR}/phantom-config/meta/evolution.json`, "{not json", "utf-8");
		const cadence = loadCadenceConfig(config);
		expect(cadence).toEqual(DEFAULT_CADENCE_CONFIG);
	});
});

describe("processBatch", () => {
	beforeEach(() => setupEnv());
	afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

	test("empty batch short-circuits without calling the engine", async () => {
		const calls: QueuedSession[][] = [];
		const engine = fakeEngine({ onDrain: async () => okResult(), onDrainCalls: calls });
		const result = await processBatch([], engine);
		expect(result.processed).toBe(0);
		expect(calls.length).toBe(0);
	});

	test("single session batch calls runDrainPipeline once and marks success", async () => {
		const db = newDb();
		const queue = new EvolutionQueue(db);
		queue.enqueue(makeSummary({ session_id: "a" }), DECISION);
		const drained = queue.drainAll();
		const calls: QueuedSession[][] = [];
		const engine = fakeEngine({ onDrainCalls: calls });
		const result = await processBatch(drained, engine);
		expect(result.processed).toBe(1);
		expect(result.successCount).toBe(1);
		expect(calls.length).toBe(1);
		expect(calls[0]).toHaveLength(1);
	});

	test("multi-session batch passes the whole drain in one call", async () => {
		const db = newDb();
		const queue = new EvolutionQueue(db);
		queue.enqueue(makeSummary({ session_id: "a" }), DECISION);
		queue.enqueue(makeSummary({ session_id: "b" }), DECISION);
		queue.enqueue(makeSummary({ session_id: "c" }), DECISION);
		const drained = queue.drainAll();
		const calls: QueuedSession[][] = [];
		const engine = fakeEngine({ onDrainCalls: calls });
		const result = await processBatch(drained, engine);
		expect(result.processed).toBe(3);
		expect(result.successCount).toBe(3);
		expect(calls.length).toBe(1);
		expect(calls[0]).toHaveLength(3);
	});

	test("skip sentinel reports ok so the caller markProcessed deletes the rows", async () => {
		const db = newDb();
		const queue = new EvolutionQueue(db);
		queue.enqueue(makeSummary({ session_id: "a" }), DECISION);
		const engine = fakeEngine({ onDrain: async () => skipResult() });
		const result = await processBatch(queue.drainAll(), engine);
		expect(result.successCount).toBe(1);
		expect(result.failureCount).toBe(0);
	});

	test("invariant hard fail reports invariantFailed=true on every row", async () => {
		const db = newDb();
		const queue = new EvolutionQueue(db);
		queue.enqueue(makeSummary({ session_id: "a" }), DECISION);
		queue.enqueue(makeSummary({ session_id: "b" }), DECISION);
		const engine = fakeEngine({ onDrain: async () => invariantFailResult() });
		const result = await processBatch(queue.drainAll(), engine);
		expect(result.failureCount).toBe(2);
		for (const entry of result.results) {
			expect(entry.ok).toBe(false);
			if (!entry.ok) {
				expect(entry.invariantFailed).toBe(true);
				expect(entry.error).toContain("I1");
			}
		}
	});

	test("thrown error is captured as a transient failure on every row", async () => {
		const db = newDb();
		const queue = new EvolutionQueue(db);
		queue.enqueue(makeSummary({ session_id: "a" }), DECISION);
		queue.enqueue(makeSummary({ session_id: "b" }), DECISION);
		const engine = fakeEngine({
			onDrain: async () => {
				throw new Error("boom");
			},
		});
		const result = await processBatch(queue.drainAll(), engine);
		expect(result.failureCount).toBe(2);
		for (const entry of result.results) {
			expect(entry.ok).toBe(false);
			if (!entry.ok) {
				expect(entry.invariantFailed).toBe(false);
				expect(entry.error).toContain("boom");
			}
		}
	});
});

describe("EvolutionCadence", () => {
	beforeEach(() => setupEnv());
	afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

	test("demand trigger fires drainAndProcess when queue depth hits threshold", async () => {
		const config = setupEnv();
		const db = newDb();
		const queue = new EvolutionQueue(db);
		const engine = fakeEngine({});
		const cadence = new EvolutionCadence(engine, queue, config, { cadenceMinutes: 1_000_000, demandTriggerDepth: 3 });
		cadence.start();
		try {
			for (let i = 0; i < 3; i++) {
				queue.enqueue(makeSummary({ session_id: `s${i}` }), DECISION);
				cadence.onEnqueue();
			}
			await new Promise((r) => setTimeout(r, 50));
			expect(queue.depth()).toBe(0);
		} finally {
			cadence.stop();
		}
	});

	test("demand trigger does not fire below the threshold", async () => {
		const config = setupEnv();
		const db = newDb();
		const queue = new EvolutionQueue(db);
		const engine = fakeEngine({});
		const cadence = new EvolutionCadence(engine, queue, config, { cadenceMinutes: 1_000_000, demandTriggerDepth: 5 });
		cadence.start();
		try {
			queue.enqueue(makeSummary({ session_id: "s1" }), DECISION);
			cadence.onEnqueue();
			await new Promise((r) => setTimeout(r, 20));
			expect(queue.depth()).toBe(1);
		} finally {
			cadence.stop();
		}
	});

	test("triggerNow drains the queue and marks rows processed", async () => {
		const config = setupEnv();
		const db = newDb();
		const queue = new EvolutionQueue(db);
		const engine = fakeEngine({});
		const cadence = new EvolutionCadence(engine, queue, config, { cadenceMinutes: 1_000_000, demandTriggerDepth: 999 });
		cadence.start();
		try {
			queue.enqueue(makeSummary({ session_id: "s1" }), DECISION);
			queue.enqueue(makeSummary({ session_id: "s2" }), DECISION);
			const result = await cadence.triggerNow();
			expect(result).not.toBeNull();
			expect(result?.processed).toBe(2);
			expect(queue.depth()).toBe(0);
		} finally {
			cadence.stop();
		}
	});

	test("skip on mutex contention: second concurrent trigger returns null", async () => {
		const config = setupEnv();
		const db = newDb();
		const queue = new EvolutionQueue(db);
		let runs = 0;
		const engine = fakeEngine({
			onDrain: async () => {
				runs += 1;
				await new Promise((r) => setTimeout(r, 30));
				return okResult();
			},
		});
		const cadence = new EvolutionCadence(engine, queue, config, { cadenceMinutes: 1_000_000, demandTriggerDepth: 999 });
		cadence.start();
		try {
			queue.enqueue(makeSummary({ session_id: "slow-1" }), DECISION);
			queue.enqueue(makeSummary({ session_id: "slow-2" }), DECISION);
			const first = cadence.triggerNow();
			const second = await cadence.triggerNow();
			expect(second).toBeNull();
			const firstResult = await first;
			expect(firstResult?.processed).toBe(2);
			expect(runs).toBe(1); // one drain call for the whole batch
		} finally {
			cadence.stop();
		}
	});

	test("triggerNow returns null on an empty queue", async () => {
		const config = setupEnv();
		const db = newDb();
		const queue = new EvolutionQueue(db);
		const engine = fakeEngine({});
		const cadence = new EvolutionCadence(engine, queue, config, DEFAULT_CADENCE_CONFIG);
		cadence.start();
		try {
			const result = await cadence.triggerNow();
			expect(result).toBeNull();
		} finally {
			cadence.stop();
		}
	});

	test("cron tick fires drainAndProcess after the timer elapses", async () => {
		const config = setupEnv();
		const db = newDb();
		const queue = new EvolutionQueue(db);
		const engine = fakeEngine({});
		const cadence = new EvolutionCadence(engine, queue, config, {
			cadenceMinutes: 1 / 60_000,
			demandTriggerDepth: 999,
		});
		cadence.start();
		try {
			queue.enqueue(makeSummary({ session_id: "cron-1" }), DECISION);
			await new Promise((r) => setTimeout(r, 40));
			expect(queue.depth()).toBe(0);
		} finally {
			cadence.stop();
		}
	});

	test("invariant hard fail increments retry_count and leaves rows in queue", async () => {
		const config = setupEnv();
		const db = newDb();
		const queue = new EvolutionQueue(db);
		const engine = fakeEngine({
			onDrain: async () => invariantFailResult(),
		});
		const cadence = new EvolutionCadence(engine, queue, config, { cadenceMinutes: 1_000_000, demandTriggerDepth: 999 });
		cadence.start();
		try {
			queue.enqueue(makeSummary({ session_id: "row-1", session_key: "slack:C1:T1" }), DECISION);
			const result = await cadence.triggerNow();
			expect(result?.failureCount).toBe(1);
			// Row still in queue, retry_count incremented to 1
			const remaining = queue.drainAll();
			expect(remaining).toHaveLength(1);
			expect(remaining[0].retry_count).toBe(1);
		} finally {
			cadence.stop();
		}
	});

	test("three invariant failures in a row graduate the row to poison", async () => {
		const config = setupEnv();
		const db = newDb();
		const queue = new EvolutionQueue(db);
		const engine = fakeEngine({
			onDrain: async () => invariantFailResult(),
		});
		const cadence = new EvolutionCadence(engine, queue, config, { cadenceMinutes: 1_000_000, demandTriggerDepth: 999 });
		cadence.start();
		try {
			queue.enqueue(makeSummary({ session_id: "poison-me", session_key: "slack:C1:T1" }), DECISION);
			await cadence.triggerNow(); // retry_count -> 1
			await cadence.triggerNow(); // retry_count -> 2
			await cadence.triggerNow(); // retry_count -> 3, moves to poison
			expect(queue.depth()).toBe(0);
			expect(queue.listPoisonPile()).toHaveLength(1);
		} finally {
			cadence.stop();
		}
	});

	test("queue_stats counters increment after each drain", async () => {
		const config = setupEnv();
		const db = newDb();
		const queue = new EvolutionQueue(db);
		const engine = fakeEngine({});
		const cadence = new EvolutionCadence(engine, queue, config, { cadenceMinutes: 1_000_000, demandTriggerDepth: 999 });
		cadence.start();
		try {
			queue.enqueue(makeSummary({ session_id: "m1" }), DECISION);
			queue.enqueue(makeSummary({ session_id: "m2" }), DECISION);
			await cadence.triggerNow();
			const metrics = JSON.parse(readFileSync(config.paths.metrics_file, "utf-8"));
			expect(metrics.queue_stats).toBeDefined();
			expect(metrics.queue_stats.manual_fires_total).toBe(1);
			expect(metrics.queue_stats.batch_size_total).toBe(2);
			expect(metrics.queue_stats.avg_depth_at_drain).toBeCloseTo(2, 5);
		} finally {
			cadence.stop();
		}
	});

	test("stop clears the cron timer so no further ticks fire", async () => {
		const config = setupEnv();
		const db = newDb();
		const queue = new EvolutionQueue(db);
		const engine = fakeEngine({});
		const cadence = new EvolutionCadence(engine, queue, config, {
			cadenceMinutes: 1 / 60_000,
			demandTriggerDepth: 999,
		});
		cadence.start();
		cadence.stop();
		queue.enqueue(makeSummary({ session_id: "post-stop" }), DECISION);
		await new Promise((r) => setTimeout(r, 40));
		expect(queue.depth()).toBe(1);
	});
});
