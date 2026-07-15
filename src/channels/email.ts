/**
 * Email channel using ImapFlow (IMAP IDLE) and Nodemailer (SMTP).
 * Supports email threading via In-Reply-To/References headers,
 * HTML formatting, and attachment handling.
 *
 * The IMAP IDLE connection lifecycle (connect, IDLE-listen, refresh,
 * reconnect) lives in email-idle-loop.ts. Formatting and classification
 * helpers live in email-helpers.ts. This file holds only the Channel
 * contract: send, receive, connect, disconnect.
 */

import { randomUUID } from "node:crypto";
import { extractBodyText, isAutoReply, textToHtml } from "./email-helpers.ts";
import { ImapIdleSupervisor, type ImapReadClient } from "./email-idle-loop.ts";
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

// Track threads for In-Reply-To/References headers
type EmailThread = {
	messageId: string;
	references: string[];
	subject: string;
	from: string;
};

type NodemailerTransport = {
	sendMail: (options: Record<string, unknown>) => Promise<unknown>;
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
	private idle: ImapIdleSupervisor | null = null;
	private transporter: NodemailerTransport | null = null;
	private threads = new Map<string, EmailThread>();

	constructor(config: EmailChannelConfig) {
		this.config = config;
	}

	async connect(): Promise<void> {
		if (this.connectionState === "connected") return;
		this.connectionState = "connecting";

		try {
			this.idle = new ImapIdleSupervisor(
				{
					host: this.config.imap.host,
					port: this.config.imap.port,
					auth: this.config.imap.auth,
					tls: this.config.imap.tls,
				},
				{
					isConnected: () => this.connectionState === "connected",
					onMail: (client) => this.processUnread(client),
				},
			);
			await this.idle.connect();

			const nodemailer = await import("nodemailer");
			this.transporter = nodemailer.createTransport({
				host: this.config.smtp.host,
				port: this.config.smtp.port,
				auth: this.config.smtp.auth,
				secure: this.config.smtp.tls ?? false,
			}) as unknown as NodemailerTransport;

			// Flip state BEFORE starting the loop so the supervisor's
			// isConnected hook returns true on its first check.
			this.connectionState = "connected";
			console.log("[email] SMTP configured");
			this.idle.startLoop();
		} catch (err: unknown) {
			this.connectionState = "error";
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`[email] Failed to connect: ${msg}`);
			throw err;
		}
	}

	async disconnect(): Promise<void> {
		if (this.connectionState === "disconnected") return;

		// Flip state first so the supervisor's isConnected hook returns
		// false and its loop exits cleanly without attempting reconnect.
		this.connectionState = "disconnected";

		if (this.idle) {
			await this.idle.disconnect();
			this.idle = null;
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
	 * Drain unread messages from INBOX. Called by the IDLE supervisor
	 * at session start, after each IDLE interruption, and after each
	 * scheduled refresh. The current client is passed in by the
	 * supervisor so we never touch a stale client after reconnect.
	 */
	private async processUnread(client: ImapReadClient): Promise<void> {
		if (!this.messageHandler) return;

		try {
			const messages = client.fetch("1:*", {
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

				const bodyText = extractBodyText(msg.source?.toString() ?? "");
				if (!bodyText.trim()) continue;

				if (isAutoReply(subject, bodyText)) continue;

				const conversationId = `email:${fromAddress}:${subject.replace(/^Re:\s*/i, "")}`;

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

				try {
					await client.messageFlagsAdd(String(msg.uid), ["\\Seen"], { uid: true });
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
