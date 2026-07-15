/**
 * IMAP IDLE supervisor for the Email channel.
 *
 * Owns the ImapFlow client lifecycle: connect, IDLE-listen, refresh the
 * IDLE before the server's idle timeout drops the socket, and rebuild
 * the client with exponential backoff after a socket error.
 */

// Re-issue IDLE well under the typical 30-minute server-side idle timeout
// (RFC 2177 §3 recommends clients refresh before 29 minutes). 20 minutes
// gives margin for slow networks and providers that enforce tighter limits.
const IDLE_REFRESH_MS = 20 * 60 * 1000;

// Backoff for reconnect attempts after an IDLE session ends in error.
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 60_000;

// Minimal ImapFlow surface. `on` is included because ImapFlow extends
// EventEmitter and emits 'error' on socket timeouts; without a listener
// Node/Bun treat the emitted 'error' as an uncaught exception and crash.
export type ImapFlowClient = {
	on: (event: "error", handler: (err: unknown) => void) => void;
	connect: () => Promise<void>;
	logout: () => Promise<void>;
	getMailboxLock: (mailbox: string) => Promise<{ release: () => void }>;
	idle: (options: { abort: AbortSignal }) => Promise<void>;
	fetch: (range: string, options: Record<string, unknown>) => AsyncIterable<ImapMessage>;
	messageFlagsAdd: (uid: string, flags: string[], options: Record<string, unknown>) => Promise<void>;
};

export type ImapMessage = {
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

/** Subset of ImapFlowClient needed by EmailChannel.processUnread. */
export type ImapReadClient = {
	fetch: (range: string, options: Record<string, unknown>) => AsyncIterable<ImapMessage>;
	messageFlagsAdd: (uid: string, flags: string[], options: Record<string, unknown>) => Promise<void>;
};

export type ImapIdleConfig = {
	host: string;
	port: number;
	auth: { user: string; pass: string };
	tls?: boolean;
};

export type ImapIdleHooks = {
	/** True while the owning channel is connected. False exits the loop cleanly. */
	isConnected: () => boolean;
	/**
	 * Called whenever the IDLE session can drain new mail: at session
	 * start, after each IDLE interruption, and after each refresh-abort.
	 * Receives the active client so the hook can fetch without coupling
	 * to the supervisor internals.
	 */
	onMail: (client: ImapFlowClient) => Promise<void>;
};

/**
 * Owns one IMAP IDLE connection and supervises its lifetime.
 *
 * Usage:
 *   const idle = new ImapIdleSupervisor(config, hooks);
 *   await idle.connect();    // builds client, attaches error listener
 *   idle.startLoop();        // begins IDLE supervisor (after owner is connected)
 *   ...
 *   await idle.disconnect(); // aborts IDLE, waits for loop, logs out
 */
export class ImapIdleSupervisor {
	private config: ImapIdleConfig;
	private hooks: ImapIdleHooks;
	private client: ImapFlowClient | null = null;
	private idleAbort: AbortController | null = null;
	private loopPromise: Promise<void> | null = null;
	// Refresh timer that aborts the current IDLE call every IDLE_REFRESH_MS
	// so the server never sees the socket as stale and drops it.
	private idleRefreshTimer: ReturnType<typeof setTimeout> | null = null;
	// Set by the ImapFlow 'error' listener when the underlying socket dies.
	// Distinguishes a refresh-abort (still healthy) from an error-abort
	// (must reconnect before re-issuing IDLE).
	private idleBroken = false;

	constructor(config: ImapIdleConfig, hooks: ImapIdleHooks) {
		this.config = config;
		this.hooks = hooks;
	}

	/**
	 * Build the first ImapFlow client and attach the error listener.
	 * Does NOT start the supervisor loop; call startLoop() once the
	 * owning channel has flipped its state to "connected" so the
	 * loop's isConnected hook returns true on its first check.
	 */
	async connect(): Promise<void> {
		await this.initClient();
	}

	/**
	 * Start the IDLE supervisor loop as a tracked background promise.
	 * Must be called after connect() and after the owner reports
	 * connected, otherwise the loop exits on its first check.
	 */
	startLoop(): void {
		if (this.loopPromise) return;
		this.loopPromise = this.runSupervisorLoop();
	}

	/**
	 * Cleanly tear down: abort any in-flight IDLE, await loop exit, then
	 * log out. Safe to call after connect() even if the loop has died.
	 * Caller flips the owner's connected flag first so the loop exits.
	 */
	async disconnect(): Promise<void> {
		this.cancelRefresh();
		this.idleAbort?.abort();

		if (this.loopPromise) {
			await this.loopPromise;
			this.loopPromise = null;
		}

		try {
			await this.client?.logout();
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`[email] Error during IMAP disconnect: ${msg}`);
		}
	}

	/** Current client, or null if not connected. */
	getClient(): ImapFlowClient | null {
		return this.client;
	}

	/**
	 * Build a fresh ImapFlow client, attach the error listener that
	 * prevents socket-timeout crashes, and connect.
	 */
	private async initClient(): Promise<void> {
		const { ImapFlow } = await import("imapflow");
		const client = new ImapFlow({
			host: this.config.host,
			port: this.config.port,
			auth: this.config.auth,
			secure: this.config.tls ?? true,
			logger: false,
		}) as unknown as ImapFlowClient;

		this.attachErrorHandler(client);
		this.client = client;
		await client.connect();
		console.log("[email] IMAP connected");
	}

	/**
	 * ImapFlow emits 'error' on its EventEmitter for async socket failures
	 * (timeouts, TLS drops, server disconnects). The IDLE try/catch only
	 * sees promise rejections from idle(), not these emissions. Without a
	 * listener Node/Bun treat the emitted 'error' as fatal and crash the
	 * whole Phantom process. The handler marks the connection broken and
	 * aborts any in-flight IDLE so the supervisor triggers a reconnect.
	 */
	private attachErrorHandler(client: ImapFlowClient): void {
		client.on("error", (err: unknown) => {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`[email] IMAP socket error: ${msg}`);
			this.idleBroken = true;
			this.idleAbort?.abort();
		});
	}

	/**
	 * Outer IDLE supervisor. Runs one session; if it ends because the
	 * socket died, rebuilds the client with exponential backoff. Exits
	 * cleanly when the owner reports disconnected.
	 */
	private async runSupervisorLoop(): Promise<void> {
		let reconnectAttempts = 0;

		while (this.hooks.isConnected()) {
			this.idleBroken = false;
			const healthy = await this.runSession();

			if (!this.hooks.isConnected()) return;
			if (healthy) return;

			const delayMs = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttempts, RECONNECT_MAX_DELAY_MS);
			reconnectAttempts++;
			console.warn(`[email] IMAP reconnecting in ${delayMs}ms (attempt ${reconnectAttempts})`);
			await new Promise((resolve) => setTimeout(resolve, delayMs));

			if (!this.hooks.isConnected()) return;

			try {
				await this.reconnectClient();
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
	 * idle() until disconnect, an error, or a refresh-abort. Returns true
	 * on clean exit (owner disconnected), false if caller should reconnect.
	 */
	private async runSession(): Promise<boolean> {
		if (!this.client) return false;

		try {
			const lock = await this.client.getMailboxLock("INBOX");

			try {
				await this.hooks.onMail(this.client);

				while (this.hooks.isConnected() && !this.idleBroken) {
					this.idleAbort = new AbortController();
					this.scheduleRefresh();

					try {
						await this.client.idle({ abort: this.idleAbort.signal });
					} catch (err: unknown) {
						const msg = err instanceof Error ? err.message : String(err);
						if (msg.includes("abort")) {
							// Disconnect-abort or refresh-abort. Error handler
							// sets idleBroken for the socket-death case.
							if (this.idleBroken) return false;
							if (!this.hooks.isConnected()) return true;
							continue; // refresh: re-issue IDLE
						}
						console.warn(`[email] IDLE error: ${msg}`);
						return false;
					} finally {
						this.cancelRefresh();
					}

					await this.hooks.onMail(this.client);
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
	private async reconnectClient(): Promise<void> {
		try {
			await this.client?.logout();
		} catch {
			// Socket is already dead; nothing to cleanly close.
		}
		await this.initClient();
	}

	/**
	 * Schedule an abort of the current IDLE call before the server's
	 * idle timeout drops the socket. The IDLE loop re-issues immediately.
	 */
	private scheduleRefresh(): void {
		this.cancelRefresh();
		this.idleRefreshTimer = setTimeout(() => {
			this.idleAbort?.abort();
		}, IDLE_REFRESH_MS);
	}

	private cancelRefresh(): void {
		if (this.idleRefreshTimer) {
			clearTimeout(this.idleRefreshTimer);
			this.idleRefreshTimer = null;
		}
	}
}
