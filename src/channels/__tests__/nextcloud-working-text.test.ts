import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NextcloudChannel, type NextcloudChannelConfig } from "../nextcloud.ts";

// Test constants
const SHARED_SECRET = "test-secret-at-least-16-chars-for-hmac";
const TALK_SERVER = "nextcloud.example.com";
const ROOM_TOKEN = "testroomtoken";
const SERVICE_USER = "phantom";
const SERVICE_PASS = "service-account-app-password";
const OWNER_ID = "users/james";

function signWebhookPayload(random: string, body: string, secret: string): string {
	const crypto = require("node:crypto");
	const hmac = crypto.createHmac("sha256", secret);
	hmac.update(random);
	hmac.update(body);
	return hmac.digest("hex");
}

const testConfig: NextcloudChannelConfig = {
	sharedSecret: SHARED_SECRET,
	talkServer: TALK_SERVER,
	roomToken: ROOM_TOKEN,
	port: 3202, // dedicated port: nextcloud.test.ts uses 3201
	webhookPath: "/nextcloud/webhook",
	sessionWindowMinutes: 30,
	ownerUserId: OWNER_ID,
	phantomId: SERVICE_USER,
	phantomAppPass: SERVICE_PASS,
};

describe("NextcloudChannel service-account chat API (working text)", () => {
	let channel: NextcloudChannel;
	let originalFetch: typeof fetch;
	// Pristine fetch, never stubbed: the 404 test stacks a second stub on top
	// and must fall through to something that is not the first stub itself.
	let realFetch: typeof fetch;

	// Outbound traffic recorder, scoped by endpoint family so assertions can
	// separate the ask-features probe, bot posts, and user chat API calls.
	let chatCalls: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> = [];
	let botCalls: Array<{ url: string; method: string; body: string }> = [];
	let chatPostFailures = 0; // number of initial chat POSTs that answer 500

	function stubResponse(url: string): Response {
		// Edit/delete target /chat/{token}/{messageId}: an id suffix after
		// the token distinguishes them from the bare post endpoint.
		if (/\/chat\/[^/]+\/[0-9]+$/.test(url)) {
			return Response.json({ ocs: { meta: {}, data: null } }, { status: 200 });
		}
		if (url.includes("/chat/")) {
			if (chatPostFailures > 0) {
				chatPostFailures--;
				return new Response(JSON.stringify({ message: "Internal Server Error" }), {
					status: 500,
					headers: { "Retry-After": "0", "Content-Type": "application/json" },
				});
			}
			return Response.json({ ocs: { meta: {}, data: { id: 4242 } } }, { status: 200 });
		}
		if (url.includes("/bot/")) {
			return Response.json({ ocs: { meta: {}, data: null } }, { status: 201 });
		}
		return Response.json({ ocs: { meta: {}, data: { features: 15 } } }, { status: 200 });
	}

	beforeEach(async () => {
		chatCalls = [];
		botCalls = [];
		chatPostFailures = 0;
		originalFetch = globalThis.fetch;
		realFetch = originalFetch;
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const method = init?.method ?? "GET";
			if (url.includes(TALK_SERVER)) {
				const headers = (init?.headers ?? {}) as Record<string, string>;
				if (url.includes("/bot/")) {
					botCalls.push({ url, method, body: String(init?.body ?? "") });
				} else {
					chatCalls.push({ url, method, headers, body: String(init?.body ?? "") });
				}
				return stubResponse(url);
			}
			return originalFetch(input, init);
		}) as typeof fetch;

		channel = new NextcloudChannel(testConfig);
		await channel.connect();
	});

	afterEach(async () => {
		await channel.disconnect();
		globalThis.fetch = originalFetch;
	});

	describe("hasServiceAccount", () => {
		test("true when both phantomId and phantomAppPass are configured", () => {
			expect(channel.hasServiceAccount()).toBe(true);
		});

		test("false when the app password is missing", () => {
			const partial = new NextcloudChannel({ ...testConfig, phantomAppPass: undefined });
			expect(partial.hasServiceAccount()).toBe(false);
		});

		test("false when the user id is missing", () => {
			const partial = new NextcloudChannel({ ...testConfig, phantomId: undefined });
			expect(partial.hasServiceAccount()).toBe(false);
		});
	});

	describe("postChatMessage", () => {
		test("posts via the user chat API and returns the message ID", async () => {
			const id = await channel.postChatMessage(ROOM_TOKEN, "⏳ Working on it...", { silent: true });
			expect(id).toBe(4242);

			expect(chatCalls).toHaveLength(1);
			const call = chatCalls[0];
			expect(call.method).toBe("POST");
			expect(call.url).toBe(`https://${TALK_SERVER}/ocs/v2.php/apps/spreed/api/v1/chat/${ROOM_TOKEN}`);
			expect(call.headers.Authorization).toBe(
				`Basic ${Buffer.from(`${SERVICE_USER}:${SERVICE_PASS}`).toString("base64")}`,
			);
			expect(call.headers["OCS-APIRequest"]).toBe("true");
			expect(call.headers.Accept).toBe("application/json");
			const payload = JSON.parse(call.body);
			expect(payload.message).toBe("⏳ Working on it...");
			expect(payload.silent).toBe(true);
		});

		test("passes threadId for thread-scoped placeholders", async () => {
			await channel.postChatMessage(ROOM_TOKEN, "working", { silent: true, threadId: 77 });
			const payload = JSON.parse(chatCalls[0].body);
			expect(payload.threadId).toBe(77);
		});

		test("returns null and never touches the network without a service account", async () => {
			const bare = new NextcloudChannel({ ...testConfig, phantomId: undefined, phantomAppPass: undefined });
			const id = await bare.postChatMessage(ROOM_TOKEN, "hello");
			expect(id).toBeNull();
			expect(chatCalls).toHaveLength(0);
			await bare.disconnect();
		});

		test("retries a 500 once and succeeds on the second attempt", async () => {
			chatPostFailures = 1;
			const id = await channel.postChatMessage(ROOM_TOKEN, "hello");
			expect(id).toBe(4242);
			expect(chatCalls).toHaveLength(2);
		});

		test("returns null after exhausting retries on repeated 500s", async () => {
			chatPostFailures = 99;
			const id = await channel.postChatMessage(ROOM_TOKEN, "hello");
			expect(id).toBeNull();
			expect(chatCalls).toHaveLength(2); // 1 initial + 1 retry
		});
	});

	describe("editChatMessage", () => {
		test("PUTs the new text to the message endpoint and returns true", async () => {
			const ok = await channel.editChatMessage(ROOM_TOKEN, 4242, "> Reading /src/main.ts");
			expect(ok).toBe(true);
			expect(chatCalls).toHaveLength(1);
			const call = chatCalls[0];
			expect(call.method).toBe("PUT");
			expect(call.url).toBe(`https://${TALK_SERVER}/ocs/v2.php/apps/spreed/api/v1/chat/${ROOM_TOKEN}/4242`);
			expect(JSON.parse(call.body).message).toBe("> Reading /src/main.ts");
		});

		test("returns false without a service account", async () => {
			const bare = new NextcloudChannel({ ...testConfig, phantomId: undefined, phantomAppPass: undefined });
			const ok = await bare.editChatMessage(ROOM_TOKEN, 4242, "x");
			expect(ok).toBe(false);
			expect(chatCalls).toHaveLength(0);
			await bare.disconnect();
		});
	});

	describe("deleteChatMessage", () => {
		test("DELETEs the message and returns true on success", async () => {
			const ok = await channel.deleteChatMessage(ROOM_TOKEN, 4242);
			expect(ok).toBe(true);
			expect(chatCalls[0].method).toBe("DELETE");
			expect(chatCalls[0].url).toBe(
				`https://${TALK_SERVER}/ocs/v2.php/apps/spreed/api/v1/chat/${ROOM_TOKEN}/4242`,
			);
		});

		test("treats 404 as success (message already gone)", async () => {
			// Stack a dedicated 404 stub on top of the suite stub
			globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				if (url.includes(TALK_SERVER) && /\/chat\/[^/]+\/[0-9]+$/.test(url)) {
					return new Response("Not Found", { status: 404 });
				}
				return realFetch(input, init);
			}) as typeof fetch;

			const ok = await channel.deleteChatMessage(ROOM_TOKEN, 999999);
			expect(ok).toBe(true);
		});
	});

	describe("service-account self-echo ingest guard", () => {
		async function postWebhook(payload: Record<string, unknown>): Promise<Response> {
			const body = JSON.stringify(payload);
			const random = crypto.randomUUID().replaceAll("-", "");
			const signature = signWebhookPayload(random, body, SHARED_SECRET);
			return fetch(`http://localhost:3202${testConfig.webhookPath}`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-nextcloud-talk-random": random,
					"x-nextcloud-talk-signature": signature,
				},
				body,
			});
		}

		function createPayload(actorId: string, messageId: number, content: string) {
			return {
				type: "Create",
				actor: { type: "Person", id: actorId, name: "Actor" },
				object: { id: messageId, type: "Note", content },
				target: { id: ROOM_TOKEN, name: "Test Room" },
			};
		}

		test("silently drops a Create hook from the service account without owner rejection", async () => {
			// actorId matches users/<phantomId> and is NOT the owner; without the
			// guard this would hit the owner gate and post a rejection message.
			const res = await postWebhook(createPayload(`users/${SERVICE_USER}`, 5001, "⏳ Working on it..."));
			expect(res.status).toBe(200);

			await new Promise((r) => setTimeout(r, 150));
			const rejectionPosts = botCalls.filter((c) => c.method === "POST" && !c.url.includes("ask-features"));
			expect(rejectionPosts).toHaveLength(0);
		});

		test("still rejects Create hooks from other non-owners", async () => {
			const res = await postWebhook(createPayload("users/mallory", 5002, "hello bot"));
			expect(res.status).toBe(200);

			await new Promise((r) => setTimeout(r, 150));
			const rejectionPosts = botCalls.filter((c) => c.method === "POST" && !c.url.includes("ask-features"));
			expect(rejectionPosts).toHaveLength(1);
		});
	});
});
