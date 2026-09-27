/**
 * Progressive message update loop for streaming agent activity.
 * Posts an initial "Working on it..." message and progressively updates
 * it with tool activity lines as the agent works.
 *
 * Throttled at 1000ms to respect Slack's rate limits (~1 update/sec).
 */

export type ProgressStreamAdapter = {
	postMessage: (text: string) => Promise<string>;
	updateMessage: (messageId: string, text: string) => Promise<void>;
};

export type ProgressLine = {
	tool: string;
	summary: string;
	timestamp: number;
};

export type ProgressStream = {
	start: () => Promise<void>;
	addToolActivity: (tool: string, summary: string) => void;
	finish: (finalText: string) => Promise<void>;
	finishWithBlocks: (finalText: string, blocks: unknown[]) => Promise<void>;
	getMessageId: () => string | null;
};

const THROTTLE_MS = 1000;
const MAX_LINES = 15;

export function createProgressStream(params: {
	adapter: ProgressStreamAdapter;
	onError?: (err: unknown) => void;
	/** Custom finish handler that receives messageId, text, blocks */
	onFinish?: (messageId: string, text: string, blocks?: unknown[]) => Promise<void>;
	/** Header line shown while working (default "Working on it...") */
	header?: string;
	/** Minimum interval between update flushes (default 1000ms) */
	throttleMs?: number;
}): ProgressStream {
	const { adapter, onError, onFinish } = params;
	const header = params.header ?? "Working on it...";
	const throttleMs = params.throttleMs ?? THROTTLE_MS;

	let messageId: string | null = null;
	const lines: ProgressLine[] = [];
	let dirty = false;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let stopped = false;

	function formatProgress(): string {
		if (lines.length === 0) return header;

		const visible = lines.slice(-MAX_LINES);
		const activity = visible.map((l) => `> ${l.summary}`).join("\n");
		return `${header}\n${activity}`;
	}

	async function flush(): Promise<void> {
		if (!messageId || !dirty || stopped) return;
		dirty = false;
		try {
			await adapter.updateMessage(messageId, formatProgress());
		} catch (err) {
			onError?.(err);
		}
	}

	function scheduleFlush(): void {
		if (timer || stopped) return;
		timer = setTimeout(() => {
			timer = null;
			void flush();
		}, throttleMs);
	}

	return {
		async start(): Promise<void> {
			try {
				messageId = await adapter.postMessage(header);
			} catch (err) {
				onError?.(err);
			}
		},

		addToolActivity(tool: string, summary: string): void {
			if (stopped) return;
			lines.push({ tool, summary, timestamp: Date.now() });
			dirty = true;
			scheduleFlush();
		},

		async finish(finalText: string): Promise<void> {
			stopped = true;
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
			if (!messageId) return;

			try {
				if (onFinish) {
					await onFinish(messageId, finalText);
				} else {
					await adapter.updateMessage(messageId, finalText);
				}
			} catch (err) {
				onError?.(err);
			}
		},

		async finishWithBlocks(finalText: string, blocks: unknown[]): Promise<void> {
			stopped = true;
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
			if (!messageId) return;

			try {
				if (onFinish) {
					await onFinish(messageId, finalText, blocks);
				} else {
					await adapter.updateMessage(messageId, finalText);
				}
			} catch (err) {
				onError?.(err);
			}
		},

		getMessageId(): string | null {
			return messageId;
		},
	};
}

/**
 * Format a tool name into a human-readable activity line.
 * The agent provides intelligence; this just renders a readable summary.
 */
export function formatToolActivity(toolName: string, input?: Record<string, unknown>): string {
	const name = toolName.toLowerCase();

	if (name.includes("read")) {
		const path = input?.file_path ?? input?.path;
		return path ? `Reading ${path}` : "Reading file...";
	}
	if (name.includes("write")) {
		const path = input?.file_path ?? input?.path;
		return path ? `Writing ${path}` : "Writing file...";
	}
	if (name.includes("edit")) {
		const path = input?.file_path ?? input?.path;
		return path ? `Editing ${path}` : "Editing file...";
	}
	if (name.includes("bash")) {
		const cmd = input?.command as string | undefined;
		const short = cmd ? cmd.slice(0, 60) : "";
		return short ? `Running: ${short}${cmd && cmd.length > 60 ? "..." : ""}` : "Running command...";
	}
	if (name.includes("grep")) return "Searching code...";
	if (name.includes("glob")) return "Finding files...";
	if (name.includes("web_search") || name.includes("websearch")) return "Searching the web...";
	if (name.includes("web_fetch") || name.includes("webfetch")) return "Fetching web page...";
	if (name.includes("agent")) return "Delegating to sub-agent...";

	return `Using ${toolName}...`;
}
