import { readFileSync } from "node:fs";
import type { EvolutionConfig } from "./config.ts";

// Phase 3 constitution checker. Trimmed from the Phase 1+2 shape: the
// delta-level regex check (`VIOLATION_PATTERNS`, `checkRationaleForViolations`)
// and the per-bullet `check` method are gone. The reflection subprocess is
// the only writer and its constitution enforcement is Q4's three-layer model
// (sandbox deny + prompt + post-write byte compare in invariant-check I2).
// This class now just loads and exposes the constitution text so callers
// (tests, the runtime wiring) can inject it as context.

export class ConstitutionChecker {
	private principles: string;
	private configPath: string;

	constructor(evolutionConfig: EvolutionConfig) {
		this.configPath = evolutionConfig.paths.constitution;
		this.principles = this.loadConstitution();
	}

	private loadConstitution(): string {
		try {
			return readFileSync(this.configPath, "utf-8");
		} catch {
			throw new Error(
				`Constitution file not found at ${this.configPath}. The constitution is required for the evolution engine to function.`,
			);
		}
	}

	getConstitution(): string {
		return this.principles;
	}
}
