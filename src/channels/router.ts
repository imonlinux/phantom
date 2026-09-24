import { attachmentsFallbackNote } from "./attachments.ts";
import type { Channel, InboundMessage, OutboundMessage, SentMessage } from "./types.ts";

type MessageHandler = (message: InboundMessage) => Promise<void>;

export class ChannelRouter {
	private channels = new Map<string, Channel>();
	private handler: MessageHandler | null = null;

	register(channel: Channel): void {
		if (this.channels.has(channel.id)) {
			throw new Error(`Channel already registered: ${channel.id}`);
		}
		this.channels.set(channel.id, channel);
		channel.onMessage((msg) => this.routeInbound(msg));
	}

	onMessage(handler: MessageHandler): void {
		this.handler = handler;
	}

	async connectAll(): Promise<void> {
		const results = await Promise.allSettled([...this.channels.values()].map((ch) => ch.connect()));

		for (const [i, result] of results.entries()) {
			if (result.status === "rejected") {
				const ch = [...this.channels.values()][i];
				console.error(`[router] Failed to connect channel ${ch.id}: ${result.reason}`);
			}
		}
	}

	async disconnectAll(): Promise<void> {
		const results = await Promise.allSettled([...this.channels.values()].map((ch) => ch.disconnect()));

		for (const [i, result] of results.entries()) {
			if (result.status === "rejected") {
				const ch = [...this.channels.values()][i];
				console.error(`[router] Failed to disconnect channel ${ch.id}: ${result.reason}`);
			}
		}
	}

	async send(channelId: string, conversationId: string, message: OutboundMessage): Promise<SentMessage> {
		const channel = this.channels.get(channelId);
		if (!channel) {
			throw new Error(`Unknown channel: ${channelId}`);
		}
		// A channel without attachment transport never silently drops a
		// queued file: the note names it and where it sits on disk so the
		// user can still reach it.
		const outbound: OutboundMessage =
			message.attachments && message.attachments.length > 0 && !channel.capabilities.attachments
				? { ...message, text: message.text + attachmentsFallbackNote(message.attachments) }
				: message;
		return channel.send(conversationId, outbound);
	}

	getChannelIds(): string[] {
		return [...this.channels.keys()];
	}

	healthCheck(): Record<string, boolean> {
		const result: Record<string, boolean> = {};
		for (const [id] of this.channels) {
			result[id] = true;
		}
		return result;
	}

	private async routeInbound(message: InboundMessage): Promise<void> {
		if (!this.handler) {
			console.error("[router] No message handler registered, dropping message");
			return;
		}

		try {
			await this.handler(message);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`[router] Error handling message from ${message.channelId}: ${msg}`);
		}
	}
}
