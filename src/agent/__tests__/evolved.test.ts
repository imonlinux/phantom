import { describe, expect, test } from "bun:test";
import type { EvolvedConfig } from "../../evolution/types.ts";
import { buildEvolvedSections } from "../prompt-blocks/evolved.ts";

// Renderer tests for the evolved prompt block. Sections render only when
// they carry more than one content line, corrections and principles load
// from memory/, and strategies is a glob record keyed by file stem.

function baseConfig(overrides: Partial<EvolvedConfig> = {}): EvolvedConfig {
	return {
		constitution: "1. Honesty.",
		persona: "# Persona\n\n- Be direct.\n",
		userProfile: "# User Profile\n",
		domainKnowledge: "# Domain Knowledge\n",
		memory: { corrections: "", principles: "" },
		strategies: {},
		meta: { version: 0, metricsSnapshot: { session_count: 0, success_rate_7d: 0 } },
		...overrides,
	};
}

describe("buildEvolvedSections", () => {
	test("returns empty string when nothing has content", () => {
		const out = buildEvolvedSections(
			baseConfig({
				constitution: "",
				persona: "",
				userProfile: "",
				domainKnowledge: "",
				memory: { corrections: "", principles: "" },
				strategies: {},
			}),
		);
		expect(out).toBe("");
	});

	test("renders corrections and principles as their own sections", () => {
		const out = buildEvolvedSections(
			baseConfig({
				memory: {
					corrections: "# Corrections\n\n- Prefer bun over node.\n- Pin test deps.\n",
					principles: "# Principles\n\n- Measure before cutting.\n- Show the diff.\n",
				},
			}),
		);
		expect(out).toContain("# Corrections");
		expect(out).toContain("Prefer bun over node.");
		expect(out).toContain("# Principles");
		expect(out).toContain("Measure before cutting.");
	});

	test("skips corrections or principles that only carry a header", () => {
		const out = buildEvolvedSections(
			baseConfig({
				memory: { corrections: "# Corrections\n", principles: "# Principles\n" },
			}),
		);
		expect(out).not.toContain("# Corrections");
		expect(out).not.toContain("# Principles");
	});

	test("renders every strategy record entry under Learned Strategies", () => {
		const out = buildEvolvedSections(
			baseConfig({
				strategies: {
					"task-patterns": "# Task Patterns\n\n- Commit in parts.\n- Test first.\n",
					"tool-preferences": "# Tool Preferences\n\n- Grep before writing.\n- Read before editing.\n",
				},
			}),
		);
		expect(out).toContain("# Learned Strategies");
		expect(out).toContain("Commit in parts.");
		expect(out).toContain("Grep before writing.");
	});

	test("drops header-only strategy entries instead of emitting an empty section", () => {
		const out = buildEvolvedSections(
			baseConfig({
				strategies: { "task-patterns": "# Task Patterns\n" },
			}),
		);
		expect(out).not.toContain("# Learned Strategies");
	});
});
