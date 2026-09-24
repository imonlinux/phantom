import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Buffer } from "node:buffer";
import { MAX_TALK_FILE_BYTES, TalkFileFetcher, extractTalkFileParams, rawNcUserId } from "../nextcloud-files.ts";
import { NextcloudChannel, type NextcloudChannelConfig } from "../nextcloud.ts";
import type { InboundMessage } from "../types.ts";

// File shares must not touch the real filesystem in tests: stub node:fs and
// Bun.write so the handler's save step is captured, not executed.
mock.module("node:fs", () => ({
	default: {
		existsSync: mock(() => true),
		mkdirSync: mock(() => undefined),
	},
	existsSync: mock(() => true),
	mkdirSync: mock(() => undefined),
}));

const ROOM = "testroomtoken";
const PHANTOM_ID = "phantom";

const SHARED_SECRET = "test-secret-at-least-16-chars-for-hmac";

function baseConfig(): NextcloudChannelConfig {
	return {
		sharedSecret: SHARED_SECRET,
		talkServer: "nextcloud.example.com",
		roomToken: ROOM,
		ownerUserId: "users/james",
		phantomId: PHANTOM_ID,
		phantomAppPass: "app-password-value",
	};
}

function fileSharePayload(args: {
	type: string;
	actorId?: string;
	actorName?: string;
	message?: string;
	fileName?: string;
	fileSize?: string;
	messageId?: number | string;
}) {
	return {
		type: args.type,
		actor: { type: "Person", id: args.actorId ?? "users/james", name: args.actorName ?? "James McMurphy" },
		object: {
			type: "Note",
			id: args.messageId ?? 4242,
			name: args.type === "Activity" ? "{file_shared}" : "message",
			content: JSON.stringify({
				message: args.message ?? "{file}",
				parameters: {
					actor: { id: "james", type: "user" },
					file: {
						type: "file",
						id: "99",
						name: args.fileName ?? "review.md",
						size: args.fileSize ?? "11",
						path: args.fileName ?? "review.md",
						mimetype: "text/markdown",
						link: "https://nextcloud.example.com/s/abc123",
					},
				},
			}),
		},
		target: { id: ROOM, name: "Phantom WorkAgent" },
	};
}

function davPropfindResponse(names: string[]): Response {
	const hrefs = names
		.map(
			(n) =>
				`<d:response><d:href>/remote.php/dav/files/${PHANTOM_ID}/Talk/${encodeURIComponent(n)}</d:href></d:response>`,
		)
		.join("");
	return new Response(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${hrefs}</d:multistatus>`, { status: 207 });
}

describe("extractTalkFileParams", () => {
	test("parses a valid file parameter", () => {
		const params = extractTalkFileParams({
			file: { type: "file", name: "a.md", size: "123", mimetype: "text/markdown", link: "https://x.example/s/1" },
		});
		expect(params).toEqual({
			name: "a.md",
			size: 123,
			mimetype: "text/markdown",
			link: "https://x.example/s/1",
		});
	});

	test("returns null when parameters.file is missing or malformed", () => {
		expect(extractTalkFileParams(null)).toBeNull();
		expect(extractTalkFileParams(undefined)).toBeNull();
		expect(extractTalkFileParams({ share: "x" })).toBeNull();
		expect(extractTalkFileParams({ file: "string-not-object" })).toBeNull();
		expect(extractTalkFileParams({ file: { size: "1" } })).toBeNull();
	});

	test("drops non-http links and non-numeric sizes", () => {
		const params = extractTalkFileParams({ file: { name: "a.md", size: "abc", link: "/relative" } });
		expect(params?.size).toBeUndefined();
		expect(params?.link).toBeUndefined();
	});
});

describe("rawNcUserId", () => {
	test("strips the attendee-type prefix", () => {
		expect(rawNcUserId("users/james")).toBe("james");
	});

	test("passes bare ids through", () => {
		expect(rawNcUserId("james")).toBe("james");
	});
});

describe("TalkFileFetcher", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	function stubDav(options?: { propfindStatus?: number; getStatus?: number; body?: string }) {
		const calls: Array<{ method: string; url: string }> = [];
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const method = init?.method ?? "GET";
			calls.push({ method, url });
			if (method === "PROPFIND") {
				const status = options?.propfindStatus ?? 207;
				if (status !== 207) return new Response("nope", { status });
				if (url.endsWith("/Talk")) {
					return davPropfindResponse([`Phantom WorkAgent-${ROOM}`, "Other-room-xyz"]);
				}
				return davPropfindResponse(["James McMurphy-james", "Draft"]);
			}
			if (method === "GET") {
				const status = options?.getStatus ?? 200;
				return new Response(options?.body ?? "file-bytes", { status });
			}
			return new Response("unexpected", { status: 500 });
		}) as typeof fetch;
		return calls;
	}

	function newFetcher(): TalkFileFetcher {
		return new TalkFileFetcher({ talkServer: "nextcloud.example.com", userId: PHANTOM_ID, appPassword: "pw" });
	}

	const file = { name: "review.md", size: 11, mimetype: "text/markdown" };

	test("resolves conversation and sharer folders, then downloads", async () => {
		const calls = stubDav();
		const result = await newFetcher().fetchSharedFile(ROOM, "users/james", file);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.buffer.toString()).toBe("file-bytes");
		const propfinds = calls.filter((c) => c.method === "PROPFIND");
		expect(propfinds.length).toBe(2);
		expect(propfinds[0].url).toContain("/remote.php/dav/files/phantom/Talk");
		const gets = calls.filter((c) => c.method === "GET");
		expect(gets.length).toBe(1);
		expect(decodeURIComponent(gets[0].url)).toContain(`Talk/Phantom WorkAgent-${ROOM}/James McMurphy-james/review.md`);
	});

	test("caches folder resolution across calls", async () => {
		const calls = stubDav();
		const fetcher = newFetcher();
		await fetcher.fetchSharedFile(ROOM, "users/james", file);
		await fetcher.fetchSharedFile(ROOM, "users/james", { name: "second.md", size: 1 });
		const propfinds = calls.filter((c) => c.method === "PROPFIND");
		expect(propfinds.length).toBe(2);
		const gets = calls.filter((c) => c.method === "GET");
		expect(gets.length).toBe(2);
	});

	test("reports auth failures from PROPFIND", async () => {
		stubDav({ propfindStatus: 401 });
		const result = await newFetcher().fetchSharedFile(ROOM, "users/james", file);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("401");
	});

	test("reports a missing conversation folder with a participant hint", async () => {
		const calls = stubDav();
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const method = init?.method ?? "GET";
			calls.push({ method, url });
			if (method === "PROPFIND") return davPropfindResponse(["Unrelated-folder"]);
			return new Response("x", { status: 404 });
		}) as typeof fetch;
		const result = await newFetcher().fetchSharedFile(ROOM, "users/james", file);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("room participant");
	});

	test("re-walks folders once when the cached path 404s", async () => {
		const calls = stubDav({ getStatus: 404 });
		const result = await newFetcher().fetchSharedFile(ROOM, "users/james", file);
		expect(result.ok).toBe(false);
		// 2 initial PROPFINDs + 2 retry PROPFINDs + 2 GETs (original + retry)
		expect(calls.filter((c) => c.method === "PROPFIND").length).toBe(4);
		expect(calls.filter((c) => c.method === "GET").length).toBe(2);
	});

	test("falls back to the public share link when WebDAV fails", async () => {
		stubDav({ propfindStatus: 500 });
		let linkGet = "";
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url.startsWith("https://nextcloud.example.com/s/")) {
				linkGet = url;
				return new Response("link-bytes", { status: 200 });
			}
			if ((init?.method ?? "GET") === "PROPFIND") return new Response("no", { status: 500 });
			return new Response("x", { status: 404 });
		}) as typeof fetch;
		const result = await newFetcher().fetchSharedFile(ROOM, "users/james", {
			...file,
			link: "https://nextcloud.example.com/s/abc123",
		});
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.buffer.toString()).toBe("link-bytes");
		expect(linkGet).toBe("https://nextcloud.example.com/s/abc123/download");
	});

	test("rejects oversized files without any network calls", async () => {
		const calls = stubDav();
		const result = await newFetcher().fetchSharedFile(ROOM, "users/james", {
			name: "huge.bin",
			size: MAX_TALK_FILE_BYTES + 1,
		});
		expect(result.ok).toBe(false);
		expect(calls.length).toBe(0);
	});
});

describe("TalkFileFetcher.uploadToConversation", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	function newFetcher(): TalkFileFetcher {
		return new TalkFileFetcher({ talkServer: "nextcloud.example.com", userId: PHANTOM_ID, appPassword: "pw" });
	}

	function stubUploadDav(options?: { propfindSharer?: string[]; putStatus?: number; put404First?: boolean }) {
		const calls: Array<{ method: string; url: string }> = [];
		let putCount = 0;
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const method = init?.method ?? "GET";
			calls.push({ method, url });
			if (method === "PROPFIND") {
				if (url.endsWith("/Talk")) {
					return davPropfindResponse([`James McMurphy-${ROOM}`, "Other-room-xyz"]);
				}
				return davPropfindResponse(options?.propfindSharer ?? ["Phantom-phantom", "James McMurphy-james"]);
			}
			if (method === "MKCOL") return new Response("", { status: 201 });
			if (method === "PUT") {
				putCount += 1;
				if (options?.put404First && putCount === 1) return new Response("gone", { status: 404 });
				return new Response("", { status: options?.putStatus ?? 201 });
			}
			return new Response("unexpected", { status: 500 });
		}) as typeof fetch;
		return calls;
	}

	test("uploads into the service account's sharer subfolder", async () => {
		const calls = stubUploadDav();
		const result = await newFetcher().uploadToConversation(ROOM, "report.pdf", Buffer.from("pdf-bytes"));
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.path).toBe(`Talk/James McMurphy-${ROOM}/Phantom-phantom/report.pdf`);
		const puts = calls.filter((c) => c.method === "PUT");
		expect(puts.length).toBe(1);
		expect(decodeURIComponent(puts[0].url)).toContain(`Talk/James McMurphy-${ROOM}/Phantom-phantom/report.pdf`);
	});

	test("creates the out folder via MKCOL when it does not exist yet", async () => {
		const calls = stubUploadDav({ propfindSharer: ["James McMurphy-james"] });
		const result = await newFetcher().uploadToConversation(ROOM, "report.pdf", Buffer.from("pdf-bytes"));
		expect(result.ok).toBe(true);
		const mkcols = calls.filter((c) => c.method === "MKCOL");
		expect(mkcols.length).toBe(1);
		expect(decodeURIComponent(mkcols[0].url)).toContain("Phantom-phantom");
	});

	test("reports a failed PUT", async () => {
		stubUploadDav({ putStatus: 500 });
		const result = await newFetcher().uploadToConversation(ROOM, "report.pdf", Buffer.from("pdf-bytes"));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("PUT 500");
	});

	test("re-walks folders once when the PUT 404s on a cached path", async () => {
		const calls = stubUploadDav({ put404First: true });
		const result = await newFetcher().uploadToConversation(ROOM, "report.pdf", Buffer.from("pdf-bytes"));
		expect(result.ok).toBe(true);
		// 2 initial PROPFINDs + 2 retry PROPFINDs after cache invalidation
		expect(calls.filter((c) => c.method === "PROPFIND").length).toBe(4);
		expect(calls.filter((c) => c.method === "PUT").length).toBe(2);
	});
});

describe("file share webhook handling", () => {
	const originalFetch = globalThis.fetch;
	const originalWrite = Bun.write;
	let writes: Array<{ path: string; bytes: number }>;
	let botPosts: string[];
	let davCalls: Array<{ method: string; url: string }>;

	beforeEach(() => {
		writes = [];
		botPosts = [];
		davCalls = [];
		Bun.write = (async (path: string | number | URL, data: ArrayBuffer) => {
			const bytes = data instanceof ArrayBuffer ? data.byteLength : 0;
			writes.push({ path: String(path), bytes });
			return bytes;
		}) as typeof Bun.write;
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const method = init?.method ?? "GET";
			if (url.includes("/remote.php/dav/")) {
				davCalls.push({ method, url });
				if (method === "PROPFIND") {
					if (url.endsWith("/Talk")) {
						return davPropfindResponse([`Phantom WorkAgent-${ROOM}`]);
					}
					return davPropfindResponse(["James McMurphy-james"]);
				}
				return new Response("shared-file-bytes", { status: 200 });
			}
			if (url.includes("/ocs/v2.php/apps/spreed/api/v1/bot/")) {
				botPosts.push(url);
				return new Response(JSON.stringify({ ocs: { data: {} } }), { status: 200 });
			}
			return originalFetch(input, init);
		}) as typeof fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		Bun.write = originalWrite;
	});

	async function process(config: NextcloudChannelConfig, payload: unknown) {
		const channel = new NextcloudChannel(config);
		const received: InboundMessage[] = [];
		channel.onMessage(async (msg) => {
			received.push(msg);
		});
		const result = await (
			channel as unknown as {
				processWebhookPayload: (p: unknown) => Promise<{ status?: number; error?: string }>;
			}
		).processWebhookPayload(payload);
		return { result, received };
	}

	test("downloads an Activity file share and routes it with attachment metadata", async () => {
		const { received } = await process(baseConfig(), fileSharePayload({ type: "Activity" }));
		expect(received.length).toBe(1);
		const inbound = received[0] as InboundMessage;
		expect(inbound.text).toBe("[File attachment: talk-4242-review.md]");
		expect(inbound.attachments).toEqual([
			{
				filename: "talk-4242-review.md",
				path: "/app/data/attachments/talk-4242-review.md",
				size: 17,
				mimeType: "text/markdown",
			},
		]);
		expect(inbound.senderId).toBe("users/james");
		expect(writes.length).toBe(1);
		expect(davCalls.filter((c) => c.method === "GET").length).toBe(1);
	});

	test("a captioned Create carries placeholder text plus the caption", async () => {
		const { received } = await process(
			baseConfig(),
			fileSharePayload({ type: "Create", message: "please review this" }),
		);
		expect(received.length).toBe(1);
		expect((received[0] as InboundMessage).text).toBe("[File attachment: talk-4242-review.md] please review this");
	});

	test("ignores file shares echoed from the phantom service account", async () => {
		const { received } = await process(
			baseConfig(),
			fileSharePayload({ type: "Activity", actorId: "users/phantom", actorName: "Phantom WorkAgent" }),
		);
		expect(received.length).toBe(0);
		expect(davCalls.length).toBe(0);
		expect(writes.length).toBe(0);
	});

	test("file shares from non-owners get the rejection path, no download", async () => {
		const { received } = await process(
			baseConfig(),
			fileSharePayload({ type: "Activity", actorId: "users/mallory", actorName: "Mallory" }),
		);
		expect(received.length).toBe(0);
		expect(davCalls.length).toBe(0);
		// rejectNonOwner posts the rejection reply through the bot API
		expect(botPosts.length).toBe(1);
	});

	test("without service-account credentials the room is notified and nothing is routed", async () => {
		const { phantomAppPass: _omit, ...config } = baseConfig();
		const { received } = await process(config, fileSharePayload({ type: "Activity" }));
		expect(received.length).toBe(0);
		expect(davCalls.length).toBe(0);
		expect(botPosts.length).toBe(1);
	});

	test("a failed download announces the failure to the room instead of routing", async () => {
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const method = init?.method ?? "GET";
			if (url.includes("/remote.php/dav/")) {
				if (method === "PROPFIND") {
					if (url.endsWith("/Talk")) return davPropfindResponse([`Phantom WorkAgent-${ROOM}`]);
					return davPropfindResponse(["James McMurphy-james"]);
				}
				return new Response("gone", { status: 404 });
			}
			if (url.includes("/ocs/v2.php/apps/spreed/api/v1/bot/")) {
				botPosts.push(url);
				return new Response(JSON.stringify({ ocs: { data: {} } }), { status: 200 });
			}
			return originalFetch(input, init);
		}) as typeof fetch;
		const { received } = await process(baseConfig(), fileSharePayload({ type: "Activity" }));
		expect(received.length).toBe(0);
		expect(writes.length).toBe(0);
		expect(botPosts.length).toBe(1);
	});
});
