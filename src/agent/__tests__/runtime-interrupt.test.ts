/**
 * Interrupt resilience for AgentRuntime.runQuery.
 *
 * The SDK's message iterator can, in rare post-abort states, never settle:
 * the child process dies but the stream's pending next() hangs, which used
 * to strand the turn (and its session lock) forever with no delivery.
 * These tests lock in the abort-gate race: an interrupted turn must settle
 * as INTERRUPT_ACK even when the SDK stream never resolves, and the normal
 * completion path must be untouched by the race.
 */

import { Database } from "bun:sqlite";
import { describe, expect, mock, test } from "bun:test";
// Keep the real SDK exports (tool, createSdkMcpServer, ...) intact and only
// replace query() so other modules importing this package are unaffected.
import * as sdk from "@anthropic-ai/claude-agent-sdk";
import type { PhantomConfig } from "../../config/types.ts";
import { MIGRATIONS } from "../../db/schema.ts";
import type { AgentRuntime as AgentRuntimeType } from "../runtime.ts";

type StreamFactory = () => AsyncGenerator<unknown>;

let currentStream: StreamFactory = async function* () {};

async function* hangForever(): AsyncGenerator<never> {
	await new Promise<never>(() => {});
}

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
	...sdk,
	query: () => currentStream(),
}));

// Imported AFTER the mock so runtime.ts binds the mocked query().
const { AgentRuntime } = require("../runtime.ts") as {
	AgentRuntime: typeof AgentRuntimeType;
};

function makeRuntime(): InstanceType<typeof AgentRuntimeType> {
	const db = new Database(":memory:");
	for (const sql of MIGRATIONS) db.run(sql);
	const config = {
		name: "test",
		model: "test-model",
		provider: { type: "anthropic" },
	} as unknown as PhantomConfig;
	return new AgentRuntime(config, db);
}

describe("runtime interrupt resilience", () => {
	test("interrupted turn settles with INTERRUPT_ACK even when the SDK stream never resolves", async () => {
		currentStream = hangForever;
		const runtime = makeRuntime();

		const pending = runtime.handleMessage("telegram", "t-hang", "long running task");
		await Bun.sleep(50);
		expect(runtime.isBusy("telegram", "t-hang")).toBe(true);

		expect(runtime.interrupt("telegram", "t-hang")).toBe(true);

		const settleRace = Promise.race([
			pending,
			Bun.sleep(2_000).then(() => {
				throw new Error("TURN_TIMEOUT: interrupted turn did not settle");
			}),
		]);
		const res = await settleRace;
		expect(res.text).toBe("Stopped.");
		expect(runtime.isBusy("telegram", "t-hang")).toBe(false);
	});

	test("normal completion path is unaffected by the abort race", async () => {
		currentStream = async function* () {
			yield { type: "system", subtype: "init", session_id: "sdk-1" };
			yield {
				type: "result",
				subtype: "success",
				result: "all done",
				total_cost_usd: 0,
				duration_ms: 1,
				usage: {},
				modelUsage: {},
			};
		};
		const runtime = makeRuntime();

		const res = await runtime.handleMessage("telegram", "t-ok", "hello");
		expect(res.text).toBe("all done");
		expect(runtime.isBusy("telegram", "t-ok")).toBe(false);
	});
});
