import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import type { EvolutionConfig } from "./config.ts";
import { JUDGE_MODEL_SONNET } from "./judge-models.ts";

// A2a: contrast judge flags, read from `phantom-config/meta/evolution.json`.
//
// The same file also carries the cadence knobs, but `loadCadenceConfig` is
// hand-rolled and cadence-only by design; this loader is Zod-validated and
// owns only the contrast keys. Zod's default object mode strips unknown
// keys, so the two loaders never fight over the same file.
//
// `meta/` is denied to the reflection subprocess sandbox, which keeps judge
// settings out of the reflector's view. That is intentional: the agent being
// judged must not read its own judge's configuration.

export type ContrastJudgeMode = "off" | "shadow" | "enforce";

export type ContrastJudgeConfig = {
	mode: ContrastJudgeMode;
	model: string;
};

export const DEFAULT_CONTRAST_JUDGE_CONFIG: ContrastJudgeConfig = {
	mode: "off",
	model: JUDGE_MODEL_SONNET,
};

const ContrastJudgeFileSchema = z.object({
	contrast_judge: z.enum(["off", "shadow", "enforce"]).optional(),
	contrast_judge_model: z.string().min(1).optional(),
});

/** Load the contrast judge flags. Defaults (mode off) apply whenever the file is absent, unreadable, or invalid. */
export function loadContrastJudgeConfig(config: EvolutionConfig): ContrastJudgeConfig {
	const path = metaEvolutionJsonPath(config);
	if (!existsSync(path)) return DEFAULT_CONTRAST_JUDGE_CONFIG;

	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf-8"));
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn(`[evolution] Unreadable contrast judge config at ${path}, using defaults: ${msg}`);
		return DEFAULT_CONTRAST_JUDGE_CONFIG;
	}

	const result = ContrastJudgeFileSchema.safeParse(raw);
	if (!result.success) {
		const issues = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
		console.warn(`[evolution] Invalid contrast judge config at ${path}, using defaults:\n${issues}`);
		return DEFAULT_CONTRAST_JUDGE_CONFIG;
	}

	return {
		mode: result.data.contrast_judge ?? DEFAULT_CONTRAST_JUDGE_CONFIG.mode,
		model: result.data.contrast_judge_model ?? DEFAULT_CONTRAST_JUDGE_CONFIG.model,
	};
}

function metaEvolutionJsonPath(config: EvolutionConfig): string {
	// Same derivation as cadence.ts: the meta directory is the parent of
	// metrics_file, so no second path string is needed in the schema.
	const metricsPath = config.paths.metrics_file;
	const idx = metricsPath.lastIndexOf("/");
	const metaDir = idx === -1 ? "." : metricsPath.slice(0, idx);
	return `${metaDir}/evolution.json`;
}
