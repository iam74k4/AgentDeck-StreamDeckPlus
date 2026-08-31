/**
 * Typed error surface for AgentDeck.
 *
 * Instructions §10: branch on codes, never on error message strings.
 */

export type AgentDeckErrorCode =
	| "CLI_NOT_FOUND"
	| "PROVIDER_OFFLINE"
	| "INITIALIZATION_FAILED"
	| "NOT_AUTHENTICATED"
	| "NOT_CONFIGURED"
	| "RATE_LIMITED"
	| "INVALID_PROJECT"
	| "GIT_NOT_REPOSITORY"
	| "PROTOCOL_ERROR"
	| "TIMEOUT"
	| "INTERRUPTED"
	| "UNKNOWN";

export class AgentDeckError extends Error {
	public readonly code: AgentDeckErrorCode;
	public readonly retryable: boolean;

	public constructor(
		code: AgentDeckErrorCode,
		message: string,
		options?: { cause?: unknown; retryable?: boolean },
	) {
		super(message, options?.cause === undefined ? undefined : { cause: options.cause });
		this.name = "AgentDeckError";
		this.code = code;
		this.retryable = options?.retryable ?? DEFAULT_RETRYABLE.has(code);
	}
}

const DEFAULT_RETRYABLE: ReadonlySet<AgentDeckErrorCode> = new Set<AgentDeckErrorCode>([
	"PROVIDER_OFFLINE",
	"RATE_LIMITED",
	"TIMEOUT",
	"INITIALIZATION_FAILED",
]);

export function isAgentDeckError(value: unknown): value is AgentDeckError {
	return value instanceof AgentDeckError;
}

export function toAgentDeckError(value: unknown, fallback: AgentDeckErrorCode = "UNKNOWN"): AgentDeckError {
	if (isAgentDeckError(value)) {
		return value;
	}
	const message = value instanceof Error ? value.message : String(value);
	return new AgentDeckError(fallback, message, { cause: value });
}

/**
 * Short, key-sized label for an error code.
 *
 * Design §21.1 / instructions §10: a Stream Deck key shows a state, not a stack trace.
 */
const ERROR_BADGES: Readonly<Record<AgentDeckErrorCode, string>> = {
	CLI_NOT_FOUND: "CLI?",
	PROVIDER_OFFLINE: "OFFLINE",
	INITIALIZATION_FAILED: "ERROR",
	NOT_AUTHENTICATED: "LOGIN",
	NOT_CONFIGURED: "SETUP",
	RATE_LIMITED: "LIMIT",
	INVALID_PROJECT: "NO PROJ",
	GIT_NOT_REPOSITORY: "NO GIT",
	PROTOCOL_ERROR: "ERROR",
	TIMEOUT: "TIMEOUT",
	INTERRUPTED: "STOPPED",
	UNKNOWN: "ERROR",
};

export function errorBadge(code: AgentDeckErrorCode): string {
	return ERROR_BADGES[code];
}
