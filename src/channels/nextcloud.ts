/**
 * Nextcloud Talk channel adapter.
 *
 * Receives webhook messages from Nextcloud Talk (signed with
 * X-Nextcloud-Talk-Random + X-Nextcloud-Talk-Signature), verifies them,
 * and posts responses back using the Talk Bot API.
 *
 * This adapter integrates with Phantom's ChannelRouter for proper
 * session tracking, evolution, and memory consolidation.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Channel, ChannelCapabilities, InboundMessage, OutboundMessage, SentMessage } from "./types.ts";

export type NextcloudChannelConfig = {
	sharedSecret: string;
	talkServer: string;
	roomToken: string;
	webhookPath?: string;
};

type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

interface NextcloudWebhookPayload {
	type: string;
	actor?: {
		type: string;
		id: string;
		name: string;
	};
	object?: {
		id?: number | string;
		content?: string;
		name?: string;
	};
	target?: {
		id: string;
		name: string;
	};
}

export class NextcloudChannel implements Channel {
	readonly id = "nextcloud";
	readonly name = "Nextcloud Talk";
	readonly capabilities: ChannelCapabilities = {
		threads: false,
		richText: true,
		attachments: false,
		buttons: false,
	};

	private config: NextcloudChannelConfig;
	private messageHandler: ((message: InboundMessage) => Promise<void>) | null = null;
	private connectionState: ConnectionState = "disconnected";
	private server: ReturnType<typeof Bun.serve> | null = null;

	constructor(config: NextcloudChannelConfig) {
		this.config = config;
	}

	async connect(): Promise<void> {
		if (this.connectionState === "connected") return;
		this.connectionState = "connecting";

		try {
			const port = 3200;
			const webhookPath = this.config.webhookPath ?? "/nextcloud/webhook";

			this.server = Bun.serve({
				port,
				fetch: (req) => this.handleWebRequest(req, webhookPath),
			});

			this.connectionState = "connected";
			console.log(`[nextcloud] Webhook server listening on :${port}${webhookPath}`);
		} catch (err: unknown) {
			this.connectionState = "error";
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`[nextcloud] Failed to connect: ${msg}`);
			throw err;
		}
	}

	async disconnect(): Promise<void> {
		if (this.connectionState === "disconnected") return;

		try {
			this.server?.stop();
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`[nextcloud] Error during disconnect: ${msg}`);
		}

		this.connectionState = "disconnected";
		this.server = null;
		console.log("[nextcloud] Disconnected");
	}

	async send(conversationId: string, message: OutboundMessage): Promise<SentMessage> {
		const roomToken = this.parseConversationId(conversationId);
		if (!roomToken) {
			throw new Error(`Invalid conversation ID: ${conversationId}`);
		}

		const success = await this.postToNextcloud(roomToken, message.text, message.replyToId);
		if (!success) {
			throw new Error("Failed to post message to Nextcloud");
		}

		return {
			id: `nc_${Date.now()}`,
			channelId: this.id,
			conversationId,
			timestamp: new Date(),
		};
	}

	onMessage(handler: (message: InboundMessage) => Promise<void>): void {
		this.messageHandler = handler;
	}

	isConnected(): boolean {
		return this.connectionState === "connected";
	}

	getConnectionState(): ConnectionState {
		return this.connectionState;
	}

	private async handleWebRequest(req: Request, webhookPath: string): Promise<Response> {
		const url = new URL(req.url);

		// Health check
		if (url.pathname === "/health") {
			return Response.json({
				status: "ok",
				service: "nextcloud-channel",
				connected: this.isConnected(),
			});
		}

		// Webhook endpoint
		if (url.pathname === webhookPath && req.method === "POST") {
			return this.handleWebhook(req);
		}

		return Response.json({ error: "Not found" }, { status: 404 });
	}

	private async handleWebhook(req: Request): Promise<Response> {
		const random = req.headers.get("x-nextcloud-talk-random");
		const signature = req.headers.get("x-nextcloud-talk-signature");

		if (!random || !signature) {
			console.warn("[nextcloud] Request missing signature headers");
			return Response.json({ error: "Missing signature headers" }, { status: 401 });
		}

		const body = await req.text();

		if (!this.verifySignature(random, body, signature)) {
			console.warn("[nextcloud] Signature verification failed");
			return Response.json({ error: "Invalid signature" }, { status: 401 });
		}

		let payload: NextcloudWebhookPayload;
		try {
			payload = JSON.parse(body) as NextcloudWebhookPayload;
		} catch {
			return Response.json({ error: "Invalid JSON body" }, { status: 400 });
		}

		const result = await this.processWebhookPayload(payload);
		if (result.error) {
			return Response.json({ error: result.error }, { status: result.status ?? 500 });
		}

		return Response.json({ status: "ok" });
	}

	private async processWebhookPayload(payload: NextcloudWebhookPayload): Promise<{ status?: number; error?: string }> {
		const type = payload.type ?? "";
		const actor = payload.actor;
		const object = payload.object;
		const target = payload.target;

		const actorType = actor?.type ?? "";
		const actorId = actor?.id ?? "unknown";
		const actorName = actor?.name ?? "Unknown";
		const rawContent = ((object?.content as string) || (object?.name as string) || "").trim();

		// Unwrap JSON-encoded system messages
		let message = rawContent;
		try {
			const parsed = JSON.parse(rawContent) as { message?: string };
			if (typeof parsed?.message === "string") {
				message = parsed.message;
			}
		} catch {
			// Plain text - use as-is
		}

		const messageId = object?.id;
		const roomToken = target?.id ?? this.config.roomToken;
		const roomName = target?.name ?? "room";

		console.log(`[nextcloud] ${type} in "${roomName}" from ${actorType} ${actorName}: ${message.slice(0, 80)}`);

		// Only process new messages
		if (type !== "Create") {
			return { status: 200, error: undefined };
		}

		// Ignore messages from bots/applications
		if (actorType === "Application") {
			return { status: 200, error: undefined };
		}

		// Ignore empty messages
		if (!message) {
			return { status: 200, error: undefined };
		}

		const msgIdNum = typeof messageId === "number" ? messageId : typeof messageId === "string" ? parseInt(messageId, 10) : NaN;
		const msgId = !isNaN(msgIdNum) ? msgIdNum : undefined;

		// Set reaction to show processing
		if (msgId !== undefined) {
			await this.setReaction(roomToken, msgId, "🧠", true);
		}

		const inbound: InboundMessage = {
			id: `nc_${Date.now()}`,
			channelId: this.id,
			conversationId: `nextcloud:${roomToken}`,
			senderId: actorId,
			senderName: actorName,
			text: message,
			timestamp: new Date(),
			metadata: {
				nextcloudRoomToken: roomToken,
				nextcloudMessageId: msgId,
				nextcloudServer: this.config.talkServer,
			},
		};

		if (this.messageHandler) {
			try {
				await this.messageHandler(inbound);
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				console.error(`[nextcloud] Error handling message: ${msg}`);
				if (msgId !== undefined) {
					await this.setReaction(roomToken, msgId, "🧠", false);
					await this.setReaction(roomToken, msgId, "⚠️", true);
				}
				return { status: 500, error: "Message handling failed" };
			}
		}

		return { status: 200, error: undefined };
	}

	private verifySignature(random: string, body: string, signature: string): boolean {
		try {
			const hmac = createHmac("sha256", this.config.sharedSecret);
			hmac.update(random);
			hmac.update(body);
			const expected = hmac.digest("hex");
			const sigBuf = Buffer.from(signature, "hex");
			const expBuf = Buffer.from(expected, "hex");
			if (sigBuf.length === 0 || sigBuf.length !== expBuf.length) return false;
			return timingSafeEqual(sigBuf, expBuf);
		} catch {
			return false;
		}
	}

	private signRequest(random: string, content: string): string {
		const hmac = createHmac("sha256", this.config.sharedSecret);
		hmac.update(random);
		hmac.update(content);
		return hmac.digest("hex");
	}

	private async postToNextcloud(roomToken: string, message: string, replyTo?: string): Promise<boolean> {
		const url = `https://${this.config.talkServer}/ocs/v2.php/apps/spreed/api/v1/bot/${roomToken}/message`;
		const payload: Record<string, unknown> = { message };
		if (replyTo !== undefined) {
			const replyId = parseInt(replyTo, 10);
			if (!isNaN(replyId)) {
				payload.replyTo = replyId;
			}
		}

		const bodyStr = JSON.stringify(payload);
		const random = crypto.randomUUID().replace(/-/g, "");
		const sig = this.signRequest(random, message);

		try {
			const res = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"OCS-APIRequest": "true",
					"X-Nextcloud-Talk-Bot-Random": random,
					"X-Nextcloud-Talk-Bot-Signature": sig,
				},
				body: bodyStr,
			});

			if (!res.ok) {
				const text = await res.text();
				console.error(`[nextcloud] Bot API error: ${res.status} – ${text.slice(0, 200)}`);
				return false;
			}
			return true;
		} catch (err) {
			console.error("[nextcloud] Network error posting to Nextcloud:", err);
			return false;
		}
	}

	private async setReaction(roomToken: string, messageId: number, reaction: string, add: boolean): Promise<void> {
		const url = `https://${this.config.talkServer}/ocs/v2.php/apps/spreed/api/v1/bot/${roomToken}/reaction/${messageId}`;
		const bodyStr = JSON.stringify({ reaction });
		const random = crypto.randomUUID().replace(/-/g, "");
		const sig = this.signRequest(random, reaction);

		try {
			const res = await fetch(url, {
				method: add ? "POST" : "DELETE",
				headers: {
					"Content-Type": "application/json",
					"OCS-APIRequest": "true",
					"X-Nextcloud-Talk-Bot-Random": random,
					"X-Nextcloud-Talk-Bot-Signature": sig,
				},
				body: bodyStr,
			});

			if (!res.ok) {
				const text = await res.text();
				console.error(`[nextcloud] Reaction ${add ? "add" : "remove"} error: ${res.status} – ${text.slice(0, 200)}`);
			}
		} catch (err) {
			console.error("[nextcloud] Network error setting reaction:", err);
		}
	}

	private parseConversationId(conversationId: string): string | null {
		// Format: "nextcloud:{room_token}"
		const parts = conversationId.split(":");
		if (parts.length !== 2 || parts[0] !== "nextcloud") {
			return null;
		}
		return parts[1];
	}

	/**
	 * Set reactions on messages when the agent responds.
	 * This is called by the status reactions system if extended for Nextcloud.
	 */
	async setMessageReaction(roomToken: string, messageId: number, reaction: "thinking" | "done" | "error"): Promise<void> {
		const emoji = reaction === "thinking" ? "🧠" : reaction === "done" ? "✅" : "⚠️";
		await this.setReaction(roomToken, messageId, emoji, true);
	}

	async clearMessageReaction(roomToken: string, messageId: number, reaction: "thinking" | "done" | "error"): Promise<void> {
		const emoji = reaction === "thinking" ? "🧠" : reaction === "done" ? "✅" : "⚠️";
		await this.setReaction(roomToken, messageId, emoji, false);
	}
}
