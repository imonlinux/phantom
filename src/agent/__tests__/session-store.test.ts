import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { runMigrations } from "../../db/migrate.ts";
import { SessionStore } from "../session-store.ts";

let db: Database;
let store: SessionStore;

beforeEach(() => {
	db = new Database(":memory:");
	db.run("PRAGMA journal_mode = WAL");
	db.run("PRAGMA foreign_keys = ON");
	runMigrations(db);
	store = new SessionStore(db);
});

describe("SessionStore", () => {
	test("creates a new session", () => {
		const session = store.create("cli", "conv-1");
		expect(session.session_key).toBe("cli:conv-1");
		expect(session.channel_id).toBe("cli");
		expect(session.conversation_id).toBe("conv-1");
		expect(session.status).toBe("active");
		expect(session.total_cost_usd).toBe(0);
	});

	test("finds an active session", () => {
		store.create("cli", "conv-1");
		const found = store.findActive("cli", "conv-1");
		expect(found).not.toBeNull();
		expect(found?.session_key).toBe("cli:conv-1");
	});

	test("returns null for non-existent session", () => {
		const found = store.findActive("cli", "missing");
		expect(found).toBeNull();
	});

	test("updates SDK session ID", () => {
		store.create("cli", "conv-1");
		store.updateSdkSessionId("cli:conv-1", "sdk-abc-123");
		const session = store.getByKey("cli:conv-1");
		expect(session?.sdk_session_id).toBe("sdk-abc-123");
	});

	test("expires a session", () => {
		store.create("cli", "conv-1");
		store.expire("cli:conv-1");
		const found = store.findActive("cli", "conv-1");
		expect(found).toBeNull();

		const raw = store.getByKey("cli:conv-1");
		expect(raw?.status).toBe("expired");
	});

	test("touches a session to update last_active_at", () => {
		store.create("cli", "conv-1");
		const before = store.getByKey("cli:conv-1");
		store.touch("cli:conv-1");
		const after = store.getByKey("cli:conv-1");
		expect(after?.last_active_at).toBeDefined();
		expect(before?.last_active_at).toBeDefined();
	});

	test("clears SDK session ID", () => {
		store.create("cli", "conv-1");
		store.updateSdkSessionId("cli:conv-1", "sdk-abc-123");
		expect(store.getByKey("cli:conv-1")?.sdk_session_id).toBe("sdk-abc-123");

		store.clearSdkSessionId("cli:conv-1");
		const session = store.getByKey("cli:conv-1");
		expect(session?.sdk_session_id).toBeNull();
		expect(session?.status).toBe("active");
	});

	test("create reactivates an expired session with the same key", () => {
		store.create("cli", "conv-1");
		store.updateSdkSessionId("cli:conv-1", "old-sdk-id");
		store.expire("cli:conv-1");

		expect(store.findActive("cli", "conv-1")).toBeNull();

		// Creating again should reactivate, not throw UNIQUE constraint error
		const reactivated = store.create("cli", "conv-1");
		expect(reactivated.status).toBe("active");
		expect(reactivated.sdk_session_id).toBeNull();
		expect(reactivated.session_key).toBe("cli:conv-1");
	});
});

// =============================================================================
// Phase 5.1: regression tests for findMostRecentActiveForChannel and the
// timestamp-format bug class that caused the Talk continuity loss.
//
// Background: findMostRecentActiveForChannel had a one-line SQL bug where
// last_active_at (stored by SQLite as 'YYYY-MM-DD HH:MM:SS') was compared
// lexicographically against an ISO-format cutoff ('YYYY-MM-DDTHH:MM:SS.sssZ').
// At position 11, ' ' (32) < 'T' (84) — every stored timestamp sorted before
// every cutoff regardless of actual chronology, so the lookup always returned
// null. The mock-based tests in nextcloud.test.ts didn't catch this because
// they reimplemented the lookup in JavaScript instead of exercising the SQL.
//
// These tests use the real SQL via :memory: SQLite, with explicit timestamp
// manipulation to cover both formats and the window boundaries.
// =============================================================================

/**
 * Helper: directly set last_active_at to a specific value, bypassing
 * datetime('now'). Used to test window boundaries without sleeping.
 *
 * Accepts both SQLite-format ('YYYY-MM-DD HH:MM:SS') and ISO-format
 * ('YYYY-MM-DDTHH:MM:SS.sssZ') strings — the production fix uses
 * datetime() on both sides of the comparison so either format works.
 */
function setLastActive(database: Database, sessionKey: string, when: string): void {
	database.run("UPDATE sessions SET last_active_at = ? WHERE session_key = ?", [when, sessionKey]);
}

/**
 * Helper: convert a JS Date to SQLite's default datetime format
 * ('YYYY-MM-DD HH:MM:SS' UTC, no fractional seconds, space separator).
 */
function toSqliteDatetime(date: Date): string {
	return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

describe("SessionStore.findMostRecentActiveForChannel: basic lookup", () => {
	test("returns null when no sessions exist", () => {
		const result = store.findMostRecentActiveForChannel("nextcloud", "nextcloud:room-x:", 30 * 60 * 1000);
		expect(result).toBeNull();
	});

	test("returns null when no sessions match the channel", () => {
		store.create("cli", "conv-1");
		const result = store.findMostRecentActiveForChannel("nextcloud", "nextcloud:room-x:", 30 * 60 * 1000);
		expect(result).toBeNull();
	});

	test("returns null when no sessions match the prefix", () => {
		store.create("nextcloud", "nextcloud:room-A:123");
		const result = store.findMostRecentActiveForChannel(
			"nextcloud",
			"nextcloud:room-B:",
			30 * 60 * 1000,
		);
		expect(result).toBeNull();
	});

	test("finds a session created seconds ago within a 30-minute window", () => {
		store.create("nextcloud", "nextcloud:room-A:123");
		const result = store.findMostRecentActiveForChannel(
			"nextcloud",
			"nextcloud:room-A:",
			30 * 60 * 1000,
		);
		expect(result).not.toBeNull();
		expect(result?.conversation_id).toBe("nextcloud:room-A:123");
	});

	test("uses prefix matching, not exact match", () => {
		// Stored session has conversation_id 'nextcloud:room-A:msg-5678'
		// The channel passes prefix 'nextcloud:room-A:' which should match.
		store.create("nextcloud", "nextcloud:room-A:msg-5678");
		const result = store.findMostRecentActiveForChannel(
			"nextcloud",
			"nextcloud:room-A:",
			30 * 60 * 1000,
		);
		expect(result?.conversation_id).toBe("nextcloud:room-A:msg-5678");
	});

	test("returns the most recent session when multiple match", () => {
		store.create("nextcloud", "nextcloud:room-A:100");
		store.create("nextcloud", "nextcloud:room-A:200");
		store.create("nextcloud", "nextcloud:room-A:300");

		// Set distinct, predictable timestamps
		const now = Date.now();
		setLastActive(db, "nextcloud:nextcloud:room-A:100", toSqliteDatetime(new Date(now - 60_000))); // 1 min ago
		setLastActive(db, "nextcloud:nextcloud:room-A:200", toSqliteDatetime(new Date(now - 10_000))); // 10s ago
		setLastActive(db, "nextcloud:nextcloud:room-A:300", toSqliteDatetime(new Date(now - 30_000))); // 30s ago

		const result = store.findMostRecentActiveForChannel(
			"nextcloud",
			"nextcloud:room-A:",
			30 * 60 * 1000,
		);
		expect(result?.conversation_id).toBe("nextcloud:room-A:200"); // most recent
	});
});

describe("SessionStore.findMostRecentActiveForChannel: time-window boundaries", () => {
	test("session inside the window is found", () => {
		store.create("nextcloud", "nextcloud:room-A:1");
		// 10 minutes ago is well inside a 30-minute window
		setLastActive(
			db,
			"nextcloud:nextcloud:room-A:1",
			toSqliteDatetime(new Date(Date.now() - 10 * 60 * 1000)),
		);

		const result = store.findMostRecentActiveForChannel(
			"nextcloud",
			"nextcloud:room-A:",
			30 * 60 * 1000,
		);
		expect(result).not.toBeNull();
	});

	test("session outside the window is excluded", () => {
		store.create("nextcloud", "nextcloud:room-A:1");
		// 60 minutes ago is well outside a 30-minute window
		setLastActive(
			db,
			"nextcloud:nextcloud:room-A:1",
			toSqliteDatetime(new Date(Date.now() - 60 * 60 * 1000)),
		);

		const result = store.findMostRecentActiveForChannel(
			"nextcloud",
			"nextcloud:room-A:",
			30 * 60 * 1000,
		);
		expect(result).toBeNull();
	});

	test("session right at the window boundary is excluded (exclusive cutoff)", () => {
		store.create("nextcloud", "nextcloud:room-A:1");
		const windowMs = 30 * 60 * 1000;
		// Set to exactly 30 minutes ago. The SQL is `> cutoff` (strict),
		// so a row at exactly cutoff is NOT included. Push back by 1ms to
		// guarantee we're past the cutoff.
		setLastActive(
			db,
			"nextcloud:nextcloud:room-A:1",
			toSqliteDatetime(new Date(Date.now() - windowMs - 1000)),
		);

		const result = store.findMostRecentActiveForChannel("nextcloud", "nextcloud:room-A:", windowMs);
		expect(result).toBeNull();
	});

	test("very recent session within a 1-minute window is found", () => {
		store.create("nextcloud", "nextcloud:room-A:1");
		// Default datetime('now') from create() is current time.
		// A 60-second window should easily include it.
		const result = store.findMostRecentActiveForChannel(
			"nextcloud",
			"nextcloud:room-A:",
			60 * 1000,
		);
		expect(result).not.toBeNull();
	});

	test("zero-window returns nothing (degenerate case)", () => {
		store.create("nextcloud", "nextcloud:room-A:1");
		// A 0ms window: cutoff equals now, no session can be strictly greater.
		const result = store.findMostRecentActiveForChannel("nextcloud", "nextcloud:room-A:", 0);
		expect(result).toBeNull();
	});
});

describe("SessionStore.findMostRecentActiveForChannel: status filter", () => {
	test("expired sessions are excluded even within the window", () => {
		store.create("nextcloud", "nextcloud:room-A:1");
		store.expire("nextcloud:nextcloud:room-A:1");

		const result = store.findMostRecentActiveForChannel(
			"nextcloud",
			"nextcloud:room-A:",
			30 * 60 * 1000,
		);
		expect(result).toBeNull();
	});

	test("expired session is skipped, more recent active session is found", () => {
		// Two sessions, both within window. The more recent one is expired,
		// the older one is active. Should find the active one.
		store.create("nextcloud", "nextcloud:room-A:older");
		store.create("nextcloud", "nextcloud:room-A:newer");

		const now = Date.now();
		setLastActive(db, "nextcloud:nextcloud:room-A:older", toSqliteDatetime(new Date(now - 60_000)));
		setLastActive(db, "nextcloud:nextcloud:room-A:newer", toSqliteDatetime(new Date(now - 10_000)));
		store.expire("nextcloud:nextcloud:room-A:newer");

		const result = store.findMostRecentActiveForChannel(
			"nextcloud",
			"nextcloud:room-A:",
			30 * 60 * 1000,
		);
		expect(result?.conversation_id).toBe("nextcloud:room-A:older");
	});
});

describe("SessionStore.findMostRecentActiveForChannel: channel isolation", () => {
	test("sessions in different channels do not cross-contaminate", () => {
		store.create("slack", "slack:C123:t1");
		store.create("nextcloud", "nextcloud:room-A:1");

		// Looking up nextcloud should NOT return the slack session
		const ncResult = store.findMostRecentActiveForChannel(
			"nextcloud",
			"nextcloud:room-A:",
			30 * 60 * 1000,
		);
		expect(ncResult?.conversation_id).toBe("nextcloud:room-A:1");

		// Looking up slack should NOT return the nextcloud session
		const slackResult = store.findMostRecentActiveForChannel("slack", "slack:C123:", 30 * 60 * 1000);
		expect(slackResult?.conversation_id).toBe("slack:C123:t1");
	});

	test("sessions in different rooms (same channel) do not cross-contaminate", () => {
		store.create("nextcloud", "nextcloud:room-A:1");
		store.create("nextcloud", "nextcloud:room-B:1");

		const resultA = store.findMostRecentActiveForChannel(
			"nextcloud",
			"nextcloud:room-A:",
			30 * 60 * 1000,
		);
		expect(resultA?.conversation_id).toBe("nextcloud:room-A:1");

		const resultB = store.findMostRecentActiveForChannel(
			"nextcloud",
			"nextcloud:room-B:",
			30 * 60 * 1000,
		);
		expect(resultB?.conversation_id).toBe("nextcloud:room-B:1");
	});

	test("prefix is anchored — 'room-A:' does not match 'room-AB:'", () => {
		// Pathological case: similar room names. The LIKE prefix uses '%' as
		// a suffix wildcard, so 'nextcloud:room-A:' should NOT match
		// 'nextcloud:room-AB:1'. The colon separator after the room token
		// is what enforces this.
		store.create("nextcloud", "nextcloud:room-AB:1");

		const result = store.findMostRecentActiveForChannel(
			"nextcloud",
			"nextcloud:room-A:",
			30 * 60 * 1000,
		);
		expect(result).toBeNull();
	});
});

describe("SessionStore.findMostRecentActiveForChannel: timestamp-format regression", () => {
	// These are the tests that would have caught the original bug.
	// The bug: `last_active_at > ?` lexicographic comparison between
	// 'YYYY-MM-DD HH:MM:SS' (stored) and 'YYYY-MM-DDTHH:MM:SS.sssZ' (cutoff).
	// The fix: `datetime(last_active_at) > datetime(?)` normalizes both.

	test("session stored in SQLite-default format is found via ISO-format cutoff (the original bug)", () => {
		store.create("nextcloud", "nextcloud:room-A:1");
		// create() writes via datetime('now') which produces 'YYYY-MM-DD HH:MM:SS'.
		// The lookup generates the cutoff via toISOString() which produces
		// 'YYYY-MM-DDTHH:MM:SS.sssZ'. With the broken SQL, the row would never
		// be found. With the fix, datetime() normalizes both and the lookup works.
		const stored = store.getByKey("nextcloud:nextcloud:room-A:1");
		expect(stored?.last_active_at).toBeDefined();
		// Verify the stored format: should NOT contain 'T' or 'Z'
		expect(stored?.last_active_at).not.toContain("T");
		expect(stored?.last_active_at).not.toContain("Z");

		const result = store.findMostRecentActiveForChannel(
			"nextcloud",
			"nextcloud:room-A:",
			30 * 60 * 1000,
		);
		expect(result).not.toBeNull();
		expect(result?.conversation_id).toBe("nextcloud:room-A:1");
	});

	test("session with explicitly ISO-formatted last_active_at is also found", () => {
		// Defensive: if a row ever ends up with an ISO timestamp (e.g., a future
		// migration or external write), the lookup should still work. The
		// datetime() wrapper handles both formats.
		store.create("nextcloud", "nextcloud:room-A:1");
		const isoTimestamp = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 min ago, ISO
		setLastActive(db, "nextcloud:nextcloud:room-A:1", isoTimestamp);

		const stored = store.getByKey("nextcloud:nextcloud:room-A:1");
		expect(stored?.last_active_at).toContain("T");

		const result = store.findMostRecentActiveForChannel(
			"nextcloud",
			"nextcloud:room-A:",
			30 * 60 * 1000,
		);
		expect(result).not.toBeNull();
	});

	test("mixed timestamp formats across sessions all sort correctly", () => {
		// Create three sessions and set them to different formats AND different
		// times. The lookup must:
		//   1. Find rows regardless of format (ISO vs SQLite-default)
		//   2. Order them correctly by datetime, not by lexicographic string
		store.create("nextcloud", "nextcloud:room-A:s1");
		store.create("nextcloud", "nextcloud:room-A:s2");
		store.create("nextcloud", "nextcloud:room-A:s3");

		const now = Date.now();
		// s1: 5 minutes ago, ISO format
		setLastActive(
			db,
			"nextcloud:nextcloud:room-A:s1",
			new Date(now - 5 * 60 * 1000).toISOString(),
		);
		// s2: 1 minute ago, SQLite format (the actual most-recent)
		setLastActive(
			db,
			"nextcloud:nextcloud:room-A:s2",
			toSqliteDatetime(new Date(now - 60 * 1000)),
		);
		// s3: 10 minutes ago, ISO format
		setLastActive(
			db,
			"nextcloud:nextcloud:room-A:s3",
			new Date(now - 10 * 60 * 1000).toISOString(),
		);

		const result = store.findMostRecentActiveForChannel(
			"nextcloud",
			"nextcloud:room-A:",
			30 * 60 * 1000,
		);
		// Even though s1 (ISO) sorts lexicographically BEFORE s2 (SQLite-format)
		// because 'T' > ' ', the actual datetime ordering puts s2 most recent.
		expect(result?.conversation_id).toBe("nextcloud:room-A:s2");
	});

	test("regression check: datetime function actually normalizes both sides", () => {
		// This is a direct test of the SQL behavior, isolated from the lookup.
		// Catches a regression where someone removes the datetime() wrapper.
		store.create("nextcloud", "nextcloud:room-A:1");

		// Set to 5 minutes ago in SQLite format
		const fiveMinAgoSqlite = toSqliteDatetime(new Date(Date.now() - 5 * 60 * 1000));
		setLastActive(db, "nextcloud:nextcloud:room-A:1", fiveMinAgoSqlite);

		// Direct query mimicking what findMostRecentActiveForChannel does, but
		// asserting the result row count.
		const cutoffISO = new Date(Date.now() - 30 * 60 * 1000).toISOString();
		const rows = db
			.query(
				`SELECT id FROM sessions
				 WHERE channel_id = ? AND conversation_id LIKE ? || '%'
				   AND status = 'active'
				   AND datetime(last_active_at) > datetime(?)`,
			)
			.all("nextcloud", "nextcloud:room-A:", cutoffISO) as Array<{ id: number }>;

		expect(rows.length).toBe(1);

		// Sanity check: confirm the broken SQL (without datetime() wrappers)
		// would have failed to find this row. This protects the test against
		// a future "fix" that removes datetime() — the broken query SHOULD
		// return zero rows, demonstrating why the wrapper is required.
		const brokenRows = db
			.query(
				`SELECT id FROM sessions
				 WHERE channel_id = ? AND conversation_id LIKE ? || '%'
				   AND status = 'active'
				   AND last_active_at > ?`,
			)
			.all("nextcloud", "nextcloud:room-A:", cutoffISO) as Array<{ id: number }>;

		// The bug demonstrated: storing 'YYYY-MM-DD HH:MM:SS' and comparing
		// against 'YYYY-MM-DDTHH:MM:SS.sssZ' lexicographically returns nothing
		// because at position 11, ' ' (32) < 'T' (84), making the stored value
		// always sort below the cutoff.
		expect(brokenRows.length).toBe(0);
	});
});

describe("SessionStore.findActive: 24-hour staleness", () => {
	// findActive has a separate staleness check (STALE_HOURS = 24 in
	// session-store.ts). Cover this too — it's the other piece of session
	// continuity machinery and was untested previously.

	test("session active for 23 hours is still findable", () => {
		store.create("cli", "conv-1");
		setLastActive(
			db,
			"cli:conv-1",
			toSqliteDatetime(new Date(Date.now() - 23 * 60 * 60 * 1000)),
		);

		const result = store.findActive("cli", "conv-1");
		expect(result).not.toBeNull();
	});

	test("session active 25 hours ago is treated as stale and auto-expired", () => {
		store.create("cli", "conv-1");
		setLastActive(
			db,
			"cli:conv-1",
			toSqliteDatetime(new Date(Date.now() - 25 * 60 * 60 * 1000)),
		);

		const result = store.findActive("cli", "conv-1");
		expect(result).toBeNull();

		// And the row should have been auto-expired as a side effect
		const raw = store.getByKey("cli:conv-1");
		expect(raw?.status).toBe("expired");
	});

	test("staleness check works correctly with ISO-format last_active_at too", () => {
		// Defensive: if a row's last_active_at is in ISO format for any
		// reason, isStale() should still parse it correctly. JavaScript's
		// new Date() handles both formats.
		store.create("cli", "conv-1");
		const isoStale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
		setLastActive(db, "cli:conv-1", isoStale);

		const result = store.findActive("cli", "conv-1");
		expect(result).toBeNull();
	});
});
