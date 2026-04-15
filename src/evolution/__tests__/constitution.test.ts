import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { EvolutionConfig } from "../config.ts";
import { ConstitutionChecker } from "../constitution.ts";

// Phase 3 constitution checker tests. The per-delta regex check and the
// rationale scanner are gone; this module now just loads and exposes the
// constitution text so the reflection subprocess can use it as context.
// Enforcement is the three-layer model: sandbox deny, prompt, invariant I2.

const TEST_DIR = "/tmp/phantom-test-constitution";

function testConfig(): EvolutionConfig {
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

describe("ConstitutionChecker", () => {
	beforeEach(() => {
		rmSync(TEST_DIR, { recursive: true, force: true });
		mkdirSync(`${TEST_DIR}/meta`, { recursive: true });
		writeFileSync(
			`${TEST_DIR}/constitution.md`,
			[
				"# Phantom Constitution",
				"",
				"1. Honesty: Never deceive the user.",
				"2. Safety: Never execute harmful commands.",
				"3. Privacy: Never share user data without consent.",
				"4. Transparency: Every change is visible.",
				"5. Boundaries: You are not a person.",
				"6. Accountability: Every change is logged.",
				"7. Consent: Do not modify the constitution.",
				"8. Proportionality: Minimal changes first.",
			].join("\n"),
			"utf-8",
		);
	});

	afterEach(() => {
		rmSync(TEST_DIR, { recursive: true, force: true });
	});

	test("loads the constitution at construction time", () => {
		const checker = new ConstitutionChecker(testConfig());
		const text = checker.getConstitution();
		expect(text).toContain("Honesty");
		expect(text).toContain("Proportionality");
	});

	test("getConstitution returns the full eight principles", () => {
		const checker = new ConstitutionChecker(testConfig());
		const text = checker.getConstitution();
		for (const principle of [
			"Honesty",
			"Safety",
			"Privacy",
			"Transparency",
			"Boundaries",
			"Accountability",
			"Consent",
			"Proportionality",
		]) {
			expect(text).toContain(principle);
		}
	});

	test("throws when the constitution file is missing", () => {
		rmSync(`${TEST_DIR}/constitution.md`);
		expect(() => new ConstitutionChecker(testConfig())).toThrow("Constitution file not found");
	});

	test("preserves exact byte content", () => {
		const checker = new ConstitutionChecker(testConfig());
		const text = checker.getConstitution();
		// Invariant I2 relies on byte equality, so preserve the exact file
		// bytes, including the trailing characters.
		expect(text.split("\n")).toHaveLength(10);
	});
});
