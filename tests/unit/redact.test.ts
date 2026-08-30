import { describe, expect, it, vi } from "vitest";
import { createLogger, type LogSink } from "@/infrastructure/logger.js";
import { redact, redactString, REDACTED } from "@/infrastructure/redact.js";

describe("redaction (instructions §11, design §21.2)", () => {
	it("removes credential-bearing keys at any depth", () => {
		const result = redact({
			ok: "visible",
			apiKey: "sk-abcdef0123456789abcdef",
			nested: { authorization: "Bearer xyz", refreshToken: "r-123", deeper: { api_key: "k" } },
		}) as Record<string, unknown>;

		expect(result.ok).toBe("visible");
		expect(result.apiKey).toBe(REDACTED);
		const nested = result.nested as Record<string, unknown>;
		expect(nested.authorization).toBe(REDACTED);
		expect(nested.refreshToken).toBe(REDACTED);
		expect((nested.deeper as Record<string, unknown>).api_key).toBe(REDACTED);
	});

	it("removes free-text payloads that must never be logged", () => {
		const result = redact({ prompt: "secret business plan", clipboardText: "…", transcript: "…" }) as Record<
			string,
			unknown
		>;
		expect(result.prompt).toBe(REDACTED);
		expect(result.clipboardText).toBe(REDACTED);
		expect(result.transcript).toBe(REDACTED);
	});

	it("removes inline secrets from message strings", () => {
		expect(redactString("calling with Authorization: Bearer abc123def456ghi")).not.toContain(
			"abc123def456ghi",
		);
		expect(redactString("key sk-0123456789abcdefghij failed")).toContain(REDACTED);
		const jwt =
			"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
		expect(redactString(`connected with ${jwt} ok`)).toContain(REDACTED);
		expect(redactString(`connected with ${jwt} ok`)).not.toContain(jwt);
	});

	it("survives cycles and truncates long strings", () => {
		const cyclic: Record<string, unknown> = { name: "loop" };
		cyclic.self = cyclic;
		expect(() => redact(cyclic)).not.toThrow();

		const long = redact("x".repeat(500)) as string;
		expect(long.length).toBeLessThan(260);
	});

	it("never writes a credential through the logger, even at debug level", () => {
		const lines: string[] = [];
		const sink: LogSink = {
			error: (m) => lines.push(m),
			warn: (m) => lines.push(m),
			info: (m) => lines.push(m),
			debug: (m) => lines.push(m),
		};
		const logger = createLogger({ sink, level: "debug", scope: "test" });
		logger.debug("handshake", { accessToken: "super-secret-token-value", userAgent: "codex/1" });

		expect(lines).toHaveLength(1);
		expect(lines[0]).not.toContain("super-secret-token-value");
		expect(lines[0]).toContain("codex/1");
	});

	it("respects the configured level and shares it with children", () => {
		const debug = vi.fn();
		const logger = createLogger({
			sink: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug },
			level: "info",
		});
		logger.child("codex").debug("hidden");
		expect(debug).not.toHaveBeenCalled();

		logger.setLevel("debug");
		logger.child("codex").debug("now visible");
		expect(debug).toHaveBeenCalledTimes(1);
	});
});
