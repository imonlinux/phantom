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

import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import type { Channel, ChannelCapabilities, InboundMessage, OutboundMessage, SentMessage } from "./types.ts";

export type NextcloudChannelConfig = {
	sharedSecret: string;
	talkServer: string;
	roomToken: string;
	webhookPath?: string;
	port?: number;
};

type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

// LRU cache for replay attack protection (Fix #1)
const MAX_NONCE_CACHE_SIZE = 1000;
const NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes
interface NonceEntry {
	nonce: string;
	expiresAt: number;
}

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
		reactions: true, // Fix #21
	};

	private config: NextcloudChannelConfig;
	private messageHandler: ((message: InboundMessage) => Promise<void>) | null = null;
	private connectionState: ConnectionState = "disconnected";
	private server: ReturnType<typeof Bun.serve> | null = null;
	// Fix #1: Replay attack protection
	private nonceCache: Map<string, NonceEntry> = new Map();
	private nonceCachePruneTimer: ReturnType<typeof setInterval> | null = null;

	constructor(config: NextcloudChannelConfig) {
		// Fix #14: Normalize webhookPath in constructor
		this.config = {
			...config,
			webhookPath: config.webhookPath ?? "/nextcloud/webhook",
			port: config.port ?? 3200,
		};
	}

	async connect(): Promise<void> {
		if (this.connectionState === "connected") return;
		this.connectionState = "connecting";

		try {
			// Fix #13: Use configurable port instead of hardcoded 3200
			const port = this.config.port ?? 3200;
			const webhookPath = this.config.webhookPath ?? "/nextcloud/webhook";

			this.server = Bun.serve({
				port,
				fetch: (req) => this.handleWebRequest(req, webhookPath),
			});

			// Fix #2: Start periodic nonce cache pruning when connected
			this.nonceCachePruneTimer = setInterval(() => {
				this.pruneNonces();
			}, 60 * 1000); // Prune every minute

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

		// Clear nonce cache timer (Fix #1)
		if (this.nonceCachePruneTimer) {
			clearInterval(this.nonceCachePruneTimer);
			this.nonceCachePruneTimer = null;
		}
		this.nonceCache.clear();

		console.log("[nextcloud] Disconnected");
	}

	// Fix #1: Replay attack protection - check if nonce was seen before
	private isNonceSeen(nonce: string): boolean {
		const entry = this.nonceCache.get(nonce);
		if (!entry) return false;

		// Check if nonce has expired
		if (Date.now() > entry.expiresAt) {
			this.nonceCache.delete(nonce);
			return false;
		}

		return true;
	}

	// Fix #1: Add nonce to cache
	private addNonce(nonce: string): void {
		// Enforce cache size limit (FIFO eviction - insertion order)
		if (this.nonceCache.size >= MAX_NONCE_CACHE_SIZE) {
			// Remove oldest entry (first key in Map)
			const firstKey = this.nonceCache.keys().next().value;
			if (firstKey) {
				this.nonceCache.delete(firstKey);
			}
		}

		this.nonceCache.set(nonce, {
			nonce,
			expiresAt: Date.now() + NONCE_TTL_MS,
		});
	}

	// Fix #1: Prune expired nonces
	private pruneNonces(): void {
		const now = Date.now();
		let pruned = 0;

		for (const [nonce, entry] of this.nonceCache.entries()) {
			if (now > entry.expiresAt) {
				this.nonceCache.delete(nonce);
				pruned++;
			}
		}

		if (pruned > 0) {
			console.log(`[nextcloud] Pruned ${pruned} expired nonces from cache`);
		}
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

		// Fix #4: Use crypto.randomUUID() instead of Date.now()
		return {
			id: randomUUID(),
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

		// Fix #15: Check webhook path first to avoid path precedence issues
		if (url.pathname === webhookPath && req.method === "POST") {
			return this.handleWebhook(req);
		}

		// Health check (only if not a webhook path)
		if (url.pathname === "/health") {
			return Response.json({
				status: "ok",
				service: "nextcloud-channel",
				connected: this.isConnected(),
			});
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

		// Fix #1: Check for replay attacks BEFORE verifying signature
		if (this.isNonceSeen(random)) {
			console.warn("[nextcloud] Replay attack detected - duplicate nonce");
			return Response.json({ error: "Replay detected" }, { status: 401 });
		}

		// Fix #2: Add request size limit before buffering body
		const contentLength = req.headers.get("content-length");
		const MAX_BODY_SIZE = 64 * 1024; // 64 KB - NextCloud messages cap at 32,000 chars
		if (contentLength) {
			const length = parseInt(contentLength, 10);
			if (!isNaN(length) && length > MAX_BODY_SIZE) {
				console.warn(`[nextcloud] Request body too large: ${length} bytes`);
				return Response.json({ error: "Request body too large" }, { status: 413 });
			}
		}

		const body = await req.text();

		// Double-check body size after reading (in case Content-Length was missing/invalid)
		if (body.length > MAX_BODY_SIZE) {
			console.warn(`[nextcloud] Request body too large after read: ${body.length} bytes`);
			return Response.json({ error: "Request body too large" }, { status: 413 });
		}

		if (!this.verifySignature(random, body, signature)) {
			console.warn("[nextcloud] Signature verification failed");
			return Response.json({ error: "Invalid signature" }, { status: 401 });
		}

		// Fix #1: Add nonce to cache after successful signature verification
		this.addNonce(random);

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

		// Fix #7: Proper JSON unwrapping for ActivityStreams Note objects
		let message = rawContent;
		const objectType = (object?.type as string) ?? "";
		if (objectType === "Note" && rawContent.startsWith("{")) {
			try {
				const parsed = JSON.parse(rawContent) as { message?: string; parameters?: Record<string, unknown> };
				if (typeof parsed?.message === "string") {
					message = parsed.message;
				}
			} catch {
				// Invalid JSON - use as-is
			}
		}

		// Fix #6: Reject payloads without target.id instead of silent fallback
		const roomToken = target?.id;
		if (!roomToken) {
			console.warn("[nextcloud] Webhook payload missing target.id");
			return { status: 400, error: "Missing target.id" };
		}

		const roomName = target?.name ?? "room";

		console.log(`[nextcloud] ${type} in "${roomName}" from ${actorType} ${actorName}: ${message.slice(0, 80)}`);

		// Only process new messages
		if (type !== "Create") {
			return { status: 200, error: undefined };
		}

		// Fix #12: Bot loop guard - ignore messages from applications/bots
		if (actorType === "Application") {
			return { status: 200, error: undefined };
		}

		// Ignore empty messages
		if (!message) {
			return { status: 200, error: undefined };
		}

		const msgIdNum = typeof object?.id === "number" ? object.id : typeof object?.id === "string" ? parseInt(object.id, 10) : NaN;
		const msgId = !isNaN(msgIdNum) ? msgIdNum : undefined;

		// Set reaction to show processing
		if (msgId !== undefined) {
			await this.setReaction(roomToken, msgId, "🧠", true);
		}

		// Fix #4: Use crypto.randomUUID() instead of Date.now()
		const inbound: InboundMessage = {
			id: randomUUID(),
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
				// Fix #3: Avoid msgId/msg name collision
				const errMsg = err instanceof Error ? err.message : String(err);
				console.error(`[nextcloud] Error handling message: ${errMsg}`);
				if (msgId !== undefined) {
					await this.setReaction(roomToken, msgId, "🧠", false);
					// Fix #8: Use emoji without variation selector to avoid validation issues
					await this.setReaction(roomToken, msgId, "\u26A0", true); // ⚠ without variation selector
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
		// Fix #18: Document asymmetric signing
		// NextCloud Talk uses asymmetric signing:
		// - INBOUND verification: HMAC(random + full_body, secret)
		// - OUTBOUND requests: HMAC(random + content_only, secret)
		// This is the #1 cause of 401 errors in Talk bot implementations.
		// See: https://nextcloud-talk.readthedocs.io/en/latest/bots/
		const hmac = createHmac("sha256", this.config.sharedSecret);
		hmac.update(random);
		hmac.update(content);
		return hmac.digest("hex");
	}

	private async postToNextcloud(roomToken: string, message: string, replyTo?: string): Promise<boolean> {
		// Fix #17: Validate and sanitize talkServer config
		let talkServer = this.config.talkServer.trim();
		// Remove scheme if present
		if (talkServer.startsWith("http://")) {
			talkServer = talkServer.slice(7);
		} else if (talkServer.startsWith("https://")) {
			talkServer = talkServer.slice(8);
		}
		// Remove trailing slash
		if (talkServer.endsWith("/")) {
			talkServer = talkServer.slice(0, -1);
		}

		// Fix #17: URL-encode roomToken to prevent injection
		const encodedRoomToken = encodeURIComponent(roomToken);
		const url = `https://${talkServer}/ocs/v2.php/apps/spreed/api/v1/bot/${encodedRoomToken}/message`;

		const payload: Record<string, unknown> = { message };
		if (replyTo !== undefined) {
			const replyId = parseInt(replyTo, 10);
			if (!isNaN(replyId)) {
				payload.replyTo = replyId;
			}
		}

		const bodyStr = JSON.stringify(payload);
		const random = randomUUID().replace(/-/g, "");
		const sig = this.signRequest(random, message);

		// Fix #16: Add retry/backoff for transient failures
		const maxRetries = 3;
		let lastError: Error | null = null;

		for (let attempt = 0; attempt < maxRetries; attempt++) {
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

				if (res.ok) {
					return true;
				}

				// Handle specific error codes
				if (res.status === 429) {
					if (attempt < maxRetries - 1) {
						// Rate limited - check Retry-After header
						const retryAfter = res.headers.get("Retry-After");
						const delayMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 1000 * (attempt + 1);
						console.log(`[nextcloud] Rate limited, retrying after ${delayMs}ms (attempt ${attempt + 1}/${maxRetries})`);
						await this.sleep(delayMs);
						continue;
					} else {
						// Final attempt - all retries exhausted
						console.error(`[nextcloud] Rate limited, all ${maxRetries} retries exhausted`);
						return false;
					}
				}

				if (res.status >= 500 && res.status < 600 && attempt < maxRetries - 1) {
					// Server error - retry with exponential backoff plus jitter
					const base = 1000 * Math.pow(2, attempt);
					const delayMs = Math.floor(base * (0.5 + Math.random())); // 50%–150% of base
					console.log(`[nextcloud] Server error ${res.status}, retrying after ${delayMs}ms (attempt ${attempt + 1}/${maxRetries})`);
					await this.sleep(delayMs);
					continue;
				}

				// Non-retryable error
				const text = await res.text();
				console.error(`[nextcloud] Bot API error: ${res.status} – ${text.slice(0, 200)}`);
				return false;
			} catch (err) {
				lastError = err instanceof Error ? err : new Error(String(err));
				if (attempt < maxRetries - 1) {
					const base = 1000 * Math.pow(2, attempt);
					const delayMs = Math.floor(base * (0.5 + Math.random())); // 50%–150% of base
					console.log(`[nextcloud] Network error, retrying after ${delayMs}ms (attempt ${attempt + 1}/${maxRetries})`);
					await this.sleep(delayMs);
				}
			}
		}

		// All retries exhausted
		console.error("[nextcloud] All retries exhausted for postToNextcloud:", lastError?.message);
		return false;
	}

	// Helper method for retry delays
	private sleep(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}

	// Fix #10: Make setReaction return boolean for error handling
	private async setReaction(roomToken: string, messageId: number, reaction: string, add: boolean): Promise<boolean> {
		// Fix #17: Validate and sanitize talkServer config
		let talkServer = this.config.talkServer.trim();
		if (talkServer.startsWith("http://")) {
			talkServer = talkServer.slice(7);
		} else if (talkServer.startsWith("https://")) {
			talkServer = talkServer.slice(8);
		}
		if (talkServer.endsWith("/")) {
			talkServer = talkServer.slice(0, -1);
		}

		// Fix #17: URL-encode parameters
		const encodedRoomToken = encodeURIComponent(roomToken);
		const encodedMessageId = encodeURIComponent(String(messageId));
		const url = `https://${talkServer}/ocs/v2.php/apps/spreed/api/v1/bot/${encodedRoomToken}/reaction/${encodedMessageId}`;

		const bodyStr = JSON.stringify({ reaction });
		const random = randomUUID().replace(/-/g, "");
		const sig = this.signRequest(random, reaction);

		// Fix #16: Add retry/backoff for transient failures
		const maxRetries = 2;
		for (let attempt = 0; attempt < maxRetries; attempt++) {
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

				// Fix #9: Handle 404/409 reaction responses gracefully
				if (res.status === 404 && !add) {
					// Reaction doesn't exist - that's fine when removing
					console.log(`[nextcloud] Reaction ${reaction} not found (already removed)`);
					return true;
				}
				if (res.status === 409 && add) {
					// Reaction already exists - that's fine
					console.log(`[nextcloud] Reaction ${reaction} already exists`);
					return true;
				}

				if (res.ok) {
					return true;
				}

				if (res.status >= 500 && res.status < 600 && attempt < maxRetries - 1) {
					// Server error - retry with exponential backoff plus jitter
					const base = 1000 * Math.pow(2, attempt);
					const delayMs = Math.floor(base * (0.5 + Math.random())); // 50%–150% of base
					console.log(`[nextcloud] Reaction error ${res.status}, retrying after ${delayMs}ms (attempt ${attempt + 1}/${maxRetries})`);
					await this.sleep(delayMs);
					continue;
				}

				// Non-retryable error
				const text = await res.text();
				console.error(`[nextcloud] Reaction ${add ? "add" : "remove"} error: ${res.status} – ${text.slice(0, 200)}`);
				return false;
			} catch (err) {
				if (attempt < maxRetries - 1) {
					const base = 1000 * Math.pow(2, attempt);
					const delayMs = Math.floor(base * (0.5 + Math.random())); // 50%–150% of base
					console.log(`[nextcloud] Network error setting reaction, retrying after ${delayMs}ms (attempt ${attempt + 1}/${maxRetries})`);
					await this.sleep(delayMs);
				} else {
					console.error("[nextcloud] Network error setting reaction:", err);
					return false;
				}
			}
		}

		return false;
	}

	private parseConversationId(conversationId: string): string | null {
		// Fix #5: Use indexOf + slice instead of split to handle colons in tokens
		// Format: "nextcloud:{room_token}"
		const prefix = "nextcloud:";
		if (!conversationId.startsWith(prefix)) {
			return null;
		}
		return conversationId.slice(prefix.length);
	}

	/**
	 * Set reactions on messages when the agent responds.
	 * This is called by the status reactions system if extended for Nextcloud.
	 */
	async setMessageReaction(roomToken: string, messageId: number, reaction: "thinking" | "done" | "error"): Promise<boolean> {
		// Fix #8: Use emoji without variation selector to avoid validation issues
		const emoji = reaction === "thinking" ? "🧠" : reaction === "done" ? "✅" : "\u26A0"; // ⚠ without variation selector
		return await this.setReaction(roomToken, messageId, emoji, true);
	}

	async clearMessageReaction(roomToken: string, messageId: number, reaction: "thinking" | "done" | "error"): Promise<boolean> {
		// Fix #8: Use emoji without variation selector to avoid validation issues
		const emoji = reaction === "thinking" ? "🧠" : reaction === "done" ? "✅" : "\u26A0"; // ⚠ without variation selector
		return await this.setReaction(roomToken, messageId, emoji, false);
	}
}
