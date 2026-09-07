/**
 * Agent interrupt support (roadmap: channel-agnostic turn cancellation).
 *
 * Two triggers share one runtime entry point (AgentRuntime.interrupt):
 * - A text trigger ("stop", "/stop", "cancel", or a bare stop emoji) caught
 *   by the router pre-gate in index.ts before a turn starts. Channel access
 *   control has already filtered the sender by that point.
 * - A stop-emoji reaction on the in-flight message (Talk). The in-flight
 *   registry below maps the reacted-to message id back to its conversation.
 *
 * The interrupted turn classifies itself in AgentRuntime.runQuery: the
 * interrupt flag suppresses the error surface and the turn ends as a plain
 * "Stopped." response, delivered to the user through the normal pipeline.
 */

export const INTERRUPT_ACK = "Stopped.";

export type InterruptTarget = {
	channelId: string;
	conversationId: string;
};

export function isInterruptText(text: string): boolean {
	const t = text.trim().replaceAll("\uFE0F", "").toLowerCase();
	return t === "stop" || t === "/stop" || t === "cancel" || t === "🛑";
}

// Keyed by `${channelId}:${messageId}`; one entry per running turn that
// has a channel-side message anchor (Talk status reactions anchor to the
// user's message). feedback.ts uses the same module-singleton pattern.
const inFlightByMessage = new Map<string, InterruptTarget>();

export function registerInFlightMessage(channelId: string, messageId: number, target: InterruptTarget): void {
	inFlightByMessage.set(`${channelId}:${messageId}`, target);
}

export function unregisterInFlightMessage(channelId: string, messageId: number): void {
	inFlightByMessage.delete(`${channelId}:${messageId}`);
}

export function findInFlightMessage(channelId: string, messageId: number): InterruptTarget | undefined {
	return inFlightByMessage.get(`${channelId}:${messageId}`);
}
