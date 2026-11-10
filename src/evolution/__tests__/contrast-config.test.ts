import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { EvolutionConfig } from "../config.ts";
import { DEFAULT_CONTRAST_JUDGE_CONFIG, loadContrastJudgeConfig } from "../contrast-config.ts";

const TEST_DIR = "/tmp/phantom-test-contrast-config";

function setupConfig(): EvolutionConfig {
	rmSync(TEST_DIR, { recursive: true, force: true });
	mkdirSync(`${TEST_DIR}/meta`, { recursive: true });
	return {
		reflection: { enabled: "never" },
		paths: {
			config_dir: TEST_DIR,
			constitution: `${TEST_DIR}/constitution.md`,
			version_file: `${TEST_DIR}/meta/version.json`,
			metrics_file: `${TEST_DIR}/meta/metrics.json`,
			evolution_log: `${TEST_DIR}/meta/evolution-log.jsonl`,
			session_log: `${TEST_DIR}/memory/session-log.jsonl`,
		},
	};
}

describe("loadContrastJudgeConfig", () => {
	let config: EvolutionConfig;

	beforeEach(() => {
		config = setupConfig();
	});

	afterEach(() => {
		rmSync(TEST_DIR, { recursive: true, force: true });
	});

	test("defaults to off + sonnet when the file is absent", () => {
		const cfg = loadContrastJudgeConfig(config);
		expect(cfg.mode).toBe("off");
		expect(cfg.model).toBe(DEFAULT_CONTRAST_JUDGE_CONFIG.model);
		expect(cfg.model).toBe("claude-sonnet-4-6");
	});

	test("parses mode and model overrides", () => {
		writeFileSync(
			`${TEST_DIR}/meta/evolution.json`,
			JSON.stringify({ contrast_judge: "shadow", contrast_judge_model: "claude-opus-4-7" }),
			"utf-8",
		);
		const cfg = loadContrastJudgeConfig(config);
		expect(cfg.mode).toBe("shadow");
		expect(cfg.model).toBe("claude-opus-4-7");
	});

	test("cadence keys coexist without breaking the contrast loader", () => {
		writeFileSync(
			`${TEST_DIR}/meta/evolution.json`,
			JSON.stringify({ cadence_minutes: 120, demand_trigger_depth: 3, contrast_judge: "enforce" }),
			"utf-8",
		);
		const cfg = loadContrastJudgeConfig(config);
		expect(cfg.mode).toBe("enforce");
		expect(cfg.model).toBe("claude-sonnet-4-6");
	});

	test("invalid mode value falls back to defaults", () => {
		writeFileSync(`${TEST_DIR}/meta/evolution.json`, JSON.stringify({ contrast_judge: "yes" }), "utf-8");
		const cfg = loadContrastJudgeConfig(config);
		expect(cfg.mode).toBe("off");
	});

	test("unreadable JSON falls back to defaults", () => {
		writeFileSync(`${TEST_DIR}/meta/evolution.json`, "{not json", "utf-8");
		const cfg = loadContrastJudgeConfig(config);
		expect(cfg.mode).toBe("off");
	});

	test("empty object gets defaults", () => {
		writeFileSync(`${TEST_DIR}/meta/evolution.json`, "{}", "utf-8");
		const cfg = loadContrastJudgeConfig(config);
		expect(cfg.mode).toBe("off");
	});
});
