import type { EvolvedConfig } from "../../evolution/types.ts";

// Assembles the "evolved" portion of the system prompt from the live
// EvolvedConfig: constitution, communication style, user profile, domain
// knowledge, corrections, principles, and learned strategies. Returns an
// empty string when none of the sections have meaningful content so the
// assembler can drop the block.
export function buildEvolvedSections(evolved: EvolvedConfig): string {
	const parts: string[] = [];

	if (evolved.constitution.trim()) {
		parts.push(`# Constitution\n\n${evolved.constitution.trim()}`);
	}

	if (evolved.persona.trim() && countContentLines(evolved.persona) > 1) {
		parts.push(`# Communication Style\n\n${evolved.persona.trim()}`);
	}

	if (evolved.userProfile.trim() && countContentLines(evolved.userProfile) > 1) {
		parts.push(`# User Profile\n\n${evolved.userProfile.trim()}`);
	}

	if (evolved.domainKnowledge.trim() && countContentLines(evolved.domainKnowledge) > 1) {
		parts.push(`# Domain Knowledge\n\n${evolved.domainKnowledge.trim()}`);
	}

	if (evolved.memory.corrections.trim() && countContentLines(evolved.memory.corrections) > 1) {
		parts.push(`# Corrections\n\n${evolved.memory.corrections.trim()}`);
	}

	if (evolved.memory.principles.trim() && countContentLines(evolved.memory.principles) > 1) {
		parts.push(`# Principles\n\n${evolved.memory.principles.trim()}`);
	}

	const strategyParts: string[] = [];
	for (const content of Object.values(evolved.strategies)) {
		if (content.trim() && countContentLines(content) > 1) {
			strategyParts.push(content.trim());
		}
	}
	if (strategyParts.length > 0) {
		parts.push(`# Learned Strategies\n\n${strategyParts.join("\n\n")}`);
	}

	if (parts.length === 0) return "";

	return parts.join("\n\n");
}

function countContentLines(text: string): number {
	return text.split("\n").filter((line) => {
		const trimmed = line.trim();
		return trimmed !== "" && !trimmed.startsWith("#");
	}).length;
}
