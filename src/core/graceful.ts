type ShutdownTask = {
	name: string;
	fn: () => Promise<void>;
};

const tasks: ShutdownTask[] = [];
let shuttingDown = false;

export function onShutdown(name: string, fn: () => Promise<void>): void {
	tasks.push({ name, fn });
}

export function installShutdownHandlers(): void {
	const handler = () => {
		if (shuttingDown) return;
		shuttingDown = true;
		runShutdown();
	};

	process.on("SIGINT", handler);
	process.on("SIGTERM", handler);
}

// Why: Bun terminates the whole process on any unhandled rejection. Aborting
// an in-flight Agent SDK query legitimately produces rejections inside the
// SDK's own control-request writes: the child transport dies mid-round-trip
// and a pending control response write rejects. Those must not take the
// server down before the interrupted turn can deliver its ack, so rejections
// are logged loudly and the process keeps running.
export function installUnhandledRejectionGuard(): void {
	process.on("unhandledRejection", (reason: unknown) => {
		const msg = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
		console.error(`[phantom] Unhandled rejection (process kept alive): ${msg}`);
		if (reason instanceof Error && reason.stack) {
			console.error(reason.stack);
		}
	});
}

async function runShutdown(): Promise<void> {
	console.log("\n[phantom] Shutting down...");

	for (const task of tasks.reverse()) {
		try {
			await task.fn();
			console.log(`[phantom] Stopped: ${task.name}`);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`[phantom] Error stopping ${task.name}: ${msg}`);
		}
	}

	console.log("[phantom] Goodbye.");
	process.exit(0);
}
