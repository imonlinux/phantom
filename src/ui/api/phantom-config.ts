// UI API routes for the phantom.yaml operator-configuration surface (PR 6).
//
// All routes live under /ui/api/phantom-config and are cookie-auth gated by
// the dispatcher in src/ui/serve.ts. This endpoint replaces the earlier
// /ui/api/settings surface that edited ~/.claude/settings.json. Settings
// that belong to the Claude Agent SDK stay SSH-editable; everything here
// edits config/phantom.yaml (and its satellite overlay files) and is safe
// to change from a dashboard.
//
//   GET  /ui/api/phantom-config           -> full UI-visible config + last-modified
//   PUT  /ui/api/phantom-config           -> partial update, atomic YAML write, audit row
//   GET  /ui/api/phantom-config/audit     -> newest-first audit rows, limit capped
//
// Secrets never flow through this endpoint. PhantomConfigForUI is built from
// PhantomConfigSchema by .pick() so keys like provider.api_key_env, Slack
// tokens, email passwords, and webhook secrets are NOT part of the shape.
// The Zod schema uses .strict() so any attempt to PUT an unknown key returns
// 400 at parse time; that is how the secrets denylist is enforced.
//
// Atomic write: writeAtomic() from src/config/atomic-write.ts uses tmp file +
// rename so a mid-write crash cannot leave a torn phantom.yaml on disk. A
// failed rename deletes the temp file; the original phantom.yaml is byte-
// identical to before. See __tests__/phantom-config.test.ts for the explicit
// failure-path assertions.

import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import {
	EvolutionUiConfigSchema,
	PermissionsConfigSchema,
	PhantomConfigSchema,
} from "../../config/schemas.ts";
import { writeAtomic } from "../../config/atomic-write.ts";

// Well-known paths. Overridable via the setter in src/ui/serve.ts so tests
// can redirect every write to a tmp dir.
const DEFAULT_PHANTOM_YAML = "config/phantom.yaml";
const DEFAULT_CHANNELS_YAML = "config/channels.yaml";
const DEFAULT_EVOLUTION_META = "phantom-config/meta/evolution.json";

export type PhantomConfigPaths = {
	phantomYaml: string;
	channelsYaml: string;
	evolutionMeta: string;
};

export type PhantomConfigApiDeps = {
	db: Database;
	paths?: Partial<PhantomConfigPaths>;
	// Test seam: lets phantom-config.test.ts simulate a mid-write rename
	// failure without running a real readonly filesystem. Production wiring
	// leaves this undefined so writeAtomic uses fs.renameSync.
	renameImpl?: (from: string, to: string) => void;
};

const AUDIT_LIMIT_MAX = 100;
const AUDIT_LIMIT_DEFAULT = 20;

// ---------------------------------------------------------------------------
// Shape of the UI-visible config. Built by pick()/extend() off the canonical
// PhantomConfigSchema so a schema drift in one file cannot ship a UI that
// reads a different surface than the loader does.
// ---------------------------------------------------------------------------

const ChannelEnabledSchema = z.object({ enabled: z.boolean().default(false) });

const ChannelsUiSchema = z
	.object({
		slack: ChannelEnabledSchema.default({}),
		telegram: ChannelEnabledSchema.default({}),
		email: ChannelEnabledSchema.default({}),
		webhook: ChannelEnabledSchema.default({}),
	})
	.default({});

const MemoryUiSchema = z
	.object({
		qdrant_url: z.string().url(),
		ollama_url: z.string().url(),
		embedding_model: z.string().min(1),
		episode_limit: z.number().int().min(1).max(500),
		fact_limit: z.number().int().min(1).max(1000),
		procedure_limit: z.number().int().min(1).max(500),
	})
	.strict();

// Strict subset of PhantomConfigSchema. Unknown top-level keys fail parse.
// Every field that lives in phantom.yaml but is NOT in this shape stays
// editable via SSH only.
export const PhantomConfigForUiSchema = z
	.object({
		name: PhantomConfigSchema.shape.name,
		role: z.string().min(1),
		public_url: z.string().url().nullable().optional(),
		domain: z.string().min(1).nullable().optional(),
		model: z.string().min(1),
		judge_model: z.string().min(1).nullable().optional(),
		effort: PhantomConfigSchema.shape.effort,
		max_budget_usd: z.number().min(0).max(100_000),
		timeout_minutes: z.number().int().min(1).max(1440),
		permissions: PermissionsConfigSchema,
		evolution: EvolutionUiConfigSchema,
		channels: ChannelsUiSchema,
		memory: MemoryUiSchema,
	})
	.strict();

export type PhantomConfigForUi = z.infer<typeof PhantomConfigForUiSchema>;

// Partial schema for PUT bodies. Each top-level slice is independently
// optional; inside a slice, the nested object is .partial() so a caller can
// update only the fields they care about (e.g. just permissions.allow). Still
// .strict() at every level so unknown keys reject.
export const PhantomConfigPutSchema = z
	.object({
		name: PhantomConfigSchema.shape.name.optional(),
		role: z.string().min(1).optional(),
		public_url: z.string().url().nullable().optional(),
		domain: z.string().min(1).nullable().optional(),
		model: z.string().min(1).optional(),
		judge_model: z.string().min(1).nullable().optional(),
		effort: PhantomConfigSchema.shape.effort.optional(),
		max_budget_usd: z.number().min(0).max(100_000).optional(),
		timeout_minutes: z.number().int().min(1).max(1440).optional(),
		permissions: z
			.object({
				default_mode: z.enum(["default", "acceptEdits", "bypassPermissions"]).optional(),
				allow: z.array(z.string().min(1)).optional(),
				deny: z.array(z.string().min(1)).optional(),
			})
			.strict()
			.optional(),
		evolution: z
			.object({
				reflection_enabled: z.enum(["auto", "always", "never"]).optional(),
				cadence_minutes: z.number().int().min(1).max(10080).optional(),
				demand_trigger_depth: z.number().int().min(1).max(1000).optional(),
			})
			.strict()
			.optional(),
		channels: z
			.object({
				slack: z.object({ enabled: z.boolean() }).strict().optional(),
				telegram: z.object({ enabled: z.boolean() }).strict().optional(),
				email: z.object({ enabled: z.boolean() }).strict().optional(),
				webhook: z.object({ enabled: z.boolean() }).strict().optional(),
			})
			.strict()
			.optional(),
		memory: z
			.object({
				qdrant_url: z.string().url().optional(),
				ollama_url: z.string().url().optional(),
				embedding_model: z.string().min(1).optional(),
				episode_limit: z.number().int().min(1).max(500).optional(),
				fact_limit: z.number().int().min(1).max(1000).optional(),
				procedure_limit: z.number().int().min(1).max(500).optional(),
			})
			.strict()
			.optional(),
	})
	.strict();

export type PhantomConfigPut = z.infer<typeof PhantomConfigPutSchema>;

export type PhantomConfigAuditEntry = {
	id: number;
	section: string | null;
	field: string;
	previous_value: string | null;
	new_value: string | null;
	actor: string;
	created_at: string;
};

// ---------------------------------------------------------------------------
// Response helpers.
// ---------------------------------------------------------------------------

function json(body: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(body), {
		...init,
		headers: {
			"Content-Type": "application/json",
			"Cache-Control": "no-store",
			...((init?.headers as Record<string, string>) ?? {}),
		},
	});
}

function errJson(error: string, status: number, extras?: Record<string, unknown>): Response {
	return json({ error, ...(extras ?? {}) }, { status });
}

function zodErrorMessage(err: z.ZodError): { path: string; message: string } {
	const issue = err.issues[0];
	const path = issue?.path?.length ? issue.path.map((p) => String(p)).join(".") : "body";
	return { path, message: issue?.message ?? "invalid input" };
}

async function parseJsonBody<T>(
	req: Request,
	schema: z.ZodType<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: string; status: number; field?: string }> {
	let raw: unknown;
	try {
		raw = await req.json();
	} catch {
		return { ok: false, error: "Invalid JSON body", status: 400 };
	}
	const parsed = schema.safeParse(raw);
	if (!parsed.success) {
		const { path, message } = zodErrorMessage(parsed.error);
		return { ok: false, error: `${path}: ${message}`, status: 400, field: path };
	}
	return { ok: true, value: parsed.data };
}

// ---------------------------------------------------------------------------
// Filesystem helpers: parse phantom.yaml + channels.yaml + evolution.json,
// project into the UI shape, write back atomically.
// ---------------------------------------------------------------------------

function resolvePaths(deps: PhantomConfigApiDeps): PhantomConfigPaths {
	return {
		phantomYaml: deps.paths?.phantomYaml ?? DEFAULT_PHANTOM_YAML,
		channelsYaml: deps.paths?.channelsYaml ?? DEFAULT_CHANNELS_YAML,
		evolutionMeta: deps.paths?.evolutionMeta ?? DEFAULT_EVOLUTION_META,
	};
}

type ReadYamlResult<T> = { ok: true; value: T; raw: string } | { ok: false; error: string };

function readYamlFile(path: string): ReadYamlResult<Record<string, unknown>> {
	if (!existsSync(path)) {
		return { ok: true, value: {}, raw: "" };
	}
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, error: `Failed to read ${path}: ${msg}` };
	}
	let parsed: unknown;
	try {
		parsed = parseYaml(raw);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, error: `Invalid YAML at ${path}: ${msg}` };
	}
	if (parsed == null) return { ok: true, value: {}, raw };
	if (typeof parsed !== "object" || Array.isArray(parsed)) {
		return { ok: false, error: `${path} must be a YAML object at the top level` };
	}
	return { ok: true, value: parsed as Record<string, unknown>, raw };
}

function readJsonFile(path: string): ReadYamlResult<Record<string, unknown>> {
	if (!existsSync(path)) return { ok: true, value: {}, raw: "" };
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, error: `Failed to read ${path}: ${msg}` };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, error: `Invalid JSON at ${path}: ${msg}` };
	}
	if (parsed == null) return { ok: true, value: {}, raw };
	if (typeof parsed !== "object" || Array.isArray(parsed)) {
		return { ok: false, error: `${path} must be a JSON object at the top level` };
	}
	return { ok: true, value: parsed as Record<string, unknown>, raw };
}

type LoadedConfig = {
	phantom: Record<string, unknown>;
	channels: Record<string, unknown>;
	evolutionMeta: Record<string, unknown>;
};

function loadAllConfig(paths: PhantomConfigPaths): { ok: true; value: LoadedConfig } | { ok: false; error: string } {
	const phantom = readYamlFile(paths.phantomYaml);
	if (!phantom.ok) return phantom;
	const channels = readYamlFile(paths.channelsYaml);
	if (!channels.ok) return channels;
	const evolutionMeta = readJsonFile(paths.evolutionMeta);
	if (!evolutionMeta.ok) return evolutionMeta;
	return {
		ok: true,
		value: {
			phantom: phantom.value,
			channels: channels.value,
			evolutionMeta: evolutionMeta.value,
		},
	};
}

// Build the UI-facing shape from the three source files. Defaults are applied
// at this layer so partially-configured deployments (e.g. no channels.yaml)
// still render a complete form.
export function projectToUi(loaded: LoadedConfig): PhantomConfigForUi {
	const p = loaded.phantom as Record<string, unknown>;
	const c = loaded.channels as Record<string, unknown>;
	const evMeta = loaded.evolutionMeta as Record<string, unknown>;

	// Permissions and evolution may live under p.permissions / p.evolution if
	// the user has saved once; otherwise apply defaults from the schemas.
	const permissions = PermissionsConfigSchema.parse(p.permissions ?? {});
	const evYaml = EvolutionUiConfigSchema.parse(p.evolution ?? {});
	// Cadence overlay in phantom-config/meta/evolution.json wins over the
	// phantom.yaml mirror at runtime; the UI surface reports the overlay
	// value so the form reflects what the running cadence actually sees.
	const cadenceOverlay =
		typeof evMeta.cadence_minutes === "number"
			? evMeta.cadence_minutes
			: typeof evMeta.cadenceMinutes === "number"
				? evMeta.cadenceMinutes
				: null;
	const depthOverlay =
		typeof evMeta.demand_trigger_depth === "number"
			? evMeta.demand_trigger_depth
			: typeof evMeta.demandTriggerDepth === "number"
				? evMeta.demandTriggerDepth
				: null;
	const evolution = {
		reflection_enabled: evYaml.reflection_enabled,
		cadence_minutes: cadenceOverlay ?? evYaml.cadence_minutes,
		demand_trigger_depth: depthOverlay ?? evYaml.demand_trigger_depth,
	};

	const channels = {
		slack: { enabled: Boolean((c.slack as Record<string, unknown> | undefined)?.enabled) },
		telegram: { enabled: Boolean((c.telegram as Record<string, unknown> | undefined)?.enabled) },
		email: { enabled: Boolean((c.email as Record<string, unknown> | undefined)?.enabled) },
		webhook: { enabled: Boolean((c.webhook as Record<string, unknown> | undefined)?.enabled) },
	};

	const memoryConfig = readMemoryConfig();

	return {
		name: typeof p.name === "string" ? p.name : "phantom",
		role: typeof p.role === "string" ? p.role : "swe",
		public_url: typeof p.public_url === "string" ? p.public_url : null,
		domain: typeof p.domain === "string" ? p.domain : null,
		model: typeof p.model === "string" ? p.model : "claude-opus-4-7",
		judge_model: typeof p.judge_model === "string" ? p.judge_model : null,
		effort: (typeof p.effort === "string" ? p.effort : "max") as PhantomConfigForUi["effort"],
		max_budget_usd: typeof p.max_budget_usd === "number" ? p.max_budget_usd : 0,
		timeout_minutes: typeof p.timeout_minutes === "number" ? p.timeout_minutes : 240,
		permissions,
		evolution,
		channels,
		memory: memoryConfig,
	};
}

// Memory config reads come from config/memory.yaml + env overrides. The
// endpoint surfaces the on-disk file values; env overrides remain visible
// in the doctor tab but are not settable from Settings.
function readMemoryConfig(): PhantomConfigForUi["memory"] {
	const res = readYamlFile("config/memory.yaml");
	if (!res.ok) {
		return {
			qdrant_url: "http://localhost:6333",
			ollama_url: "http://localhost:11434",
			embedding_model: "nomic-embed-text",
			episode_limit: 10,
			fact_limit: 20,
			procedure_limit: 5,
		};
	}
	const m = res.value;
	const qdrant = (m.qdrant as Record<string, unknown> | undefined) ?? {};
	const ollama = (m.ollama as Record<string, unknown> | undefined) ?? {};
	const context = (m.context as Record<string, unknown> | undefined) ?? {};
	return {
		qdrant_url: typeof qdrant.url === "string" ? qdrant.url : "http://localhost:6333",
		ollama_url: typeof ollama.url === "string" ? ollama.url : "http://localhost:11434",
		embedding_model: typeof ollama.model === "string" ? ollama.model : "nomic-embed-text",
		episode_limit: typeof context.episode_limit === "number" ? context.episode_limit : 10,
		fact_limit: typeof context.fact_limit === "number" ? context.fact_limit : 20,
		procedure_limit: typeof context.procedure_limit === "number" ? context.procedure_limit : 5,
	};
}

// ---------------------------------------------------------------------------
// Merge + write. The merge is DEEP for known slices (permissions, evolution,
// channels, memory) so a PUT of `{ permissions: { allow: [x] } }` preserves
// permissions.deny and permissions.default_mode. Top-level scalars replace.
// ---------------------------------------------------------------------------

type AppliedChange = {
	section: SectionKey;
	field: string;
	previous: unknown;
	next: unknown;
};

export type SectionKey = "identity" | "model_cost" | "evolution" | "channels" | "memory" | "permissions";

function sectionForField(field: string): SectionKey {
	if (field.startsWith("permissions")) return "permissions";
	if (field.startsWith("evolution")) return "evolution";
	if (field.startsWith("channels")) return "channels";
	if (field.startsWith("memory")) return "memory";
	if (field === "model" || field === "judge_model" || field === "effort" || field === "max_budget_usd" || field === "timeout_minutes") {
		return "model_cost";
	}
	return "identity";
}

// Structural deep equal: arrays atomic, plain objects recurse. Mirrors the
// settings-editor storage.ts helper so dirty detection semantics match.
function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a == null || b == null) return a === b;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b)) return false;
		if (a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
		return true;
	}
	if (typeof a === "object" && typeof b === "object") {
		const ak = Object.keys(a as object);
		const bk = Object.keys(b as object);
		if (ak.length !== bk.length) return false;
		for (const k of ak) {
			if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
			if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
		}
		return true;
	}
	return false;
}

function applyPatch(current: PhantomConfigForUi, patch: PhantomConfigPut): { merged: PhantomConfigForUi; changes: AppliedChange[] } {
	const merged: PhantomConfigForUi = {
		...current,
		permissions: { ...current.permissions },
		evolution: { ...current.evolution },
		channels: {
			slack: { ...current.channels.slack },
			telegram: { ...current.channels.telegram },
			email: { ...current.channels.email },
			webhook: { ...current.channels.webhook },
		},
		memory: { ...current.memory },
	};
	const changes: AppliedChange[] = [];

	const topScalars = ["name", "role", "public_url", "domain", "model", "judge_model", "effort", "max_budget_usd", "timeout_minutes"] as const;
	for (const k of topScalars) {
		if (patch[k] !== undefined) {
			const next = patch[k];
			if (!deepEqual(current[k], next)) {
				changes.push({ section: sectionForField(k), field: k, previous: current[k], next });
				(merged as Record<string, unknown>)[k] = next;
			}
		}
	}

	if (patch.permissions) {
		for (const key of Object.keys(patch.permissions) as Array<keyof typeof patch.permissions>) {
			const val = patch.permissions[key];
			if (val !== undefined) {
				const prev = current.permissions[key];
				if (!deepEqual(prev, val)) {
					changes.push({ section: "permissions", field: `permissions.${key}`, previous: prev, next: val });
					(merged.permissions as Record<string, unknown>)[key] = val;
				}
			}
		}
	}

	if (patch.evolution) {
		for (const key of Object.keys(patch.evolution) as Array<keyof typeof patch.evolution>) {
			const val = patch.evolution[key];
			if (val !== undefined) {
				const prev = current.evolution[key];
				if (!deepEqual(prev, val)) {
					changes.push({ section: "evolution", field: `evolution.${key}`, previous: prev, next: val });
					(merged.evolution as Record<string, unknown>)[key] = val;
				}
			}
		}
	}

	if (patch.channels) {
		for (const ch of ["slack", "telegram", "email", "webhook"] as const) {
			const entry = patch.channels[ch];
			if (entry?.enabled !== undefined) {
				const prev = current.channels[ch].enabled;
				if (prev !== entry.enabled) {
					changes.push({
						section: "channels",
						field: `channels.${ch}.enabled`,
						previous: prev,
						next: entry.enabled,
					});
					merged.channels[ch] = { enabled: entry.enabled };
				}
			}
		}
	}

	if (patch.memory) {
		for (const key of Object.keys(patch.memory) as Array<keyof typeof patch.memory>) {
			const val = patch.memory[key];
			if (val !== undefined) {
				const prev = current.memory[key];
				if (!deepEqual(prev, val)) {
					changes.push({ section: "memory", field: `memory.${key}`, previous: prev, next: val });
					(merged.memory as Record<string, unknown>)[key] = val;
				}
			}
		}
	}

	return { merged, changes };
}

// Project the merged UI shape back into the on-disk file layouts. phantom.yaml
// gets identity + model + cost + permissions + evolution. channels.yaml gets
// channel enable flags (writing back the existing secret placeholders
// untouched). memory.yaml gets the memory block. phantom-config/meta/
// evolution.json gets the cadence overlay.
type WritePlan = {
	phantom: Record<string, unknown>;
	channels: Record<string, unknown>;
	memory: Record<string, unknown>;
	evolutionMeta: Record<string, unknown>;
};

function planWrites(
	previous: LoadedConfig,
	merged: PhantomConfigForUi,
	memoryBefore: Record<string, unknown>,
): WritePlan {
	const phantom: Record<string, unknown> = { ...previous.phantom };
	phantom.name = merged.name;
	phantom.role = merged.role;
	if (merged.public_url) phantom.public_url = merged.public_url;
	else delete phantom.public_url;
	if (merged.domain) phantom.domain = merged.domain;
	else delete phantom.domain;
	phantom.model = merged.model;
	if (merged.judge_model) phantom.judge_model = merged.judge_model;
	else delete phantom.judge_model;
	phantom.effort = merged.effort;
	phantom.max_budget_usd = merged.max_budget_usd;
	phantom.timeout_minutes = merged.timeout_minutes;
	phantom.permissions = merged.permissions;
	phantom.evolution = {
		reflection_enabled: merged.evolution.reflection_enabled,
		cadence_minutes: merged.evolution.cadence_minutes,
		demand_trigger_depth: merged.evolution.demand_trigger_depth,
	};

	// channels.yaml preserves every existing field (secrets, owner_user_id,
	// default_channel_id), and overwrites only `enabled` per channel.
	const channels: Record<string, unknown> = { ...previous.channels };
	for (const ch of ["slack", "telegram", "email", "webhook"] as const) {
		const existing = (channels[ch] as Record<string, unknown> | undefined) ?? {};
		channels[ch] = { ...existing, enabled: merged.channels[ch].enabled };
	}

	// memory.yaml: preserve existing collections + embedding blocks, overwrite
	// the fields the UI owns.
	const memory: Record<string, unknown> = { ...memoryBefore };
	memory.qdrant = { ...((memory.qdrant as Record<string, unknown> | undefined) ?? {}), url: merged.memory.qdrant_url };
	memory.ollama = {
		...((memory.ollama as Record<string, unknown> | undefined) ?? {}),
		url: merged.memory.ollama_url,
		model: merged.memory.embedding_model,
	};
	memory.context = {
		...((memory.context as Record<string, unknown> | undefined) ?? {}),
		episode_limit: merged.memory.episode_limit,
		fact_limit: merged.memory.fact_limit,
		procedure_limit: merged.memory.procedure_limit,
	};

	const evolutionMeta: Record<string, unknown> = { ...previous.evolutionMeta };
	evolutionMeta.cadence_minutes = merged.evolution.cadence_minutes;
	evolutionMeta.demand_trigger_depth = merged.evolution.demand_trigger_depth;

	return { phantom, channels, memory, evolutionMeta };
}

// ---------------------------------------------------------------------------
// Audit log.
// ---------------------------------------------------------------------------

function recordAuditRows(db: Database, changes: AppliedChange[], actor: string): void {
	for (const change of changes) {
		db.run(
			`INSERT INTO settings_audit_log (field, previous_value, new_value, actor, section)
			 VALUES (?, ?, ?, ?, ?)`,
			[
				change.field,
				change.previous === undefined ? null : JSON.stringify(change.previous),
				change.next === undefined ? null : JSON.stringify(change.next),
				actor,
				change.section,
			],
		);
	}
}

function listAudit(db: Database, limit: number): PhantomConfigAuditEntry[] {
	return db
		.query(
			`SELECT id, section, field, previous_value, new_value, actor, created_at
			 FROM settings_audit_log
			 ORDER BY id DESC
			 LIMIT ?`,
		)
		.all(limit) as PhantomConfigAuditEntry[];
}

function lastModified(db: Database): { last_modified_at: string | null; last_modified_by: string | null } {
	const row = db.query(
		`SELECT created_at, actor FROM settings_audit_log ORDER BY id DESC LIMIT 1`,
	).get() as { created_at: string; actor: string } | null;
	if (!row) return { last_modified_at: null, last_modified_by: null };
	return { last_modified_at: row.created_at, last_modified_by: row.actor };
}

// ---------------------------------------------------------------------------
// Handler.
// ---------------------------------------------------------------------------

export async function handlePhantomConfigApi(
	req: Request,
	url: URL,
	deps: PhantomConfigApiDeps,
): Promise<Response | null> {
	const path = url.pathname;
	const paths = resolvePaths(deps);

	if (path === "/ui/api/phantom-config" && req.method === "GET") {
		return handleGet(deps, paths);
	}
	if (path === "/ui/api/phantom-config" && req.method === "PUT") {
		return handlePut(req, deps, paths);
	}
	if (path === "/ui/api/phantom-config/audit" && req.method === "GET") {
		return handleAuditGet(url, deps);
	}
	// Methods other than GET/PUT on /phantom-config, or non-GET on /audit.
	if (path === "/ui/api/phantom-config" || path === "/ui/api/phantom-config/audit") {
		return errJson("Method not allowed", 405);
	}
	return null;
}

function handleGet(deps: PhantomConfigApiDeps, paths: PhantomConfigPaths): Response {
	const loaded = loadAllConfig(paths);
	if (!loaded.ok) return errJson(loaded.error, 500);
	const ui = projectToUi(loaded.value);
	return json({ config: ui, audit: lastModified(deps.db) });
}

async function handlePut(req: Request, deps: PhantomConfigApiDeps, paths: PhantomConfigPaths): Promise<Response> {
	const parsed = await parseJsonBody(req, PhantomConfigPutSchema);
	if (!parsed.ok) {
		return errJson(parsed.error, parsed.status, parsed.field ? { field: parsed.field } : undefined);
	}

	const loaded = loadAllConfig(paths);
	if (!loaded.ok) return errJson(loaded.error, 500);
	const current = projectToUi(loaded.value);

	const { merged, changes } = applyPatch(current, parsed.value);

	// Validate the merged object against the full UI schema so invalid cross-field
	// combinations are caught (e.g. empty string name after a patch) before we
	// touch disk. This is the second line of defense behind the per-field Zod
	// validation already run on the patch itself.
	const fullCheck = PhantomConfigForUiSchema.safeParse(merged);
	if (!fullCheck.success) {
		const { path: errPath, message } = zodErrorMessage(fullCheck.error);
		return errJson(`${errPath}: ${message}`, 400, { field: errPath });
	}

	if (changes.length === 0) {
		return json({ config: current, dirty_keys: [] });
	}

	// Read the memory.yaml once more so the atomic write preserves every
	// field we do not own (collections, embedding dims, context.max_tokens).
	const memRes = readYamlFile("config/memory.yaml");
	if (!memRes.ok) return errJson(memRes.error, 500);
	const plan = planWrites(loaded.value, merged, memRes.value);

	// Write order: phantom.yaml first (identity, cost, permissions, evolution
	// mirror). If that succeeds, channels, memory, evolution overlay.
	// Each write is individually atomic; if the second one fails we STOP so
	// the DB audit row count matches what actually made it to disk.
	const phantomYamlText = stringifyYaml(plan.phantom, { lineWidth: 120 });
	const phantomRes = writeAtomic(paths.phantomYaml, phantomYamlText, deps.renameImpl);
	if (!phantomRes.ok) return errJson(phantomRes.error, 500);

	const channelsChanged = changes.some((c) => c.section === "channels");
	if (channelsChanged) {
		const channelsText = stringifyYaml(plan.channels, { lineWidth: 120 });
		const res = writeAtomic(paths.channelsYaml, channelsText, deps.renameImpl);
		if (!res.ok) return errJson(res.error, 500);
	}

	const memoryChanged = changes.some((c) => c.section === "memory");
	if (memoryChanged) {
		const memText = stringifyYaml(plan.memory, { lineWidth: 120 });
		const res = writeAtomic("config/memory.yaml", memText, deps.renameImpl);
		if (!res.ok) return errJson(res.error, 500);
	}

	const evolutionChanged = changes.some((c) => c.section === "evolution");
	if (evolutionChanged) {
		const evText = `${JSON.stringify(plan.evolutionMeta, null, 2)}\n`;
		const res = writeAtomic(paths.evolutionMeta, evText, deps.renameImpl);
		if (!res.ok) return errJson(res.error, 500);
	}

	recordAuditRows(deps.db, changes, "user");

	// Re-project from disk so the returned config reflects whatever coercion
	// Zod applied (trimming, defaults).
	const reloaded = loadAllConfig(paths);
	if (!reloaded.ok) return errJson(reloaded.error, 500);
	const after = projectToUi(reloaded.value);

	return json({
		config: after,
		dirty_keys: changes.map((c) => c.field),
	});
}

function handleAuditGet(url: URL, deps: PhantomConfigApiDeps): Response {
	const raw = url.searchParams.get("limit");
	const asNum = raw === null ? AUDIT_LIMIT_DEFAULT : Number(raw);
	if (!Number.isFinite(asNum) || asNum <= 0) {
		return errJson("limit must be a positive integer", 400);
	}
	const limit = Math.min(Math.floor(asNum), AUDIT_LIMIT_MAX);
	return json({ entries: listAudit(deps.db, limit) });
}
