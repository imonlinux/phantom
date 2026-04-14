// Audit log for hook installs, updates, uninstalls via the UI API. Each row
// captures the full previous and new hooks slice as JSON so a human can diff
// and recover. Agent-originated edits via the Write tool bypass this path.

import type { Database } from "bun:sqlite";
import type { HookDefinition, HookEvent, HooksSlice } from "./schema.ts";

export type HookAuditAction = "install" | "update" | "uninstall" | "trust_accepted";

export type HookAuditEntry = {
	id: number;
	event: string;
	matcher: string | null;
	hook_type: string | null;
	action: HookAuditAction;
	previous_slice: string | null;
	new_slice: string | null;
	definition_json: string | null;
	actor: string;
	created_at: string;
};

export function recordHookEdit(
	db: Database,
	params: {
		event: HookEvent | "<trust>";
		matcher: string | undefined;
		hookType: HookDefinition["type"] | null;
		action: HookAuditAction;
		previousSlice: HooksSlice | null;
		newSlice: HooksSlice | null;
		definition: HookDefinition | null;
		actor: string;
	},
): void {
	db.run(
		`INSERT INTO hook_audit_log (event, matcher, hook_type, action, previous_slice, new_slice, definition_json, actor)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			params.event,
			params.matcher ?? null,
			params.hookType,
			params.action,
			params.previousSlice ? JSON.stringify(params.previousSlice) : null,
			params.newSlice ? JSON.stringify(params.newSlice) : null,
			params.definition ? JSON.stringify(params.definition) : null,
			params.actor,
		],
	);
}

export function listHookAudit(db: Database, limit = 50): HookAuditEntry[] {
	return db
		.query(
			`SELECT id, event, matcher, hook_type, action, previous_slice, new_slice, definition_json, actor, created_at
			 FROM hook_audit_log
			 ORDER BY id DESC
			 LIMIT ?`,
		)
		.all(limit) as HookAuditEntry[];
}

export function hasAcceptedHookTrust(db: Database): boolean {
	const row = db.query("SELECT COUNT(*) as count FROM hook_audit_log WHERE action = 'trust_accepted'").get() as {
		count: number;
	} | null;
	return (row?.count ?? 0) > 0;
}
