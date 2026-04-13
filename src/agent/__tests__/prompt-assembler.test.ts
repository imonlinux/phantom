import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PhantomConfig } from "../../config/types.ts";
import { assemblePrompt } from "../prompt-assembler.ts";

const baseConfig: PhantomConfig = {
	name: "test-phantom",
	port: 3100,
	role: "swe",
	model: "claude-opus-4-6",
	provider: { type: "anthropic" },
	effort: "max",
	max_budget_usd: 0,
	timeout_minutes: 240,
};

describe("assemblePrompt Docker awareness", () => {
	const origDockerEnv = process.env.PHANTOM_DOCKER;

	beforeEach(() => {
		process.env.PHANTOM_DOCKER = undefined;
	});

	afterEach(() => {
		process.env.PHANTOM_DOCKER = origDockerEnv;
	});

	test("bare metal mode uses VM language", () => {
		const prompt = assemblePrompt(baseConfig);
		expect(prompt).toContain("dedicated virtual machine");
		expect(prompt).toContain("Hostname: test-phantom");
		expect(prompt).not.toContain("Docker container");
		expect(prompt).not.toContain("Docker-specific notes");
	});

	test("Docker mode uses container language when PHANTOM_DOCKER=true", () => {
		process.env.PHANTOM_DOCKER = "true";
		const prompt = assemblePrompt(baseConfig);
		expect(prompt).toContain("Docker container");
		expect(prompt).toContain("Container: phantom");
		expect(prompt).not.toContain("dedicated virtual machine");
	});

	test("Docker mode includes Docker-specific notes", () => {
		process.env.PHANTOM_DOCKER = "true";
		const prompt = assemblePrompt(baseConfig);
		expect(prompt).toContain("Docker-specific notes:");
		expect(prompt).toContain("sibling");
		expect(prompt).toContain("ClickHouse, Postgres, Redis");
		expect(prompt).toContain("Docker volumes");
		expect(prompt).toContain("http://qdrant:6333");
		expect(prompt).toContain("http://ollama:11434");
	});

	test("Docker mode warns agent not to modify compose/Dockerfile", () => {
		process.env.PHANTOM_DOCKER = "true";
		const prompt = assemblePrompt(baseConfig);
		expect(prompt).toContain("Do NOT modify docker-compose.yaml or Dockerfile");
	});

	test("non-Docker prompt still contains core capabilities", () => {
		const prompt = assemblePrompt(baseConfig);
		expect(prompt).toContain("Full Bash access");
		expect(prompt).toContain("Docker");
		expect(prompt).toContain("phantom_register_tool");
	});

	test("Docker prompt still contains core capabilities", () => {
		process.env.PHANTOM_DOCKER = "true";
		const prompt = assemblePrompt(baseConfig);
		expect(prompt).toContain("Full Bash access");
		expect(prompt).toContain("phantom_register_tool");
		expect(prompt).toContain("Security Boundaries");
	});
});

describe("assemblePrompt UI vocabulary guidance", () => {
	test("includes phantom-* vocabulary references", () => {
		const prompt = assemblePrompt(baseConfig);
		expect(prompt).toContain("phantom-card");
		expect(prompt).toContain("phantom-stat");
		expect(prompt).toContain("phantom-table");
		expect(prompt).toContain("phantom-chat-bubble-user");
	});

	test("includes Instrument Serif font reference", () => {
		const prompt = assemblePrompt(baseConfig);
		expect(prompt).toContain("Instrument Serif");
	});

	test("includes the chart helper reference", () => {
		const prompt = assemblePrompt(baseConfig);
		expect(prompt).toContain("window.phantomChart");
	});

	test("includes the self-validate phantom_preview_page guidance", () => {
		const prompt = assemblePrompt(baseConfig);
		expect(prompt).toContain("phantom_preview_page");
	});

	test("references the living style guide and base template paths", () => {
		const prompt = assemblePrompt(baseConfig);
		expect(prompt).toContain("public/_base.html");
		expect(prompt).toContain("/ui/_components.html");
	});

	test("references the eight reference example pages", () => {
		const prompt = assemblePrompt(baseConfig);
		expect(prompt).toContain("public/_examples/");
	});
});
