import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { EvolutionConfig } from "./config.ts";
import type { EvolutionVersion, MetricsSnapshot, SubprocessSentinel, VersionChange } from "./types.ts";

/**
 * Read the current version from phantom-config/meta/version.json.
 */
export function readVersion(config: EvolutionConfig): EvolutionVersion {
	const path = config.paths.version_file;

	try {
		const text = readFileSync(path, "utf-8");
		return JSON.parse(text) as EvolutionVersion;
	} catch {
		return {
			version: 0,
			parent: null,
			timestamp: new Date().toISOString(),
			changes: [],
			metrics_at_change: { session_count: 0, success_rate_7d: 0, correction_rate_7d: 0 },
		};
	}
}

/**
 * Write a new version to phantom-config/meta/version.json.
 */
export function writeVersion(config: EvolutionConfig, version: EvolutionVersion): void {
	const path = config.paths.version_file;
	const dir = dirname(path);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(path, `${JSON.stringify(version, null, 2)}\n`, "utf-8");
}

/**
 * Create the next version from the current one.
 */
export function createNextVersion(
	current: EvolutionVersion,
	changes: VersionChange[],
	metricsSnapshot: MetricsSnapshot,
): EvolutionVersion {
	return {
		version: current.version + 1,
		parent: current.version,
		timestamp: new Date().toISOString(),
		changes,
		metrics_at_change: metricsSnapshot,
	};
}

/**
 * Get version history by walking the evolution-log.jsonl.
 */
export function getHistory(config: EvolutionConfig, limit = 50): EvolutionVersion[] {
	const historyPath = config.paths.evolution_log;
	const history: EvolutionVersion[] = [];

	try {
		const text = readFileSync(historyPath, "utf-8").trim();
		if (!text) return [readVersion(config)];

		const lines = text.split("\n").filter(Boolean);
		for (const line of lines.slice(-limit)) {
			try {
				const entry = JSON.parse(line) as Partial<EvolutionVersion> & { version?: number };
				if (typeof entry.version === "number") {
					history.push(entry as EvolutionVersion);
				}
			} catch {
				// Skip malformed lines
			}
		}
	} catch {
		// No history file, return current version only
	}

	if (history.length === 0) {
		history.push(readVersion(config));
	}

	return history;
}

/**
 * Phase 3 directory snapshot.
 *
 * A snapshot is a Map from file path (relative to the config root) to its
 * exact byte contents. `snapshotDirectory` walks the phantom-config tree
 * excluding the `meta/` and `.staging/` subtrees; `restoreSnapshot` writes
 * the map back, recreating the directory layout and deleting any file that
 * was not present in the snapshot but exists now.
 *
 * The snapshot doubles as the pre-state for the invariant check (file
 * scope, constitution byte-compare, size bounds, near-duplicate detection).
 */
export type DirectorySnapshot = {
	version: EvolutionVersion;
	files: Map<string, string>;
};

const SNAPSHOT_EXCLUDED_DIRS = new Set(["meta", ".staging"]);

function walkConfigDir(root: string, current: string, out: string[]): void {
	let entries: import("node:fs").Dirent[];
	try {
		entries = readdirSync(current, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const absolute = join(current, entry.name);
		const rel = relative(root, absolute);
		if (entry.isDirectory()) {
			// Only exclude top-level `meta/` and `.staging/`. Nested directories
			// under writeable roots (e.g. `strategies/`, `memory/`) are in scope.
			if (rel === "meta" || rel === ".staging") continue;
			if (SNAPSHOT_EXCLUDED_DIRS.has(entry.name) && dirname(rel) === ".") continue;
			walkConfigDir(root, absolute, out);
		} else if (entry.isFile()) {
			out.push(rel);
		}
	}
}

/**
 * Capture the current state of phantom-config as an in-memory snapshot.
 * Excludes meta/ (engine telemetry) and .staging/ (subprocess scratch).
 */
export function snapshotDirectory(config: EvolutionConfig): DirectorySnapshot {
	const root = config.paths.config_dir;
	const files = new Map<string, string>();

	if (existsSync(root)) {
		const list: string[] = [];
		walkConfigDir(root, root, list);
		for (const rel of list) {
			try {
				const content = readFileSync(join(root, rel), "utf-8");
				files.set(rel, content);
			} catch {
				// Skip unreadable files: they will be treated as absent and
				// the invariant check will flag any post-run appearance as
				// a new write.
			}
		}
	}

	return {
		version: readVersion(config),
		files,
	};
}

/**
 * Restore the filesystem to the exact state captured in `snapshot`. Any
 * file present in the current state but missing from the snapshot is
 * deleted. Files whose content matches the snapshot are not rewritten so
 * the restore is a minimal-diff operation.
 */
export function restoreSnapshot(config: EvolutionConfig, snapshot: DirectorySnapshot): void {
	const root = config.paths.config_dir;

	// Walk the current state to find files that need to be deleted (present
	// now, absent in snapshot) before rewriting the survivors.
	const currentFiles: string[] = [];
	if (existsSync(root)) {
		walkConfigDir(root, root, currentFiles);
	}

	for (const rel of currentFiles) {
		if (!snapshot.files.has(rel)) {
			try {
				unlinkSync(join(root, rel));
			} catch {
				// Best effort: missing file is fine, permission errors should
				// not wedge the rollback path.
			}
		}
	}

	for (const [rel, content] of snapshot.files) {
		const abs = join(root, rel);
		let same = false;
		try {
			same = readFileSync(abs, "utf-8") === content;
		} catch {
			same = false;
		}
		if (same) continue;
		const dir = dirname(abs);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(abs, content, "utf-8");
	}

	// Restore version.json so the recorded current version matches the
	// pre-snapshot state. This lives under meta/ which is excluded from the
	// walk, so it needs an explicit write.
	writeVersion(config, snapshot.version);
}

/**
 * Produce a VersionChange[] describing the diff between a pre-snapshot and
 * the current post-subprocess state. Used by the reflection subprocess to
 * build the changelog entry that lands on disk and in the evolution log.
 *
 * Each changed file becomes one VersionChange whose `type` reflects the
 * subprocess's declared intent (edit, compact, new, delete). When the
 * subprocess sentinel annotates a file, the annotation wins. Otherwise the
 * diff drives the decision: a file absent pre and present post is "new", a
 * shrinkage larger than 30% with no annotation is "compact", everything
 * else is "edit".
 */
export function buildVersionChanges(
	pre: DirectorySnapshot,
	post: DirectorySnapshot,
	sentinel: SubprocessSentinel | null,
	sessionIds: string[],
	rationale: string,
): VersionChange[] {
	const changes: VersionChange[] = [];
	const annotated = new Map<string, { action?: "edit" | "compact" | "new"; summary?: string }>();
	if (sentinel?.changes) {
		for (const c of sentinel.changes) {
			annotated.set(c.file, { action: c.action, summary: c.summary });
		}
	}

	const preKeys = new Set(pre.files.keys());
	const postKeys = new Set(post.files.keys());
	const touched = new Set<string>();
	for (const k of preKeys) {
		if (!postKeys.has(k)) touched.add(k);
		else if (pre.files.get(k) !== post.files.get(k)) touched.add(k);
	}
	for (const k of postKeys) {
		if (!preKeys.has(k)) touched.add(k);
	}

	for (const rel of touched) {
		const preContent = pre.files.get(rel) ?? null;
		const postContent = post.files.get(rel) ?? null;
		const annotation = annotated.get(rel);

		let type: VersionChange["type"];
		if (postContent === null) {
			type = "delete";
		} else if (preContent === null) {
			type = "new";
		} else if (annotation?.action === "compact") {
			type = "compact";
		} else if (annotation?.action === "new") {
			// Subprocess asked for "new" but the file already existed pre.
			// Treat as edit rather than trusting the annotation blindly.
			type = "edit";
		} else {
			const preLines = preContent.split("\n").length;
			const postLines = postContent.split("\n").length;
			if (preLines > 0 && postLines < preLines * 0.7) {
				type = "compact";
			} else {
				type = annotation?.action ?? "edit";
			}
		}

		changes.push({
			file: rel,
			type,
			summary: annotation?.summary ?? describeDiff(preContent, postContent),
			rationale,
			session_ids: sessionIds,
		});
	}

	return changes;
}

function describeDiff(pre: string | null, post: string | null): string {
	if (pre === null && post !== null) return `new file, ${post.split("\n").length} lines`;
	if (post === null) return "file removed";
	const preLines = pre === null ? 0 : pre.split("\n").length;
	const postLines = post.split("\n").length;
	if (postLines === preLines) return `${postLines} lines, content edited`;
	const delta = postLines - preLines;
	const sign = delta > 0 ? "+" : "";
	return `${preLines} -> ${postLines} lines (${sign}${delta})`;
}
