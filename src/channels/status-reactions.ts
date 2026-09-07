/**
 * Channel-agnostic status reaction controller.
 * Communicates agent processing state through emoji reactions on user messages.
 *
 * Inspired by OpenClaw's pattern but simplified for Phantom's architecture:
 * - Promise chain serialization prevents concurrent API calls
 * - Debouncing at 500ms prevents flickering between rapid state changes
 * - Terminal states (done/error) fire immediately, not debounced
 * - Stall timers warn the user if the agent appears stuck
 */

export type ReactionAdapter = {
	addReaction: (emoji: string) => Promise<void>;
	removeReaction: (emoji: string) => Promise<void>;
};

export type StatusEmojis = {
	queued: string;
	thinking: string;
	tool: string;
	coding: string;
	web: string;
	done: string;
	error: string;
	stallSoft: string;
	stallHard: string;
};

export type StatusTiming = {
	debounceMs: number;
	stallSoftMs: number;
	stallHardMs: number;
};

export const DEFAULT_EMOJIS: StatusEmojis = {
	queued: "eyes",
	thinking: "brain",
	tool: "wrench",
	coding: "computer",
	web: "globe_with_meridians",
	done: "white_check_mark",
	error: "warning",
	stallSoft: "hourglass_flowing_sand",
	stallHard: "exclamation",
};

export const DEFAULT_TIMING: StatusTiming = {
	debounceMs: 500,
	stallSoftMs: 10_000,
	stallHardMs: 30_000,
};

const CODING_TOKENS = ["read", "write", "edit", "bash", "glob", "grep"];
const WEB_TOKENS = ["web_search", "websearch", "web_fetch", "webfetch", "browser"];

export function resolveToolEmoji(toolName: string | undefined, emojis: StatusEmojis): string {
	const name = toolName?.toLowerCase() ?? "";
	if (!name) return emojis.tool;
	if (WEB_TOKENS.some((t) => name.includes(t))) return emojis.web;
	if (CODING_TOKENS.some((t) => name.includes(t))) return emojis.coding;
	return emojis.tool;
}

export type StatusReactionController = {
	setQueued: () => void;
	setThinking: () => void;
	setTool: (toolName?: string) => void;
	setDone: () => Promise<void>;
	setError: () => Promise<void>;
	/**
	 * Terminal state that removes the current reaction instead of applying a
	 * final emoji. Channels whose servers log every reaction change as a
	 * chat system message (Nextcloud Talk) use this on success so a finished
	 * turn leaves no emoji behind and no extra delete/add churn.
	 */
	clear: () => Promise<void>;
	dispose: () => void;
};

export function createStatusReactionController(params: {
	adapter: ReactionAdapter;
	emojis?: Partial<StatusEmojis>;
	timing?: Partial<StatusTiming>;
	onError?: (err: unknown) => void;
}): StatusReactionController {
	const emojis: StatusEmojis = { ...DEFAULT_EMOJIS, ...params.emojis };
	const timing: StatusTiming = { ...DEFAULT_TIMING, ...params.timing };
	const { adapter, onError } = params;

	let currentEmoji = "";
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;
	let stallSoftTimer: ReturnType<typeof setTimeout> | null = null;
	let stallHardTimer: ReturnType<typeof setTimeout> | null = null;
	let finished = false;
	let chain = Promise.resolve();

	function enqueue(fn: () => Promise<void>): Promise<void> {
		chain = chain.then(fn, fn);
		return chain;
	}

	function clearTimers(): void {
		if (debounceTimer) clearTimeout(debounceTimer);
		if (stallSoftTimer) clearTimeout(stallSoftTimer);
		if (stallHardTimer) clearTimeout(stallHardTimer);
		debounceTimer = null;
		stallSoftTimer = null;
		stallHardTimer = null;
	}

	function resetStallTimers(): void {
		if (stallSoftTimer) clearTimeout(stallSoftTimer);
		if (stallHardTimer) clearTimeout(stallHardTimer);

		// Stall callbacks apply the emoji directly instead of going through
		// applyDebounced, which calls resetStallTimers() at the end. Routing
		// stall applications through it re-arms the timers from the stall
		// itself: because stallSoft != stallHard, the two timers re-arm each
		// other and a turn that never finishes oscillates the two emojis
		// forever, each flip a remove+add that Talk renders as system
		// messages. With direct application the ladder runs once per
		// activity gap: stallSoft, then stallHard, then silence until real
		// activity re-arms it via applyDebounced.
		stallSoftTimer = setTimeout(() => {
			stallSoftTimer = null;
			if (!finished && currentEmoji !== emojis.stallSoft) {
				void enqueue(() => applyEmoji(emojis.stallSoft));
			}
		}, timing.stallSoftMs);

		stallHardTimer = setTimeout(() => {
			stallHardTimer = null;
			if (!finished && currentEmoji !== emojis.stallHard) {
				void enqueue(() => applyEmoji(emojis.stallHard));
			}
		}, timing.stallHardMs);
	}

	async function applyEmoji(emoji: string): Promise<void> {
		try {
			const prev = currentEmoji;
			if (prev && prev !== emoji) {
				await adapter.removeReaction(prev);
			}
			await adapter.addReaction(emoji);
			currentEmoji = emoji;
		} catch (err) {
			onError?.(err);
		}
	}

	function applyDebounced(emoji: string, immediate = false): void {
		if (finished || emoji === currentEmoji) return;

		if (debounceTimer) clearTimeout(debounceTimer);

		if (immediate) {
			void enqueue(() => applyEmoji(emoji));
		} else {
			debounceTimer = setTimeout(() => {
				void enqueue(() => applyEmoji(emoji));
			}, timing.debounceMs);
		}
		resetStallTimers();
	}

	function finishWith(emoji: string): Promise<void> {
		if (finished) return Promise.resolve();
		finished = true;
		clearTimers();
		return enqueue(() => applyEmoji(emoji));
	}

	function clearReaction(): Promise<void> {
		if (finished) return Promise.resolve();
		finished = true;
		clearTimers();
		const prev = currentEmoji;
		currentEmoji = "";
		if (!prev) return Promise.resolve();
		return enqueue(async () => {
			try {
				await adapter.removeReaction(prev);
			} catch (err) {
				onError?.(err);
			}
		});
	}

	return {
		setQueued: () => applyDebounced(emojis.queued, true),
		setThinking: () => applyDebounced(emojis.thinking),
		setTool: (toolName?: string) => {
			const emoji = resolveToolEmoji(toolName, emojis);
			applyDebounced(emoji);
		},
		setDone: () => finishWith(emojis.done),
		setError: () => finishWith(emojis.error),
		clear: () => clearReaction(),
		dispose: () => {
			finished = true;
			clearTimers();
		},
	};
}
