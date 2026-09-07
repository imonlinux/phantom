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
import { Database } from "bun:sqlite";
import type { Channel, ChannelCapabilities, InboundMessage, OutboundMessage, SentMessage } from "./types.ts";
import type { SessionStore } from "../agent/session-store.ts";
import { emitFeedback } from "./feedback.ts";

export type NextcloudChannelConfig = {
	sharedSecret: string;
	talkServer: string;
	roomToken: string;
	webhookPath?: string;
	port?: number;
	sessionWindowMinutes?: number;
	botId?: string; // Fix #12: Bot's own ID for self-filtering to prevent bot loops
	ownerUserId?: string; // Phase 3: Owner access control - only this user can trigger the bot
	enableFeedback?: boolean; // Enable feedback collection via reactions
	sendIntro?: boolean; // Phase 6: Enable proactive intro message
	// Talk 24+: post responses into the Talk thread a message belongs to.
	// The bot only ever joins existing threads via threadId on sendMessage;
	// it cannot create threads (bot POST responses carry no message ID).
	enableThreads?: boolean;
};

// Bot feature bitmask from POST /bot/ask-features (Talk 24+, requires the
// bot-features-api capability). Values mirror spreed's lib/Model/Bot.php.
export const NEXTCLOUD_BOT_FEATURES = {
	WEBHOOK: 1,
	RESPONSE: 2,
	EVENT: 4,
	REACTION: 8,
} as const;

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
		type?: string; // "Note" for chat messages, "react" for reaction events
		id?: number | string;
		content?: string;
		name?: string;
		parentMessageId?: number | string;
		threadId?: number | string; // Talk 24+: present when the message lives inside a thread
		reaction?: string; // For reaction events
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
		// Talk 24+ supports threads on the Bot API (threadTitle/threadId on
		// sendMessage, threadId in webhook payloads). We join threads but
		// never create them (see enableThreads).
		threads: true,
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
	// Session store for time-window coalescing
	private sessionStore: SessionStore | null = null;
	// Phase 3: Owner access control
	private rejectedUsers = new Set<string>();
	// Phase 6: Database for intro tracking
	private db: Database | null = null;
	// Talk 24+: cached ask-features bitmask, null until probed or on failure
	private botFeatures: number | null = null;

	constructor(config: NextcloudChannelConfig, sessionStore?: SessionStore) {
		// Fix #14: Normalize webhookPath in constructor
		this.config = {
			...config,
			webhookPath: config.webhookPath ?? "/nextcloud/webhook",
			port: config.port ?? 3200,
			sessionWindowMinutes: config.sessionWindowMinutes ?? 30,
		};
		this.sessionStore = sessionStore ?? null;

		// Phase 6: Initialize database for intro tracking
		try {
			this.db = new Database("data/phantom.db");
			// Ensure table exists (should already exist from migrations)
			this.db.exec(`
				CREATE TABLE IF NOT EXISTS channel_intros (
					channel_id TEXT PRIMARY KEY,
					intro_sent_at TEXT,
					sent_to_chat_id TEXT
				)
			`);
		} catch (err) {
			console.warn("[nextcloud] Failed to initialize database for intro tracking:", err);
			this.db = null;
		}
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

			// Talk 24+: probe advertised bot features (webhook/response/event/reaction).
			// Fire-and-forget: the result only feeds logs and warnings, and connect()
			// must not fail on servers that predate ask-features.
			void this.queryBotFeatures();

			// Phase 6: Send proactive intro if enabled and first run
			if (this.config.sendIntro) {
				await this.sendProactiveIntroIfFirstRun();
			}
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

		// Close database connection
		if (this.db) {
			this.db.close();
			this.db = null;
		}

		console.log("[nextcloud] Disconnected");
	}

	/**
	 * Send a direct message to a user via Nextcloud Talk.
	 * Used by the scheduler to deliver job results.
	 * For Nextcloud, we use the configured room token (single room deployment).
	 * The username parameter is ignored since Nextcloud Talk doesn't have per-user DMs in the same way.
	 */
	async sendDirectMessage(_username: string, text: string): Promise<boolean> {
		const roomToken = this.config.roomToken;
		return await this.postToNextcloud(roomToken, text);
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
		// Fix: Extract only room token from thread-scoped conversationId for outbound posts
		const parsed = this.parseConversationId(conversationId);
		if (!parsed) {
			throw new Error(`Invalid conversation ID: ${conversationId}`);
		}
		const roomToken = parsed.split(":")[0];
		if (!roomToken) {
			throw new Error(`Invalid conversation ID (no room token): ${conversationId}`);
		}

		// A "thread{N}" suffix is a real Talk thread root; map it back to the
		// numeric threadId for the bot sendMessage call so responses land in
		// the thread instead of the room's top level.
		const suffix = parsed.slice(roomToken.length + 1);
		const threadMatch = /^thread(\d+)$/.exec(suffix);
		const threadId = threadMatch ? parseInt(threadMatch[1], 10) : undefined;

		const success = await this.postToNextcloud(roomToken, message.text, message.replyToId, threadId);
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

	// Configuration getters for interaction features
	getEnableFeedback(): boolean {
		return this.config.enableFeedback ?? true;
	}

	getEnableThreads(): boolean {
		return this.config.enableThreads ?? true;
	}

	getConnectionState(): ConnectionState {
		return this.connectionState;
	}

	/**
	 * Query the server-side bot feature bitmask (Talk 24+, bot-features-api).
	 * Best-effort probe: failures leave botFeatures null and are logged, never
	 * thrown, so callers (connect) are unaffected on older Talk releases.
	 */
	async queryBotFeatures(): Promise<number | null> {
		try {
			// Fix #17 pattern: sanitize talkServer the same way postToNextcloud does
			let talkServer = this.config.talkServer.trim();
			if (talkServer.startsWith("http://")) {
				talkServer = talkServer.slice(7);
			} else if (talkServer.startsWith("https://")) {
				talkServer = talkServer.slice(8);
			}
			if (talkServer.endsWith("/")) {
				talkServer = talkServer.slice(0, -1);
			}
			const url = `https://${talkServer}/ocs/v2.php/apps/spreed/api/v1/bot/ask-features`;

			// ask-features signs HMAC(random + room token), same scheme as the
			// other outbound bot calls (Fix #18 asymmetry).
			const bodyStr = JSON.stringify({ token: this.config.roomToken });
			const random = randomUUID().replace(/-/g, "");
			const sig = this.signRequest(random, this.config.roomToken);

			const res = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					// OCS endpoints answer XML on a 200 when Accept is absent; the
					// probe would then fail to parse every valid response
					"Accept": "application/json",
					"OCS-APIRequest": "true",
					"X-Nextcloud-Talk-Bot-Random": random,
					"X-Nextcloud-Talk-Bot-Signature": sig,
				},
				body: bodyStr,
			});

			if (!res.ok) {
				console.warn(`[nextcloud] ask-features probe failed: ${res.status}`);
				return null;
			}

			const json = (await res.json()) as { ocs?: { data?: { features?: number } } };
			const features = json?.ocs?.data?.features;
			if (typeof features !== "number") {
				console.warn("[nextcloud] ask-features response missing features bitmask");
				return null;
			}

			this.botFeatures = features;

			const featureNames: Array<[string, number]> = [
				["webhook", NEXTCLOUD_BOT_FEATURES.WEBHOOK],
				["response", NEXTCLOUD_BOT_FEATURES.RESPONSE],
				["event", NEXTCLOUD_BOT_FEATURES.EVENT],
				["reaction", NEXTCLOUD_BOT_FEATURES.REACTION],
			];
			const names = featureNames.filter(([, bit]) => (features & bit) !== 0).map(([name]) => name);
			console.log(`[nextcloud] Bot features: ${names.join(", ") || "none"} (0b${features.toString(2)})`);

			if (this.getEnableFeedback() && (features & NEXTCLOUD_BOT_FEATURES.REACTION) === 0) {
				console.warn(
					"[nextcloud] enable_feedback is on but the server does not advertise the reaction feature; reaction feedback will not fire",
				);
			}

			return features;
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`[nextcloud] ask-features probe error: ${msg}`);
			return null;
		}
	}

	getBotFeatures(): number | null {
		return this.botFeatures;
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

	/**
	 * Handle incoming webhook from Nextcloud Talk.
	 *
	 * IMPORTANT: Returns 200 OK immediately and processes asynchronously to avoid
	 * webhook timeouts. Agent sessions can take 50-80+ seconds to complete, but
	 * webhooks should return quickly to prevent timeouts and retries.
	 *
	 * Security checks (signature, nonce, size limits) happen synchronously before
	 * the async processing to ensure rejected requests never reach the agent.
	 */
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
		// This happens BEFORE async processing to prevent race conditions
		this.addNonce(random);

		let payload: NextcloudWebhookPayload;
		try {
			payload = JSON.parse(body) as NextcloudWebhookPayload;
		} catch {
			return Response.json({ error: "Invalid JSON body" }, { status: 400 });
		}

		// CRITICAL: Process asynchronously and return 200 immediately to avoid webhook timeouts.
		// Agent sessions take 50-80+ seconds, but webhooks should return within seconds.
		// The nonce cache prevents duplicate processing if Nextcloud retries.
		this.processWebhookPayloadAsync(payload, random);

		return Response.json({ status: "ok" });
	}

	/**
	 * Process webhook payload asynchronously without blocking the HTTP response.
	 * Logs errors but never throws to prevent unhandled promise rejections.
	 *
	 * @param payload - Validated Nextcloud webhook payload
	 * @param nonce - Request nonce for logging purposes
	 */
	private processWebhookPayloadAsync(payload: NextcloudWebhookPayload, nonce: string): void {
		const nonceLog = nonce.slice(0, 8) + "..."; // First 8 chars for logging
		// Fire-and-forget: process without awaiting. Errors are logged but not thrown.
		this.processWebhookPayload(payload)
			.then((result) => {
				if (result.error) {
					console.warn(`[nextcloud] Async webhook ${nonceLog} processing error: ${result.error}`);
				} else {
					console.log(`[nextcloud] Async webhook ${nonceLog} processing completed`);
				}
			})
			.catch((err: unknown) => {
				const msg = err instanceof Error ? err.message : String(err);
				console.error(`[nextcloud] Async webhook ${nonceLog} processing failed: ${msg}`);
				// Don't throw - this is a background task and the response was already sent
			});
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

		// Talk webhook types observed in production: "Create" (new message),
		// "Like" (reaction added), "Undo" (reaction removed), "Activity"
		// (system message such as "{actor} deleted a reaction"). Only Create
		// is logged at info level; the bot receives echoes of its own reaction
		// lifecycle for every change, and logging those at info turns the log
		// into reaction spam during busy turns.
		if (type === "Create") {
			console.log(`[nextcloud] ${type} in "${roomName}" from ${actorType} ${actorName} (actorId=${actorId}): ${message.slice(0, 80)}`);
		}

		// Reaction feedback: Talk delivers reaction additions as "Like"
		// (there is no "React" type; that routing never fired).
		if (type === "Like") {
			this.handleReactionFeedback(payload, roomToken);
			return { status: 200, error: undefined };
		}

		// Only process new messages
		if (type !== "Create") {
			return { status: 200, error: undefined };
		}

		// Fix #12: Bot loop guard - ignore messages from applications/bots and self
		// Multiple bots in the same room can trigger each other without this check
		if (actorType === "Application") {
			return { status: 200, error: undefined };
		}
		// If bot ID is configured, ignore messages where actorId matches the bot's own ID
		// This prevents the bot from processing its own messages in multi-bot rooms
		if (this.config.botId && actorId === this.config.botId) {
			console.log(`[nextcloud] Ignoring message from self (botId=${actorId})`);
			return { status: 200, error: undefined };
		}

		// Phase 3: Owner access control - reject messages from non-owners
		if (!this.isOwner(actorId)) {
			console.log(`[nextcloud] Rejecting message from non-owner ${actorId} (owner=${this.config.ownerUserId ?? "none"})`);
			await this.rejectNonOwner(actorId, roomToken);
			return { status: 200, error: undefined };
		}

		// Ignore empty messages
		if (!message) {
			return { status: 200, error: undefined };
		}

		const msgIdNum = typeof object?.id === "number" ? object.id : typeof object?.id === "string" ? parseInt(object.id, 10) : NaN;
		const msgId = !isNaN(msgIdNum) ? msgIdNum : undefined;

		// Fix: Time-window coalescing for session continuity
		// Precedence: a real Talk thread (Talk 24+ payloads carry object.threadId
		// when the message lives in one) beats an explicit reply, which beats the
		// time-window lookup. Thread roots use a "thread{N}" namespace so they
		// can never collide with message-ID roots, and send() maps them back to
		// the numeric threadId on outbound posts.
		const parentMessageIdNum = typeof object?.parentMessageId === "number"
			? object.parentMessageId
			: typeof object?.parentMessageId === "string"
				? parseInt(object.parentMessageId, 10)
				: NaN;
		const parentMessageId = !isNaN(parentMessageIdNum) ? parentMessageIdNum : undefined;

		const threadIdNum = typeof object?.threadId === "number"
			? object.threadId
			: typeof object?.threadId === "string"
				? parseInt(object.threadId, 10)
				: NaN;
		const threadId = !isNaN(threadIdNum) ? threadIdNum : undefined;

		let threadRoot: number | string;
		let activeThreadId: number | undefined;
		if (threadId !== undefined && this.getEnableThreads()) {
			// Message lives in a real Talk thread — scope the session to it
			threadRoot = `thread${threadId}`;
			activeThreadId = threadId;
		} else if (parentMessageId !== undefined) {
			// Explicit reply — use the parent as the thread root
			threadRoot = parentMessageId;
		} else {
			// Top-level message — check for a recent active session in this room
			const sessionWindowMs = (this.config.sessionWindowMinutes ?? 30) * 60 * 1000;
			const recent = this.sessionStore?.findMostRecentActiveForChannel(
				this.id,
				`nextcloud:${roomToken}:`,
				sessionWindowMs,
			);
			if (recent) {
				// Continue the prior conversation by extracting its thread root
				const prefix = `nextcloud:${roomToken}:`;
				const suffix = recent.conversation_id.slice(prefix.length);
				threadRoot = suffix;
			} else {
				// Start a new session with a stable room-level thread root
				// Use "room" instead of msgId to ensure all top-level messages
				// in this room coalesce into a single conversation over time
				threadRoot = "room";
			}
		}
		const conversationId = `nextcloud:${roomToken}:${threadRoot}`;

		// Fix #4: Use crypto.randomUUID() instead of Date.now()
		const inbound: InboundMessage = {
			id: randomUUID(),
			channelId: this.id,
			conversationId,
			senderId: actorId,
			senderName: actorName,
			text: message,
			timestamp: new Date(),
			metadata: {
				nextcloudRoomToken: roomToken,
				nextcloudMessageId: msgId,
				// Only set when the session actually scoped to the thread, so
				// enableThreads: false never routes responses into threads
				nextcloudThreadId: activeThreadId,
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
				// Synchronous handler failure: the StatusReactionController in index.ts
				// may not have had a chance to react. Set ⚠ directly as a last-resort
				// fallback. This is the only place the channel touches reactions
				// outside of setReaction() being called by the controller adapter.
				if (msgId !== undefined) {
					await this.setReaction(roomToken, msgId, "\u26A0", true).catch(() => {
						// Best-effort fallback; nothing to do if it fails.
					});
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

	private async postToNextcloud(roomToken: string, message: string, replyTo?: string, threadId?: number): Promise<boolean> {
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
		if (threadId !== undefined) {
			payload.threadId = threadId;
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
		// Format: "nextcloud:{room_token}" or "nextcloud:{room_token}:{thread_root}"
		// Returns "{room_token}" or "{room_token}:{thread_root}" for caller to split
		const prefix = "nextcloud:";
		if (!conversationId.startsWith(prefix)) {
			return null;
		}
		return conversationId.slice(prefix.length);
	}

	// Phase 3: Owner access control methods
	private isOwner(userId: string): boolean {
		if (!this.config.ownerUserId) return true;
		return userId === this.config.ownerUserId;
	}

	private async rejectNonOwner(userId: string, roomToken: string): Promise<void> {
		// Only send the rejection once per user to avoid spam
		if (this.rejectedUsers.has(userId)) {
			console.log(`[nextcloud] Silently ignoring repeat non-owner message from ${userId}`);
			return;
		}
		this.rejectedUsers.add(userId);

		const rejectionMessage =
			"Hi! I'm Phantom, a personal AI co-worker. I can only respond to my owner. " +
			"If you need your own, check out github.com/ghostwright/phantom.";

		try {
			await this.postToNextcloud(roomToken, rejectionMessage);
			console.log(`[nextcloud] Sent rejection message to non-owner ${userId}`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`[nextcloud] Failed to send rejection to ${userId}: ${msg}`);
			// Best effort - don't fail if we can't post the rejection
		}
	}

	private handleReactionFeedback(payload: NextcloudWebhookPayload, roomToken: string): void {
		const actorId = payload.actor?.id;
		const messageId = payload.object?.id;
		const reaction = payload.object?.reaction;

		if (!actorId || !messageId || !reaction) {
			console.log("[nextcloud] Reaction event missing required fields");
			return;
		}

		// Ignore reactions from bot actors. Talk delivers the bot's own
		// reaction lifecycle back through the webhook (actorId looks like
		// "bots/bot-<hash>"), and without this filter a bot reaction on a
		// feedback-mapped emoji would register as user feedback. Bot actors
		// also have no display name, so Talk renders them as "Deleted user".
		if (actorId.startsWith("bots/") || actorId.startsWith("bot-")) {
			return;
		}

		// Gate reactions by owner (when owner_user_id is configured)
		if (!this.isOwner(actorId)) {
			console.log(`[nextcloud] Ignoring reaction from non-owner ${actorId}`);
			return;
		}

		// Map emojis to feedback types (Slack-compatible rich mapping)
		// Slack uses: +1, thumbsup, heart, white_check_mark (positive) and -1, thumbsdown, x (negative)
		const reactionMap: Record<string, "positive" | "negative"> = {
			// Positive reactions (thumbs up)
			"👍": "positive",
			"👍🏻": "positive",
			"👍🏼": "positive",
			"👍🏽": "positive",
			"👍🏾": "positive",
			"👍🏿": "positive",
			// Positive reactions (heart)
			"❤️": "positive",
			"❤": "positive",
			"🧡": "positive",
			"💛": "positive",
			"💚": "positive",
			"💙": "positive",
			"💜": "positive",
			"🖤": "positive",
			"🤍": "positive",
			"🤎": "positive",
			"💔": "positive",
			"❣️": "positive",
			// Positive reactions (check mark)
			"✅": "positive",
			"☑️": "positive",
			"✔️": "positive",
			// Negative reactions (thumbs down)
			"👎": "negative",
			"👎🏻": "negative",
			"👎🏼": "negative",
			"👎🏽": "negative",
			"👎🏾": "negative",
			"👎🏿": "negative",
			// Negative reactions (cross mark)
			"❌": "negative",
			"🚫": "negative",
			"⛔": "negative",
			"📍": "negative",
			"🚷": "negative",
		};

		const feedbackType = reactionMap[reaction];
		if (!feedbackType) {
			console.log(`[nextcloud] Ignoring non-feedback reaction: ${reaction}`);
			return; // Not a feedback reaction
		}

		emitFeedback({
			type: feedbackType,
			conversationId: `nextcloud:${roomToken}`,
			messageTs: String(messageId),
			userId: actorId,
			source: "reaction",
			timestamp: Date.now(),
		});

		console.log(`[nextcloud] Feedback captured: ${feedbackType} from ${actorId} on message ${messageId}`);
	}

	private async sendProactiveIntroIfFirstRun(): Promise<void> {
		if (!this.config.sendIntro) return;
		if (!this.config.ownerUserId) {
			console.log("[nextcloud] No owner_user_id configured, skipping intro");
			return;
		}
		if (!this.db) return;

		const roomToken = this.config.roomToken;

		try {
			// Check if intro was already sent
			const row = this.db
				.query("SELECT intro_sent_at FROM channel_intros WHERE channel_id = 'nextcloud'")
				.get() as { intro_sent_at?: string } | undefined;

			if (row?.intro_sent_at) {
				console.log("[nextcloud] Intro message already sent on previous startup");
				return;
			}

			// Send intro message to configured room
			const introText =
				"Hi, I'm Phantom. I'm now connected and listening here. Send /help to see what I can do.";
			await this.postToNextcloud(roomToken, introText);

			// Mark as sent
			this.db.run(
				"INSERT OR REPLACE INTO channel_intros (channel_id, intro_sent_at, sent_to_chat_id) VALUES (?, datetime('now'), ?)",
				["nextcloud", roomToken],
			);

			console.log(`[nextcloud] Sent intro message to room ${roomToken}`);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`[nextcloud] Failed to send intro message: ${msg}`);
			// Don't throw - this is a best-effort welcome message
		}
	}

}
