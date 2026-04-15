import type { EvolutionEngine } from "./engine.ts";
import type { QueuedSession } from "./queue.ts";
import type { ReflectionSubprocessResult } from "./types.ts";

// Phase 3 batch processor. The Phase 2 per-session loop is gone: the
// reflection subprocess runs once per drain against the full batch. The
// signature stays compatible with cadence.ts so the downstream drain
// handling continues to work without changes.
//
// Transient failures (subprocess crash, timeout, parse fail with no
// writes) leave rows in the queue so the next drain retries them.
// Invariant hard failures increment retry_count on the rows and graduate
// them to the poison pile at count >= 3 per Phase 3 failure mode case 4.

export type SessionBatchEntry =
	| { id: number; ok: true; result: ReflectionSubprocessResult }
	| { id: number; ok: false; error: string; invariantFailed: boolean };

export type BatchResult = {
	processed: number;
	successCount: number;
	failureCount: number;
	results: SessionBatchEntry[];
	durationMs: number;
};

export async function processBatch(queuedSessions: QueuedSession[], engine: EvolutionEngine): Promise<BatchResult> {
	const startedAt = Date.now();
	if (queuedSessions.length === 0) {
		return { processed: 0, successCount: 0, failureCount: 0, results: [], durationMs: 0 };
	}

	let result: ReflectionSubprocessResult;
	try {
		result = await engine.runDrainPipeline(queuedSessions);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		const results: SessionBatchEntry[] = queuedSessions.map((q) => ({
			id: q.id,
			ok: false,
			error: msg,
			invariantFailed: false,
		}));
		return {
			processed: results.length,
			successCount: 0,
			failureCount: results.length,
			results,
			durationMs: Date.now() - startedAt,
		};
	}

	const invariantFailed = result.invariantHardFailures.length > 0;
	const shouldMarkFailed = result.incrementRetryOnFailure || invariantFailed;

	if (shouldMarkFailed) {
		const results: SessionBatchEntry[] = queuedSessions.map((q) => ({
			id: q.id,
			ok: false,
			error: result.error ?? "invariant hard fail",
			invariantFailed: true,
		}));
		return {
			processed: results.length,
			successCount: 0,
			failureCount: results.length,
			results,
			durationMs: Date.now() - startedAt,
		};
	}

	// Skip / ok / transient error paths all mark the rows as processed
	// because the batch was consumed. Transient errors do NOT increment
	// retry_count; they just keep rows in the queue via a different code
	// path. The cadence uses `ok` to decide whether to delete from the
	// queue, so we report ok=true for skip/success and ok=false only for
	// invariant hard fails.
	const ok = !result.error;
	const results: SessionBatchEntry[] = queuedSessions.map((q) => {
		if (ok) {
			return { id: q.id, ok: true as const, result };
		}
		return { id: q.id, ok: false as const, error: result.error ?? "unknown", invariantFailed: false };
	});

	return {
		processed: results.length,
		successCount: ok ? results.length : 0,
		failureCount: ok ? 0 : results.length,
		results,
		durationMs: Date.now() - startedAt,
	};
}
