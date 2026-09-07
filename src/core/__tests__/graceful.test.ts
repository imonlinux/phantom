import { describe, expect, test } from "bun:test";
import { installUnhandledRejectionGuard } from "../graceful.ts";

describe("installUnhandledRejectionGuard", () => {
	test("logs an escaped rejection instead of letting it kill the process", () => {
		installUnhandledRejectionGuard();

		const errors: string[] = [];
		const originalError = console.error;
		console.error = (...args: unknown[]) => {
			errors.push(args.map(String).join(" "));
		};

		try {
			// Emitting the event exercises the same listener an escaped
			// rejection would hit, without depending on Bun's crash timing.
			process.emit("unhandledRejection", new Error("guard-test-rejection"), Promise.resolve());
		} finally {
			console.error = originalError;
		}

		expect(errors.some((line) => line.includes("guard-test-rejection"))).toBe(true);
		expect(errors.some((line) => line.includes("process kept alive"))).toBe(true);
	});
});
