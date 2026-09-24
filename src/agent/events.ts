import type { PendingAttachment } from "../channels/types.ts";

export type AgentCost = {
	totalUsd: number;
	inputTokens: number;
	outputTokens: number;
	modelUsage: Record<string, { inputTokens: number; outputTokens: number; costUsd: number }>;
};

export type AgentStopReason =
	| "success"
	| "error_max_turns"
	| "error_max_budget_usd"
	| "error_during_execution"
	| "error_timeout"
	| "error_max_structured_output_retries";

export type AgentEvent =
	| { type: "init"; sessionId: string; model: string }
	| { type: "assistant_message"; content: string; sessionId: string }
	| { type: "tool_use"; tool: string; sessionId: string }
	| { type: "status"; message: string; sessionId: string }
	| {
			type: "result";
			text: string;
			sessionId: string;
			cost: AgentCost;
			durationMs: number;
			stopReason: AgentStopReason;
			numTurns: number;
	  }
	| { type: "error"; message: string };

export type AgentResponse = {
	text: string;
	sessionId: string;
	cost: AgentCost;
	durationMs: number;
	// Files queued via phantom_send_file during the turn, delivered by the
	// channel layer with the response text
	attachments?: PendingAttachment[];
};

export function emptyCost(): AgentCost {
	return {
		totalUsd: 0,
		inputTokens: 0,
		outputTokens: 0,
		modelUsage: {},
	};
}
