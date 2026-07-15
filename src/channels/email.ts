/**
 * Email channel using ImapFlow (IMAP IDLE) and Nodemailer (SMTP).
 * Supports email threading via In-Reply-To/References headers,
 * HTML formatting, and attachment handling.
 */

import { randomUUID } from "node:crypto";
import type { Channel, ChannelCapabilities, InboundMessage, OutboundMessage, SentMessage } from "./types.ts";

export type EmailChannelConfig = {
	imap: {
		host: string;
		port: number;
		auth: { user: string; pass: string };
		tls?: boolean;
	};
	smtp: {
		host: string;
		port: number;
		auth: { user: string; pass: string };
		tls?: boolean;
	};
	fromAddress: string;
	fromName: string;
};

type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

// Re-issue IDLE well under the typical 30-minute server-side idle timeout
// (RFC 2177 §3 recommends clients refresh before 29 minutes). 20 minutes
// gives margin for slow networks and providers that enforce tighter limits.
const IDLE_REFRESH_MS = 20 * 60 * 1000;

// Backoff for reconnect attempts after an IDLE session ends in error.
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 60_000;

// Track threads for In-Reply-To/References headers
type EmailThread = {
	messageId: string;
	references: string[];
	subject: string;
	from: string;
};

export class EmailChannel implements Channel {
	readonly id = "email";
	readonly name = "Email";
	readonly capabilities: ChannelCapabilities = {
		threads: true,
		richText: true,
		attachments: true,
		buttons: false,
	};

	private config: EmailChannelConfig;
	private messageHandler: ((message: InboundMessage) => Promise<void>) | null = null;
	private connectionState: ConnectionState = "disconnected";
	private imapClient: ImapFlowClient | null = null;
	private transporter: NodemailerTransport | null = null;
	private threads = new Map<string, EmailThread>();
	private idleAbort: AbortController | null = null;
	private idleLoopPromise: Promise<void> | null = null;
	// Refresh timer that aborts the current IDLE call every IDLE_REFRESH_MS
	// so the server never sees the socket as stale and drops it.
	private idleRefreshTimer: ReturnType<typeof setTimeout> | null = null;
	// Set by the ImapFlow 'error' listener when the underlying socket dies.
	// Distinguishes a refresh-abort (still healthy) from an error-abort
	// (must reconnect before re-issuing IDLE).
	private idleBroken = false;

	constructor(config: EmailChannelConfig) {
		this.config = config;
	}

	async connect(): Promise<void> {
		if (this.connectionState === "connected") return;
		this.connectionState = "connecting";

		try {
			await this.initImapClient();

			// Initialize SMTP
			const nodemailer = await import("nodemailer");
			this.transporter = nodemailer.createTransport({
				host: this.config.smtp.host,
				port: this.config.smtp.port,
				auth: this.config.smtp.auth,
				secure: this.config.smtp.tls ?? false,
			}) as unknown as NodemailerTransport;

			this.connectionState = "connected";
			console.log("[email] SMTP configured");

			// Start IDLE listening (tracked so disconnect can await it).
			// The loop self-heals on socket errors via reconnectImapClient.
			this.idleLoopPromise = this.startIdleLoop();
		} catch (err: unknown) {
			this.connectionState = "error";
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`[email] Failed to connect: ${msg}`);
			throw err;
		}
	}

	/**
	 * Build a fresh ImapFlow client, attach the error listener that
	 * prevents socket-timeout crashes, and connect. Reused by both
	 * connect() and the reconnect path inside startIdleLoop.
	 */
	private async initImapClient(): Promise<void> {
		const { ImapFlow } = await import("imapflow");
		const client = new ImapFlow({
			host: this.config.imap.host,
			port: this.config.imap.port,
			auth: this.config.imap.auth,
			secure: this.config.imap.tls ?? true,
			logger: false,
		}) as unknown as ImapFlowClient;

		this.attachImapErrorHandler(client);
		this.imapClient = client;
		await client.connect();
		console.log("[email] IMAP connected");
	}

	/**
	 * ImapFlow emits 'error' on the client EventEmitter for async socket
	 * failures (timeouts, TLS drops, server-initiated disconnects). The
	 * IDLE loop's try/catch only sees promise rejections from idle(),
	 * which does NOT cover this emission path. Without a listener Node/Bun
	 * treat the emitted 'error' as fatal and the whole Phantom process
	 * dies, taking every in-flight agent session with it.
	 *
	 * The handler marks the connection broken and aborts any in-flight
	 * IDLE so the loop notices, returns false from its session, and the
	 * outer loop in startIdleLoop triggers a reconnect.
	 */
	private attachImapErrorHandler(client: ImapFlowClient): void {
		client.on("error", (err: unknown) => {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`[email] IMAP socket error: ${msg}`);
			this.idleBroken = true;
			this.idleAbort?.abort();
		});
	}

	async disconnect(): Promise<void> {
		if (this.connectionState === "disconnected") return;

		this.connectionState = "disconnected";
		this.cancelIdleRefresh();
		this.idleAbort?.abort();

		// Wait for the IDLE loop to finish and release the mailbox lock
		// before logging out, so a subsequent connect() won't race.
		if (this.idleLoopPromise) {
			await this.idleLoopPromise;
			this.idleLoopPromise = null;
		}

		try {
			await this.imapClient?.logout();
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`[email] Error during IMAP disconnect: ${msg}`);
		}

		console.log("[email] Disconnected");
	}

	async send(conversationId: string, message: OutboundMessage): Promise<SentMessage> {
		if (!this.transporter) throw new Error("Email transport not initialized");

		const thread = this.threads.get(conversationId);
		const messageId = `<phantom-${randomUUID()}@${this.config.fromAddress.split("@")[1] ?? "phantom.local"}>`;

		const htmlBody = textToHtml(message.text);
		const subject = thread ? `Re: ${thread.subject}` : "Response from Phantom";

		const mailOptions: Record<string, unknown> = {
			from: `"${this.config.fromName}" <${this.config.fromAddress}>`,
			to: thread?.from ?? conversationId.replace("email:", ""),
			subject,
			html: htmlBody,
			text: message.text,
			messageId,
		};

		// Threading headers
		if (thread) {
			mailOptions.inReplyTo = thread.messageId;
			mailOptions.references = [...thread.references, thread.messageId].join(" ");
		}

		await this.transporter.sendMail(mailOptions);

		return {
			id: messageId,
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

	/**
	 * Outer IDLE supervisor. Runs one IDLE session; if the session ends
	 * because the socket died (idleBroken or non-abort error), rebuilds
	 * the ImapFlow client with exponential backoff and tries again.
	 * Exits cleanly when disconnect() flips connectionState.
	 */
	private async startIdleLoop(): Promise<void> {
		let reconnectAttempts = 0;

		while (this.connectionState === "connected") {
			this.idleBroken = false;
			const healthy = await this.runIdleSession();

			if (this.connectionState !== "connected") return;
			if (healthy) return;

			// Session ended badly: back off and rebuild the client.
			const delayMs = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttempts, RECONNECT_MAX_DELAY_MS);
			reconnectAttempts++;
			console.warn(`[email] IMAP reconnecting in ${delayMs}ms (attempt ${reconnectAttempts})`);
			await new Promise((resolve) => setTimeout(resolve, delayMs));

			if (this.connectionState !== "connected") return;

			try {
				await this.reconnectImapClient();
				reconnectAttempts = 0;
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				console.error(`[email] IMAP reconnect failed: ${msg}; will retry`);
				// Loop continues; backoff keeps growing up to the cap.
			}
		}
	}

	/**
	 * One IDLE session: acquire INBOX lock, drain unread, then loop on
	 * idle() until disconnect, an error, or a refresh-abort.
	 *
	 * Returns true on clean exit (disconnect), false when the session
	 * ended badly and the caller should reconnect.
	 */
	private async runIdleSession(): Promise<boolean> {
		if (!this.imapClient) return false;

		try {
			const lock = await this.imapClient.getMailboxLock("INBOX");

			try {
				await this.processUnread();

				while (this.connectionState === "connected" && !this.idleBroken) {
					this.idleAbort = new AbortController();
					this.scheduleIdleRefresh();

					try {
						await this.imapClient.idle({ abort: this.idleAbort.signal });
					} catch (err: unknown) {
						const msg = err instanceof Error ? err.message : String(err);
						if (msg.includes("abort")) {
							// Disconnect-abort or refresh-abort. Error handler
							// sets idleBroken for the socket-death case.
							if (this.idleBroken) return false;
							if (this.connectionState !== "connected") return true;
							continue; // refresh: re-issue IDLE
						}
						console.warn(`[email] IDLE error: ${msg}`);
						return false;
					} finally {
						this.cancelIdleRefresh();
					}

					// IDLE was interrupted by new mail.
					await this.processUnread();
				}

				return !this.idleBroken;
			} finally {
				lock.release();
			}
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`[email] IDLE session error: ${msg}`);
			return false;
		}
	}

	/**
	 * Tear down the old (likely broken) ImapFlow client and build a fresh
	 * one. Errors from the old logout are expected and ignored.
	 */
	private async reconnectImapClient(): Promise<void> {
		try {
			await this.imapClient?.logout();
		} catch {
			// Socket is already dead; nothing to cleanly close.
		}
		await this.initImapClient();
	}

	/**
	 * Schedule an abort of the current IDLE call before the server's
	 * idle timeout drops the socket. The IDLE loop re-issues immediately.
	 */
	private scheduleIdleRefresh(): void {
		this.cancelIdleRefresh();
		this.idleRefreshTimer = setTimeout(() => {
			this.idleAbort?.abort();
		}, IDLE_REFRESH_MS);
	}

	private cancelIdleRefresh(): void {
		if (this.idleRefreshTimer) {
			clearTimeout(this.idleRefreshTimer);
			this.idleRefreshTimer = null;
		}
	}

	private async processUnread(): Promise<void> {
		if (!this.imapClient || !this.messageHandler) return;

		try {
			const messages = this.imapClient.fetch("1:*", {
				uid: true,
				flags: true,
				envelope: true,
				source: true,
			});

			for await (const msg of messages) {
				if (!msg.flags || msg.flags.has("\\Seen")) continue;

				const envelope = msg.envelope;
				if (!envelope) continue;

				const from = envelope.from?.[0];
				const fromAddress = from?.address ?? "unknown";
				const subject = envelope.subject ?? "(no subject)";
				const messageIdHeader = envelope.messageId ?? "";

				// Extract body text from source
				const bodyText = extractBodyText(msg.source?.toString() ?? "");
				if (!bodyText.trim()) continue;

				// Skip auto-replies
				if (isAutoReply(subject, bodyText)) continue;

				const conversationId = `email:${fromAddress}:${subject.replace(/^Re:\s*/i, "")}`;

				// Track the thread
				const references = envelope.inReplyTo ? [envelope.inReplyTo] : [];
				this.threads.set(conversationId, {
					messageId: messageIdHeader,
					references,
					subject: subject.replace(/^Re:\s*/i, ""),
					from: fromAddress,
				});

				const inbound: InboundMessage = {
					id: String(msg.uid),
					channelId: this.id,
					conversationId,
					senderId: fromAddress,
					senderName: from?.name,
					text: bodyText.trim(),
					timestamp: envelope.date ?? new Date(),
					metadata: {
						emailSubject: subject,
						emailFrom: fromAddress,
						emailMessageId: messageIdHeader,
					},
				};

				// Mark as seen
				try {
					await this.imapClient?.messageFlagsAdd(String(msg.uid), ["\\Seen"], { uid: true });
				} catch {
					// Non-critical
				}

				try {
					await this.messageHandler(inbound);
				} catch (err: unknown) {
					const errMsg = err instanceof Error ? err.message : String(err);
					console.error(`[email] Error handling email from ${fromAddress}: ${errMsg}`);
				}
			}
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`[email] Error processing unread: ${msg}`);
		}
	}
}

function textToHtml(text: string): string {
	const html = text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\n/g, "<br>")
		.replace(
			/```([\s\S]*?)```/g,
			'<pre style="background:#f4f4f4;padding:12px;border-radius:4px;font-family:monospace;font-size:13px">$1</pre>',
		)
		.replace(
			/`([^`]+)`/g,
			'<code style="background:#f0f0f0;padding:2px 4px;border-radius:3px;font-size:13px">$1</code>',
		);

	return `
<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;font-size:14px;line-height:1.6;color:#333">
${html}
<br><br>
<div style="color:#999;font-size:12px;border-top:1px solid #eee;padding-top:8px;margin-top:16px">
${"\u2014"} Phantom, your AI co-worker
</div>
</div>`.trim();
}

function extractBodyText(source: string): string {
	// Simple extraction: get text after headers (double newline)
	const headerEnd = source.indexOf("\r\n\r\n");
	if (headerEnd === -1) return source;
	const body = source.slice(headerEnd + 4);

	// Strip HTML tags if present
	return body
		.replace(/<[^>]*>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.trim();
}

function isAutoReply(subject: string, body: string): boolean {
	const autoReplyIndicators = [
		"out of office",
		"automatic reply",
		"auto-reply",
		"autoreply",
		"vacation reply",
		"delivery status notification",
		"undeliverable",
		"mailer-daemon",
	];
	const combined = `${subject} ${body}`.toLowerCase();
	return autoReplyIndicators.some((indicator) => combined.includes(indicator));
}

// Minimal type interfaces for ImapFlow and Nodemailer.
// `on` is included because ImapFlow extends EventEmitter and emits
// 'error' on socket timeouts; without a listener Node/Bun treat the
// emitted 'error' as an uncaught exception and crash the process.
type ImapFlowClient = {
	on: (event: "error", handler: (err: unknown) => void) => void;
	connect: () => Promise<void>;
	logout: () => Promise<void>;
	getMailboxLock: (mailbox: string) => Promise<{ release: () => void }>;
	idle: (options: { abort: AbortSignal }) => Promise<void>;
	fetch: (range: string, options: Record<string, unknown>) => AsyncIterable<ImapMessage>;
	messageFlagsAdd: (uid: string, flags: string[], options: Record<string, unknown>) => Promise<void>;
};

type ImapMessage = {
	uid: number;
	flags: Set<string>;
	envelope: {
		from?: Array<{ address?: string; name?: string }>;
		subject?: string;
		messageId?: string;
		date?: Date;
		inReplyTo?: string;
	};
	source?: Buffer;
};

type NodemailerTransport = {
	sendMail: (options: Record<string, unknown>) => Promise<unknown>;
};
