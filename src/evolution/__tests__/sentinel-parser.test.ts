import { describe, expect, test } from "bun:test";
import { parseSentinel } from "../reflection-subprocess.ts";

// The sentinel parser is the permissive JSON extractor that turns the
// agent's final text into a structured SubprocessSentinel. It is the
// bridge between "the agent did something" and "TypeScript can route the
// result". Coverage here is a failure-mode safety net.

describe("parseSentinel", () => {
	test("parses a plain object JSON sentinel", () => {
		expect(parseSentinel('{"status":"ok"}')).toEqual({ status: "ok" });
	});

	test("parses a skip sentinel with reason", () => {
		const r = parseSentinel('{"status":"skip","reason":"nothing to learn"}');
		expect(r?.status).toBe("skip");
		expect(r?.reason).toBe("nothing to learn");
	});

	test("parses an escalate sentinel with target", () => {
		const r = parseSentinel('{"status":"escalate","target":"sonnet","reason":"too hard"}');
		expect(r?.status).toBe("escalate");
		expect(r?.target).toBe("sonnet");
	});

	test("parses a sentinel with a compact per-change action and shrinkage", () => {
		// Compaction is a per-change annotation (action:"compact"), not a
		// top-level status. The status union is ok | skip | escalate.
		const r = parseSentinel(
			'{"status":"ok","changes":[{"file":"user-profile.md","action":"compact","expected_shrinkage":0.5}]}',
		);
		expect(r?.status).toBe("ok");
		expect(r?.changes?.[0].action).toBe("compact");
		expect(r?.changes?.[0].expected_shrinkage).toBe(0.5);
	});

	test("extracts JSON from trailing position after prose", () => {
		const text = 'I did the work as requested.\n\n{"status":"ok","changes":[]}';
		expect(parseSentinel(text)?.status).toBe("ok");
	});

	test("picks the LAST JSON object when multiple are present", () => {
		const text = 'First thought: {"status":"ok"} then actually {"status":"skip","reason":"changed my mind"}';
		expect(parseSentinel(text)?.status).toBe("skip");
	});

	test("returns null on empty input", () => {
		expect(parseSentinel("")).toBeNull();
		expect(parseSentinel("   ")).toBeNull();
	});

	test("returns null on prose with no JSON", () => {
		expect(parseSentinel("Hello world, no JSON here.")).toBeNull();
	});

	test("returns null when JSON is present but lacks a valid status", () => {
		expect(parseSentinel('{"not":"a sentinel"}')).toBeNull();
	});

	test("returns null when JSON is malformed", () => {
		expect(parseSentinel("{status: invalid}")).toBeNull();
	});

	test("handles nested JSON structures in the changes array", () => {
		const text = `{"status":"ok","changes":[{"file":"a.md","action":"edit","summary":"first"},{"file":"b.md","action":"new","summary":"second"}]}`;
		const r = parseSentinel(text);
		expect(r?.status).toBe("ok");
		expect(r?.changes).toHaveLength(2);
	});

	test("handles whitespace-only response", () => {
		expect(parseSentinel("   \n   \t")).toBeNull();
	});

	test("handles an escalate target=opus sentinel", () => {
		const r = parseSentinel('{"status":"escalate","target":"opus","reason":"needs top reasoning"}');
		expect(r?.target).toBe("opus");
	});

	test("round-trips predicted_effect and motivation on a change entry", () => {
		const r = parseSentinel(
			`{"status":"ok","changes":[{"file":"memory/corrections.md","action":"edit",` +
				`"summary":"Add operator correction",` +
				`"predicted_effect":"Agent refuses non-allowlisted senders at intake instead of after fetch.",` +
				`"motivation":"agentic"}]}`,
		);
		expect(r?.changes?.[0].predicted_effect).toBe(
			"Agent refuses non-allowlisted senders at intake instead of after fetch.",
		);
		expect(r?.changes?.[0].motivation).toBe("agentic");
	});

	test("accepts the domain motivation value", () => {
		const r = parseSentinel(
			`{"status":"ok","changes":[{"file":"domain-knowledge.md","action":"edit",` +
				`"predicted_effect":"Carbonio jail formats parse without a body-regex fallback.",` +
				`"motivation":"domain"}]}`,
		);
		expect(r?.changes?.[0].motivation).toBe("domain");
	});

	test("parses sentinel without the new fields (backward compatible)", () => {
		const r = parseSentinel('{"status":"ok","changes":[{"file":"persona.md","action":"edit"}]}');
		expect(r?.status).toBe("ok");
		expect(r?.changes).toHaveLength(1);
		expect(r?.changes?.[0].predicted_effect).toBeUndefined();
		expect(r?.changes?.[0].motivation).toBeUndefined();
	});

	test("parses the compact exemption declaring a no-op effect", () => {
		const r = parseSentinel(
			`{"status":"ok","changes":[{"file":"domain-knowledge.md","action":"compact",` +
				`"expected_shrinkage":0.3,` +
				`"predicted_effect":"No behavior change; removes duplication."}]}`,
		);
		expect(r?.changes?.[0].action).toBe("compact");
		expect(r?.changes?.[0].predicted_effect).toBe("No behavior change; removes duplication.");
	});

	// --- Hardened failure classes (fix/sentinel-parse-hardening) ---------
	// Each test reproduces a class proven to return null on the previous
	// brace-blind scanner. Reflections routinely quote JSON and code, so
	// these shapes are expected input, not corruption.

	test("recovers from an unbalanced prose brace before the sentinel", () => {
		const text =
			"Consider the {json example shape below.\n\n" +
			'{"status":"ok","changes":[{"file":"a.md","action":"edit","predicted_effect":"Cleaner intake."}]}';
		expect(parseSentinel(text)?.status).toBe("ok");
	});

	test("recovers from several unbalanced prose braces", () => {
		const text = "First { example and second { example.\n\n" + '{"status":"skip","reason":"nothing durable"}';
		expect(parseSentinel(text)?.status).toBe("skip");
	});

	test("survives an unbalanced open brace inside a string value", () => {
		const r = parseSentinel(
			'{"status":"ok","changes":[{"file":"a.md","action":"edit",' +
				'"predicted_effect":"Agent logs { when parsing fails and skips the entry.",' +
				'"motivation":"agentic"}]}',
		);
		expect(r?.status).toBe("ok");
		expect(r?.changes?.[0].predicted_effect).toContain("{");
	});

	test("survives an unbalanced close brace inside a string value", () => {
		const r = parseSentinel(
			'{"status":"ok","changes":[{"file":"a.md","action":"edit",' +
				'"predicted_effect":"Agent avoids trailing } artifacts in output.",' +
				'"motivation":"agentic"}]}',
		);
		expect(r?.status).toBe("ok");
	});

	test("survives a summary quoting an unclosed JSON snippet", () => {
		const r = parseSentinel(
			'{"status":"ok","changes":[{"file":"a.md","action":"edit",' +
				'"summary":"removed the {\\"status\\": anchor example",' +
				'"predicted_effect":"Cleaner file.",' +
				'"motivation":"agentic"}]}',
		);
		expect(r?.status).toBe("ok");
		expect(r?.changes?.[0].summary).toBe('removed the {"status": anchor example');
	});

	test("accepts a trailing comma after the changes array", () => {
		const r = parseSentinel('{"status":"ok","changes":[{"file":"a.md","action":"edit"}],}');
		expect(r?.status).toBe("ok");
		expect(r?.changes).toHaveLength(1);
	});

	test("accepts a trailing comma inside the changes array", () => {
		const r = parseSentinel('{"status":"ok","changes":[{"file":"a.md","action":"edit"},]}');
		expect(r?.status).toBe("ok");
		expect(r?.changes).toHaveLength(1);
	});

	test("parses a fenced json block", () => {
		const r = parseSentinel('Did the work.\n\n```json\n{"status":"ok","changes":[]}\n```');
		expect(r?.status).toBe("ok");
	});

	test("parses a fenced block surrounded by brace-heavy prose", () => {
		const text =
			'Use ```json {"a":1} ``` markers. Consider the {config below.\n\n' +
			'```json\n{"status":"skip","reason":"routine session"}\n```';
		expect(parseSentinel(text)?.status).toBe("skip");
	});

	test("last position still wins across candidate classes", () => {
		// An early fenced example must not beat the later true sentinel.
		const text =
			'Example shape: ```json {"status":"skip","reason":"teaching echo"} ```\n\n' + '{"status":"ok","changes":[]}';
		expect(parseSentinel(text)?.status).toBe("ok");
	});

	test("still rejects malformed JSON after all repair attempts", () => {
		expect(parseSentinel("{status: invalid}")).toBeNull();
		expect(parseSentinel('{"status":"ok", changes}')).toBeNull();
	});
});
