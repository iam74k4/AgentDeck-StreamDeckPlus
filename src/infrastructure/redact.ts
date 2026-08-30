/**
 * Credential redaction — design §21.2, instructions §11.
 *
 * Nothing reaches a log sink without passing through here. The rule is absolute:
 * OAuth tokens, API keys, Authorization headers, full prompts, full clipboard
 * contents and voice/screenshot payloads never appear in a log line, not even at
 * debug level.
 */

export const REDACTED = "«redacted»";

/** Property names whose values are always replaced, at any nesting depth. */
const SENSITIVE_KEYS: readonly RegExp[] = [
	/^authorization$/i,
	/^proxy-authorization$/i,
	/^cookie$/i,
	/(^|[_-])api[_-]?key$/i,
	/(^|[_-])secret/i,
	/(^|[_-])password$/i,
	/(^|[_-])passphrase$/i,
	/(^|[_-])credential/i,
	/token$/i,
	/^token/i,
	/^bearer$/i,
	/^auth$/i,
	// Free-text payloads that must not be logged in full (instructions §11).
	/^prompt$/i,
	/^clipboard/i,
	/^transcript$/i,
	/^screenshot/i,
];

/** Inline secrets that can appear inside an otherwise harmless message string. */
const SENSITIVE_PATTERNS: readonly RegExp[] = [
	/\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi,
	/\b(sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/g,
	/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
	/\b(?:access|refresh|id)[_-]?token["'\s:=]+[A-Za-z0-9._~+/-]{8,}=*/gi,
];

const MAX_STRING_LENGTH = 200;

export function redactString(value: string): string {
	let out = value;
	for (const pattern of SENSITIVE_PATTERNS) {
		out = out.replace(pattern, REDACTED);
	}
	return out;
}

function isSensitiveKey(key: string): boolean {
	return SENSITIVE_KEYS.some((pattern) => pattern.test(key));
}

/**
 * Returns a log-safe copy of `value`.
 *
 * Sensitive keys are replaced, long strings are truncated, and cycles are broken
 * so a malformed provider payload can never wedge the logger.
 */
export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
	if (depth > 6) {
		return "«depth-limit»";
	}
	if (typeof value === "string") {
		const safe = redactString(value);
		return safe.length > MAX_STRING_LENGTH ? `${safe.slice(0, MAX_STRING_LENGTH)}…(${safe.length})` : safe;
	}
	if (value === null || typeof value !== "object") {
		return value;
	}
	if (value instanceof Error) {
		return { name: value.name, message: redactString(value.message) };
	}
	if (value instanceof Date) {
		return value.toISOString();
	}
	if (seen.has(value)) {
		return "«circular»";
	}
	seen.add(value);

	if (Array.isArray(value)) {
		const head = value.slice(0, 20).map((item) => redact(item, depth + 1, seen));
		return value.length > 20 ? [...head, `…(${value.length} items)`] : head;
	}

	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		out[key] = isSensitiveKey(key) ? REDACTED : redact(item, depth + 1, seen);
	}
	return out;
}
