import { z } from "zod";
import type { AgentRuntime } from "../agent/runtime.ts";
import type { QueuedSession } from "./queue.ts";
import type { VersionChange } from "./types.ts";
import type { DirectorySnapshot } from "./versioning.ts";

// A2: contrast judge. The evidence gate's compose step minus the probe we
// cannot run: after the invariants pass, one judge call receives the actual
// pre/post diffs, the batch evidence, and each declared predicted_effect,
// and answers per change whether the stated effect plausibly follows from
// the diff. The judge evaluates the causal chain; it does not veto on style.
//
// Gate.ts pattern: runJudgeQuery with a Zod schema and omitPreset (the judge
// reads only the prompt payload; it never touches files or tools). Failure
// is fail-open at the caller: a judge that times out, errors, or returns an
// incomplete verdict set must never silently discard learning signal.

export const ContrastJudgeResultSchema = z.object({
	verdicts: z
		.array(
			z.object({
				file: z.string(),
				plausible: z.boolean(),
				reason: z.string(),
			}),
		)
		.min(1),
});

export type ContrastVerdict = { file: string; plausible: boolean; reason: string };

export type ContrastJudgeOutcome =
	| { outcome: "ok"; rejected: boolean; verdicts: ContrastVerdict[] }
	| { outcome: "error"; error: string };

const DIFF_CAP_PER_FILE = 4000;
const DIFF_MAX_LINES = 60;
const EVIDENCE_MESSAGE_CAP = 240;

export type ContrastJudgeInput = {
	runtime: AgentRuntime | null;
	model: string;
	changes: VersionChange[];
	before: DirectorySnapshot;
	after: DirectorySnapshot;
	batch: QueuedSession[];
};

// Test hook: overrides let unit and integration tests replace the judge call
// with a deterministic verdict. Production leaves this null and the judge
// goes through runtime.judgeQuery like the Phase 1 gate.
let judgeOverride: ((input: ContrastJudgeInput) => Promise<ContrastJudgeOutcome>) | null = null;

export function __setContrastJudgeForTest(
	impl: ((input: ContrastJudgeInput) => Promise<ContrastJudgeOutcome>) | null,
): void {
	judgeOverride = impl;
}

export function buildContrastJudgePrompt(input: ContrastJudgeInput): { system: string; user: string } {
	const system = [
		"You are the contrast judge for a self-evolving AI agent's memory config.",
		"The agent declared, for each change it made, a predicted_effect: the observable behavior change the edit should produce, plus the batch evidence that motivates it.",
		"Your job: for each change, decide whether the stated effect plausibly follows from the actual diff and the batch evidence.",
		"Judge the causal chain. An effect is implausible when the diff does not contain the knowledge or behavior the effect claims to add, or when the batch evidence does not support the claim.",
		"Do not reject for style, phrasing, or formatting. Do not reject just because the effect is modest.",
		"Answer for EVERY change with one verdict each: {\"verdicts\":[{\"file\":\"...\",\"plausible\":true|false,\"reason\":\"one sentence\"}]}.",
		"Output exactly one JSON object and nothing else.",
	].join(" ");

	const sections: string[] = [];
	sections.push(renderBatchSummary(input.batch));
	sections.push(renderLoadedFiles(input.before));
	sections.push(renderChanges(input));

	return {
		system,
		user: sections.join("\n\n"),
	};
}

export async function runContrastJudge(input: ContrastJudgeInput): Promise<ContrastJudgeOutcome> {
	if (judgeOverride) return judgeOverride(input);

	if (!input.runtime) {
		return { outcome: "error", error: "no runtime available for contrast judge" };
	}

	const prompt = buildContrastJudgePrompt(input);
	try {
		const result = await input.runtime.judgeQuery<z.infer<typeof ContrastJudgeResultSchema>>({
			systemPrompt: prompt.system,
			userMessage: prompt.user,
			schema: ContrastJudgeResultSchema,
			model: input.model,
			maxTokens: 1024,
			omitPreset: true,
		});
		return judgeOutcomeFromVerdicts(result.data.verdicts, input.changes);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return { outcome: "error", error: msg };
	}
}

/**
 * Reduce raw verdicts to a drain-level outcome. Every changed file must be
 * covered: an uncovered change means the judge did not actually evaluate the
 * drain, which is an error (fail-open at the caller), not a silent pass.
 */
export function judgeOutcomeFromVerdicts(
	verdicts: ContrastVerdict[],
	changes: VersionChange[],
): ContrastJudgeOutcome {
	const byFile = new Map(verdicts.map((v) => [v.file, v]));
	const uncovered = changes.filter((c) => !byFile.has(c.file));
	if (uncovered.length > 0) {
		const names = uncovered.map((c) => c.file).join(", ");
		return { outcome: "error", error: `judge verdicts do not cover: ${names}` };
	}
	const rejected = verdicts.some((v) => !v.plausible);
	return { outcome: "ok", rejected, verdicts };
}

function renderBatchSummary(batch: QueuedSession[]): string {
	const lines: string[] = ["## Batch evidence", `${batch.length} session(s) in this drain:`];
	for (const q of batch) {
		const s = q.session_summary;
		const firstUser = (s.user_messages[0] ?? "(none)").slice(0, EVIDENCE_MESSAGE_CAP);
		lines.push(`- [${s.outcome}] "${firstUser}"`);
	}
	return lines.join("\n");
}

/**
 * The canonical files the reflector can write, derived from the snapshot.
 * meta/ and .staging/ are outside the write scope; constitution.md,
 * session-log, and agent-notes are readable but not writable, so they are
 * not part of the judged surface.
 */
function renderLoadedFiles(snapshot: DirectorySnapshot): string {
	const writeable = [...snapshot.files.keys()].filter(isWriteablePath).sort();
	return ["## Files in scope (the only files the agent may change)", ...writeable.map((f) => `- ${f}`)].join("\n");
}

export function isWriteablePath(rel: string): boolean {
	if (rel.startsWith("meta/") || rel.startsWith(".staging/")) return false;
	if (rel === "constitution.md" || rel === "memory/session-log.jsonl" || rel === "memory/agent-notes.md") {
		return false;
	}
	return (
		rel === "persona.md" ||
		rel === "user-profile.md" ||
		rel === "domain-knowledge.md" ||
		rel.startsWith("strategies/") ||
		rel === "memory/corrections.md" ||
		rel === "memory/principles.md"
	);
}

function renderChanges(input: ContrastJudgeInput): string {
	const sections: string[] = ["## Changes to evaluate"];
	for (const change of input.changes) {
		const before = input.before.files.get(change.file) ?? null;
		const after = input.after.files.get(change.file) ?? null;
		const parts = [
			`### ${change.file} (${change.type})`,
			`summary: ${change.summary}`,
			`predicted_effect: ${change.predicted_effect ?? "(none declared)"}`,
			`diff:\n${buildContrastDiff(before, after)}`,
		];
		sections.push(parts.join("\n"));
	}
	return sections.join("\n\n");
}

/**
 * Bounded line-level diff for markdown memory files. Removed = lines present
 * before but absent after; added = the reverse. Exact line-set matching is
 * coarse next to a real LCS diff, but the judge reasons over semantics, not
 * patch geometry, and the files are small. Deletes and new files get their
 * own shapes.
 */
export function buildContrastDiff(before: string | null, after: string | null): string {
	if (after === null) return "(file deleted)";
	if (before === null) {
		const head = after.split("\n").slice(0, DIFF_MAX_LINES).join("\n");
		const capped = head.length > DIFF_CAP_PER_FILE ? `${head.slice(0, DIFF_CAP_PER_FILE)}...` : head;
		return `(new file)\n${capped}`;
	}

	const beforeLines = new Set(before.split("\n"));
	const afterLines = new Set(after.split("\n"));
	const removed: string[] = [];
	const added: string[] = [];
	for (const line of before.split("\n")) {
		if (!afterLines.has(line)) removed.push(line);
	}
	for (const line of after.split("\n")) {
		if (!beforeLines.has(line)) added.push(line);
	}
	if (removed.length === 0 && added.length === 0) {
		return "(no line-level changes)";
	}

	const sections: string[] = [];
	if (removed.length > 0) {
		const lines = removed.slice(0, DIFF_MAX_LINES).map((l) => `- ${l}`);
		if (removed.length > DIFF_MAX_LINES) lines.push(`- ... (${removed.length - DIFF_MAX_LINES} more removed)`);
		sections.push(["removed:", ...lines].join("\n"));
	}
	if (added.length > 0) {
		const lines = added.slice(0, DIFF_MAX_LINES).map((l) => `+ ${l}`);
		if (added.length > DIFF_MAX_LINES) lines.push(`+ ... (${added.length - DIFF_MAX_LINES} more added)`);
		sections.push(["added:", ...lines].join("\n"));
	}
	let out = sections.join("\n");
	if (out.length > DIFF_CAP_PER_FILE) out = `${out.slice(0, DIFF_CAP_PER_FILE)}...`;
	return out;
}
