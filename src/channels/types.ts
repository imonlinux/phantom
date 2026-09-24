export type Attachment = {
	filename: string;
	path: string;
	size?: number;
	mimeType?: string;
};

/**
 * A file queued during a turn via the phantom_send_file tool, awaiting
 * delivery with the response. Validated at queue time; transports read
 * the bytes at delivery time.
 */
export type PendingAttachment = {
	path: string;
	filename: string;
	size: number;
	mimeType: string;
	caption?: string;
};

export type InboundMessage = {
	id: string;
	channelId: string;
	conversationId: string;
	threadId?: string;
	senderId: string;
	senderName?: string;
	text: string;
	timestamp: Date;
	attachments?: Attachment[];
	metadata?: Record<string, unknown>;
};

export type OutboundMessage = {
	text: string;
	threadId?: string;
	replyToId?: string;
	// Files queued via phantom_send_file; transports read the bytes at
	// send time, so the pending shape (size + mimeType required) is used.
	attachments?: PendingAttachment[];
};

export type SentMessage = {
	id: string;
	channelId: string;
	conversationId: string;
	timestamp: Date;
};

export type ChannelCapabilities = {
	threads: boolean;
	richText: boolean;
	attachments: boolean;
	buttons: boolean;
	reactions?: boolean;
	progressUpdates?: boolean;
	inlineKeyboards?: boolean;
	typing?: boolean;
	messageEditing?: boolean;
};

export interface Channel {
	readonly id: string;
	readonly name: string;
	readonly capabilities: ChannelCapabilities;

	connect(): Promise<void>;
	disconnect(): Promise<void>;
	send(conversationId: string, message: OutboundMessage): Promise<SentMessage>;
	onMessage(handler: (message: InboundMessage) => Promise<void>): void;
}
