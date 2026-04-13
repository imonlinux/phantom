import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MIGRATIONS } from "../../../db/schema.ts";
import { handleUiRequest, setDashboardDb, setPublicDir } from "../../serve.ts";
import { createSession, revokeAllSessions } from "../../session.ts";

setPublicDir(resolve(import.meta.dir, "../../../../public"));

let tmp: string;
let db: Database;
let sessionToken: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "phantom-memfiles-api-"));
	process.env.PHANTOM_MEMORY_FILES_ROOT = tmp;
	db = new Database(":memory:");
	for (const migration of MIGRATIONS) {
		try {
			db.run(migration);
		} catch {
			// ignore ALTER TABLE duplicate failures
		}
	}
	setDashboardDb(db);
	sessionToken = createSession().sessionToken;
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
	Reflect.deleteProperty(process.env, "PHANTOM_MEMORY_FILES_ROOT");
	db.close();
	revokeAllSessions();
});

function req(path: string, init?: RequestInit): Request {
	return new Request(`http://localhost${path}`, {
		...init,
		headers: {
			Cookie: `phantom_session=${encodeURIComponent(sessionToken)}`,
			Accept: "application/json",
			...((init?.headers as Record<string, string>) ?? {}),
		},
	});
}

describe("memory-files API", () => {
	test("401 without session cookie", async () => {
		const res = await handleUiRequest(
			new Request("http://localhost/ui/api/memory-files", { headers: { Accept: "application/json" } }),
		);
		expect(res.status).toBe(401);
	});

	test("GET /ui/api/memory-files returns empty list", async () => {
		const res = await handleUiRequest(req("/ui/api/memory-files"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { files: unknown[] };
		expect(body.files.length).toBe(0);
	});

	test("POST creates a memory file at a nested path", async () => {
		const res = await handleUiRequest(
			req("/ui/api/memory-files", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ path: "memory/notes.md", content: "# Notes\n" }),
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { file: { path: string; content: string } };
		expect(body.file.path).toBe("memory/notes.md");
		expect(body.file.content).toBe("# Notes\n");
	});

	test("POST rejects skills/ paths", async () => {
		const res = await handleUiRequest(
			req("/ui/api/memory-files", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ path: "skills/evil.md", content: "x" }),
			}),
		);
		expect(res.status).toBe(422);
	});

	test("GET encoded path returns the file", async () => {
		await handleUiRequest(
			req("/ui/api/memory-files", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ path: "CLAUDE.md", content: "# Top\n" }),
			}),
		);
		const res = await handleUiRequest(req(`/ui/api/memory-files/${encodeURIComponent("CLAUDE.md")}`));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { file: { path: string; content: string } };
		expect(body.file.path).toBe("CLAUDE.md");
	});

	test("PUT updates and DELETE removes", async () => {
		await handleUiRequest(
			req("/ui/api/memory-files", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ path: "CLAUDE.md", content: "first" }),
			}),
		);
		const put = await handleUiRequest(
			req(`/ui/api/memory-files/${encodeURIComponent("CLAUDE.md")}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ content: "second" }),
			}),
		);
		expect(put.status).toBe(200);
		const del = await handleUiRequest(
			req(`/ui/api/memory-files/${encodeURIComponent("CLAUDE.md")}`, { method: "DELETE" }),
		);
		expect(del.status).toBe(200);
		const list = (await (await handleUiRequest(req("/ui/api/memory-files"))).json()) as { files: unknown[] };
		expect(list.files.length).toBe(0);
	});
});
