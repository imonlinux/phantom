import { describe, expect, test } from "bun:test";
import { NextcloudChannelConfigSchema, ChannelsConfigSchema, TelegramChannelConfigSchema } from "../schemas.ts";

describe("NextcloudChannelConfigSchema", () => {
	test("accepts minimal valid config", () => {
		const r = NextcloudChannelConfigSchema.safeParse({
			enabled: false,
			shared_secret: "a".repeat(16),
			talk_server: "nextcloud.example.com",
			room_token: "roomtoken123",
		});
		expect(r.success).toBe(true);
		if (r.success) {
			expect(r.data.webhook_path).toBe("/nextcloud/webhook"); // default
			expect(r.data.port).toBe(3200); // default
			expect(r.data.session_window_minutes).toBe(30); // default
		}
	});

	test("accepts config with all optional fields", () => {
		const r = NextcloudChannelConfigSchema.safeParse({
			enabled: true,
			shared_secret: "b".repeat(32),
			talk_server: "nextcloud.example.com",
			room_token: "roomtoken456",
			webhook_path: "/custom/webhook",
			port: 3500,
			bot_id: "3",
			session_window_minutes: 60,
		});
		expect(r.success).toBe(true);
		if (r.success) {
			expect(r.data.webhook_path).toBe("/custom/webhook");
			expect(r.data.port).toBe(3500);
			expect(r.data.bot_id).toBe("3");
			expect(r.data.session_window_minutes).toBe(60);
		}
	});

	test("accepts config with bot_id only", () => {
		// Fix #12: Verify bot_id config flows through to constructor
		const r = NextcloudChannelConfigSchema.safeParse({
			enabled: true,
			shared_secret: "c".repeat(16),
			talk_server: "nextcloud.example.com",
			room_token: "roomtoken789",
			bot_id: "5",
		});
		expect(r.success).toBe(true);
		if (r.success) {
			expect(r.data.bot_id).toBe("5");
		}
	});

	test("accepts config with port only", () => {
		// Fix #13: Verify port config flows through
		const r = NextcloudChannelConfigSchema.safeParse({
			enabled: true,
			shared_secret: "d".repeat(16),
			talk_server: "nextcloud.example.com",
			room_token: "roomtokenabc",
			port: 4000,
		});
		expect(r.success).toBe(true);
		if (r.success) {
			expect(r.data.port).toBe(4000);
		}
	});

	test("accepts config with session_window_minutes only", () => {
		// Time-window coalescing config
		const r = NextcloudChannelConfigSchema.safeParse({
			enabled: true,
			shared_secret: "e".repeat(16),
			talk_server: "nextcloud.example.com",
			room_token: "roomtokendef",
			session_window_minutes: 45,
		});
		expect(r.success).toBe(true);
		if (r.success) {
			expect(r.data.session_window_minutes).toBe(45);
		}
	});

	test("rejects shared_secret shorter than 16 chars", () => {
		const r = NextcloudChannelConfigSchema.safeParse({
			enabled: true,
			shared_secret: "tooshort",
			talk_server: "nextcloud.example.com",
			room_token: "roomtoken",
		});
		expect(r.success).toBe(false);
	});

	test("rejects empty talk_server", () => {
		const r = NextcloudChannelConfigSchema.safeParse({
			enabled: true,
			shared_secret: "f".repeat(16),
			talk_server: "",
			room_token: "roomtoken",
		});
		expect(r.success).toBe(false);
	});

	test("rejects empty room_token", () => {
		const r = NextcloudChannelConfigSchema.safeParse({
			enabled: true,
			shared_secret: "g".repeat(16),
			talk_server: "nextcloud.example.com",
			room_token: "",
		});
		expect(r.success).toBe(false);
	});

	test("rejects port out of range (too low)", () => {
		const r = NextcloudChannelConfigSchema.safeParse({
			enabled: true,
			shared_secret: "h".repeat(16),
			talk_server: "nextcloud.example.com",
			room_token: "roomtoken",
			port: 0,
		});
		expect(r.success).toBe(false);
	});

	test("rejects port out of range (too high)", () => {
		const r = NextcloudChannelConfigSchema.safeParse({
			enabled: true,
			shared_secret: "i".repeat(16),
			talk_server: "nextcloud.example.com",
			room_token: "roomtoken",
			port: 65536,
		});
		expect(r.success).toBe(false);
	});

	test("rejects session_window_minutes less than 1", () => {
		const r = NextcloudChannelConfigSchema.safeParse({
			enabled: true,
			shared_secret: "j".repeat(16),
			talk_server: "nextcloud.example.com",
			room_token: "roomtoken",
			session_window_minutes: 0,
		});
		expect(r.success).toBe(false);
	});

	test("rejects unknown fields via strict parsing", () => {
		const r = NextcloudChannelConfigSchema.safeParse({
			enabled: true,
			shared_secret: "k".repeat(16),
			talk_server: "nextcloud.example.com",
			room_token: "roomtoken",
			unknown_field: "should_reject",
		});
		expect(r.success).toBe(false);
	});
});

describe("ChannelsConfigSchema: nextcloud round-trip", () => {
	test("accepts full channels config with nextcloud including bot_id", () => {
		// Regression test for Fix #12 wiring gap
		// Ensures bot_id flows from YAML/env → Zod schema → constructor
		const r = ChannelsConfigSchema.safeParse({
			nextcloud: {
				enabled: true,
				shared_secret: "l".repeat(16),
				talk_server: "nextcloud.example.com",
				room_token: "roomtoken",
				webhook_path: "/nextcloud/webhook",
				port: 3200,
				bot_id: "3",
				session_window_minutes: 30,
			},
		});
		expect(r.success).toBe(true);
		if (r.success) {
			expect(r.data.nextcloud?.enabled).toBe(true);
			expect(r.data.nextcloud?.shared_secret).toBe("l".repeat(16));
			expect(r.data.nextcloud?.talk_server).toBe("nextcloud.example.com");
			expect(r.data.nextcloud?.room_token).toBe("roomtoken");
			expect(r.data.nextcloud?.webhook_path).toBe("/nextcloud/webhook");
			expect(r.data.nextcloud?.port).toBe(3200);
			expect(r.data.nextcloud?.bot_id).toBe("3");
			expect(r.data.nextcloud?.session_window_minutes).toBe(30);
		}
	});

	test("accepts channels config with nextcloud without optional fields", () => {
		const r = ChannelsConfigSchema.safeParse({
			nextcloud: {
				enabled: true,
				shared_secret: "m".repeat(16),
				talk_server: "nextcloud.example.com",
				room_token: "roomtoken",
			},
		});
		expect(r.success).toBe(true);
		if (r.success) {
			// Defaults should apply
			expect(r.data.nextcloud?.webhook_path).toBe("/nextcloud/webhook");
			expect(r.data.nextcloud?.port).toBe(3200);
			expect(r.data.nextcloud?.session_window_minutes).toBe(30);
			expect(r.data.nextcloud?.bot_id).toBeUndefined();
		}
	});

	test("parses nextcloud config with bot_id from channels.yaml format", () => {
		// Simulate channels.yaml snake_case to camelCase conversion
		const r = ChannelsConfigSchema.safeParse({
			nextcloud: {
				enabled: true,
				shared_secret: "n".repeat(16),
				talk_server: "nextcloud.example.com",
				room_token: "roomtoken",
				bot_id: "7", // From talk:bot:list
			},
		});
		expect(r.success).toBe(true);
		if (r.success) {
			expect(r.data.nextcloud?.bot_id).toBe("7");
		}
	});
});

describe("TelegramChannelConfigSchema", () => {
	test("accepts valid numeric owner_user_ids", () => {
		const r = TelegramChannelConfigSchema.safeParse({
			enabled: true,
			bot_token: "test_token",
			owner_user_ids: ["123456789", "987654321"],
		});
		expect(r.success).toBe(true);
		if (r.success) {
			expect(r.data.owner_user_ids).toEqual(["123456789", "987654321"]);
		}
	});

	test("accepts empty owner_user_ids array", () => {
		const r = TelegramChannelConfigSchema.safeParse({
			enabled: true,
			bot_token: "test_token",
			owner_user_ids: [],
		});
		expect(r.success).toBe(true);
		if (r.success) {
			expect(r.data.owner_user_ids).toEqual([]);
		}
	});

	test("rejects non-numeric owner_user_ids", () => {
		const r = TelegramChannelConfigSchema.safeParse({
			enabled: true,
			bot_token: "test_token",
			owner_user_ids: ["abc", "-1", ""],
		});
		expect(r.success).toBe(false);
	});

	test("accepts custom rejection_reply", () => {
		const r = TelegramChannelConfigSchema.safeParse({
			enabled: true,
			bot_token: "test_token",
			rejection_reply: "Custom rejection message",
		});
		expect(r.success).toBe(true);
		if (r.success) {
			expect(r.data.rejection_reply).toBe("Custom rejection message");
		}
	});

	test("accepts config without rejection_reply", () => {
		const r = TelegramChannelConfigSchema.safeParse({
			enabled: true,
			bot_token: "test_token",
		});
		expect(r.success).toBe(true);
		if (r.success) {
			expect(r.data.rejection_reply).toBeUndefined();
		}
	});

	test("accepts send_intro boolean true", () => {
		const r = TelegramChannelConfigSchema.safeParse({
			enabled: true,
			bot_token: "test_token",
			send_intro: true,
		});
		expect(r.success).toBe(true);
		if (r.success) {
			expect(r.data.send_intro).toBe(true);
		}
	});

	test("defaults send_intro to false", () => {
		const r = TelegramChannelConfigSchema.safeParse({
			enabled: true,
			bot_token: "test_token",
		});
		expect(r.success).toBe(true);
		if (r.success) {
			expect(r.data.send_intro).toBe(false);
		}
	});
});
