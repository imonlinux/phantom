// Sonnet describe-your-job assist.
//
// CARDINAL RULE: This endpoint helps the OPERATOR fill a form. The operator
// reviews and edits the structured output before saving. It does NOT classify
// user intent, and it does NOT drive the agent at run time. When the job
// fires, the agent gets the operator's final `task` prompt and decides what
// to do with it. Sonnet here is form plumbing, not a routing layer.
//
// A tiny one-shot Messages API call with forced tool-use. We do not use the
// Agent SDK: a raw Messages call avoids subprocess overhead and the full
// tool surface we do not need.

import Anthropic from "@anthropic-ai/sdk";
import { type JobCreateInputParsed, JobCreateInputSchema } from "./tool-schema.ts";

type AnthropicClient = InstanceType<typeof Anthropic>;

export type ParseSuccess = { ok: true; proposal: JobCreateInputParsed; warnings: string[] };
export type ParseFailure = { ok: false; status: 422 | 503 | 504; error: string };
export type ParseResult = ParseSuccess | ParseFailure;

export type ParseDeps = {
	apiKey?: string | null;
	clientFactory?: (apiKey: string) => AnthropicClient;
	timeoutMs?: number;
	model?: string;
};

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_TIMEOUT_MS = 15_000;
const GENERIC_ERROR = "Could not parse description, please fill the form manually.";

// JSON Schema for the forced tool-use. The Zod parse on the server is the
// source of truth; this schema guides Sonnet's output. Hand-written so we do
// not pull zod-to-json-schema for a ~40-line conversion.
const PROPOSE_JOB_INPUT_SCHEMA = {
	type: "object",
	properties: {
		name: { type: "string", minLength: 1, maxLength: 200, description: "Short kebab-case job name (e.g. hn-digest)." },
		description: { type: "string", maxLength: 1000, description: "One-sentence human summary." },
		schedule: {
			oneOf: [
				{
					type: "object",
					properties: {
						kind: { const: "at" },
						at: { type: "string", description: "ISO 8601 with explicit offset (2026-04-18T15:00:00-07:00)." },
					},
					required: ["kind", "at"],
					additionalProperties: false,
				},
				{
					type: "object",
					properties: {
						kind: { const: "every" },
						intervalMs: { type: "integer", minimum: 1, description: "Interval in ms. 6h = 21600000." },
					},
					required: ["kind", "intervalMs"],
					additionalProperties: false,
				},
				{
					type: "object",
					properties: {
						kind: { const: "cron" },
						expr: { type: "string", description: "5-field cron, no nicknames." },
						tz: { type: "string", description: "IANA timezone name." },
					},
					required: ["kind", "expr"],
					additionalProperties: false,
				},
			],
		},
		task: {
			type: "string",
			minLength: 1,
			maxLength: 32 * 1024,
			description: "Self-contained instruction the agent runs when the job fires.",
		},
		delivery: {
			type: "object",
			properties: {
				channel: { enum: ["slack", "none"] },
				target: { type: "string", description: '"owner", C... channel id, or U... user id.' },
			},
			additionalProperties: false,
		},
		deleteAfterRun: { type: "boolean" },
	},
	required: ["name", "schedule", "task"],
	additionalProperties: false,
} as const;

const SYSTEM_PROMPT = [
	"You help an operator author a scheduled job for an autonomous AI agent.",
	"Convert their English description into structured fields.",
	"- name: kebab-case label.",
	"- task: imperative, self-contained instruction. The scheduled run does not see current context; include every URL, repo, channel.",
	'- schedule: { kind:"at", at:<ISO8601+offset> } | { kind:"every", intervalMs:<n> } | { kind:"cron", expr:<5-field>, tz:<IANA> }.',
	"- delivery defaults to { channel:'slack', target:'owner' }.",
	"Heuristics: 'every 6h'->every/21600000; '9am weekdays'->cron '0 9 * * 1-5' tz America/Los_Angeles; 'Friday 5pm'->cron '0 17 * * 5'; specific date->at with offset. Default tz America/Los_Angeles if unspecified.",
	"Call `propose_job` once. If the description is incoherent, emit best-effort values and set task to empty string so the operator fills it.",
].join("\n");

function defaultClientFactory(apiKey: string): AnthropicClient {
	return new Anthropic({ apiKey });
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Call Sonnet with a forced tool-use schema and return a structured proposal
 * the operator can review before saving. Does not mutate any state; the job
 * is created only when the operator hits Save.
 */
export async function parseJobDescription(description: string, deps: ParseDeps = {}): Promise<ParseResult> {
	// Explicit null in deps means "no key available" (test seam). Undefined
	// means "fall back to the env var".
	const apiKey = "apiKey" in deps ? deps.apiKey : process.env.ANTHROPIC_API_KEY;
	if (!apiKey) {
		return { ok: false, status: 503, error: "Sonnet assist requires ANTHROPIC_API_KEY." };
	}

	const clientFactory = deps.clientFactory ?? defaultClientFactory;
	const client = clientFactory(apiKey);
	const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const model = deps.model ?? DEFAULT_MODEL;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const response = await client.messages.create(
			{
				model,
				max_tokens: 1024,
				system: SYSTEM_PROMPT,
				tools: [
					{
						name: "propose_job",
						description: "Structured scheduled-job payload the operator reviews and edits before saving.",
						input_schema: PROPOSE_JOB_INPUT_SCHEMA as unknown as {
							type: "object";
							properties?: unknown;
							required?: string[];
						},
					},
				],
				tool_choice: { type: "tool", name: "propose_job" },
				messages: [{ role: "user", content: description }],
			},
			{ signal: controller.signal },
		);

		const blocks = response.content as Array<{ type: string; name?: string; input?: unknown }>;
		const toolBlock = blocks.find((b) => b.type === "tool_use" && b.name === "propose_job");
		if (!toolBlock || toolBlock.input === undefined) {
			return { ok: false, status: 422, error: GENERIC_ERROR };
		}

		const parsed = JobCreateInputSchema.safeParse(toolBlock.input);
		if (!parsed.success) return { ok: false, status: 422, error: GENERIC_ERROR };

		return { ok: true, proposal: parsed.data, warnings: [] };
	} catch (err: unknown) {
		const msg = errorMessage(err);
		if (controller.signal.aborted || /abort|timeout/i.test(msg)) {
			return { ok: false, status: 504, error: "Sonnet assist timed out, please fill the form manually." };
		}
		return { ok: false, status: 422, error: GENERIC_ERROR };
	} finally {
		clearTimeout(timer);
	}
}
