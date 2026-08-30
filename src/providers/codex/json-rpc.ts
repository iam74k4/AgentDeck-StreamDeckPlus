/**
 * JSON-RPC over newline-delimited JSON (JSONL) — instructions §7.2.
 *
 * Responsibilities stop at framing and request/response correlation. It knows
 * nothing about Codex methods; `AppServerClient` layers those on top.
 *
 * The Codex app-server omits the `"jsonrpc": "2.0"` member on the wire, so it is
 * omitted when writing and tolerated when reading.
 */

import type { Readable, Writable } from "node:stream";
import { AgentDeckError } from "../../domain/errors.js";
import type { Logger } from "../../infrastructure/logger.js";

export type JsonRpcId = number | string;

export interface JsonRpcRequestMessage {
	id: JsonRpcId;
	method: string;
	params?: unknown;
}

export interface JsonRpcNotificationMessage {
	method: string;
	params?: unknown;
}

export interface JsonRpcErrorBody {
	code: number;
	message: string;
	data?: unknown;
}

export interface JsonRpcResponseMessage {
	id: JsonRpcId;
	result?: unknown;
	error?: JsonRpcErrorBody;
}

export type IncomingRequestHandler = (request: JsonRpcRequestMessage) => Promise<unknown> | unknown;

export type NotificationHandler = (notification: JsonRpcNotificationMessage) => void;

export interface JsonRpcTransportOptions {
	input: Readable;
	output: Writable;
	logger?: Logger;
	/** Default per-request timeout. Design §27: provider I/O must never wedge the UI. */
	requestTimeoutMs?: number;
}

/** JSON-RPC reserved code for an unknown method. */
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
/** Codex uses this for backpressure — design §21.3 says back off and retry. */
export const CODEX_SERVER_OVERLOADED = -32001;

interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: unknown) => void;
	timer: NodeJS.Timeout;
	method: string;
}

export class JsonRpcTransport {
	readonly #input: Readable;
	readonly #output: Writable;
	readonly #logger: Logger | undefined;
	readonly #requestTimeoutMs: number;
	readonly #pending = new Map<JsonRpcId, Pending>();
	readonly #notificationHandlers = new Set<NotificationHandler>();

	#requestHandler: IncomingRequestHandler | undefined;
	#buffer = "";
	#nextId = 0;
	#closed = false;

	public constructor(options: JsonRpcTransportOptions) {
		this.#input = options.input;
		this.#output = options.output;
		this.#logger = options.logger;
		this.#requestTimeoutMs = options.requestTimeoutMs ?? 15_000;

		this.#input.setEncoding("utf8");
		this.#input.on("data", (chunk: string) => this.#onData(chunk));
		this.#input.on("end", () => this.close(new AgentDeckError("PROVIDER_OFFLINE", "Transport closed.")));
		this.#input.on("close", () => this.close(new AgentDeckError("PROVIDER_OFFLINE", "Transport closed.")));
	}

	public get closed(): boolean {
		return this.#closed;
	}

	/** Registers the handler for server→client requests (e.g. approval elicitation). */
	public setRequestHandler(handler: IncomingRequestHandler | undefined): void {
		this.#requestHandler = handler;
	}

	public onNotification(handler: NotificationHandler): () => void {
		this.#notificationHandlers.add(handler);
		return () => this.#notificationHandlers.delete(handler);
	}

	public notify(method: string, params?: unknown): void {
		this.#write({ method, ...(params === undefined ? {} : { params }) });
	}

	public request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
		if (this.#closed) {
			return Promise.reject(
				new AgentDeckError("PROVIDER_OFFLINE", `Transport closed; cannot call ${method}.`),
			);
		}

		const id = this.#nextId++;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				reject(new AgentDeckError("TIMEOUT", `Timed out waiting for ${method}.`));
			}, timeoutMs ?? this.#requestTimeoutMs);
			timer.unref?.();

			this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer, method });
			this.#write({ id, method, ...(params === undefined ? {} : { params }) });
		});
	}

	/** Rejects every in-flight request and stops accepting new ones. */
	public close(reason?: unknown): void {
		if (this.#closed) {
			return;
		}
		this.#closed = true;
		const error = reason ?? new AgentDeckError("PROVIDER_OFFLINE", "Transport closed.");
		for (const [id, pending] of this.#pending) {
			clearTimeout(pending.timer);
			this.#pending.delete(id);
			pending.reject(error);
		}
		this.#notificationHandlers.clear();
	}

	#write(message: object): void {
		const line = `${JSON.stringify(message)}\n`;
		try {
			this.#output.write(line);
		} catch (error) {
			this.#logger?.warn("failed to write to provider stdin", error);
		}
	}

	#onData(chunk: string): void {
		this.#buffer += chunk;

		let newlineIndex = this.#buffer.indexOf("\n");
		while (newlineIndex !== -1) {
			const line = this.#buffer.slice(0, newlineIndex).trim();
			this.#buffer = this.#buffer.slice(newlineIndex + 1);
			if (line.length > 0) {
				this.#onLine(line);
			}
			newlineIndex = this.#buffer.indexOf("\n");
		}
	}

	#onLine(line: string): void {
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			// A non-JSON line is diagnostic output from the CLI, not a protocol failure.
			this.#logger?.debug("ignoring non-JSON line from provider");
			return;
		}
		if (typeof message !== "object" || message === null) {
			return;
		}

		const record = message as Record<string, unknown>;
		const hasId = record.id !== undefined && record.id !== null;
		const hasMethod = typeof record.method === "string";

		if (hasMethod && hasId) {
			void this.#handleIncomingRequest(record as unknown as JsonRpcRequestMessage);
			return;
		}
		if (hasMethod) {
			this.#handleNotification({ method: record.method as string, params: record.params });
			return;
		}
		if (hasId) {
			this.#handleResponse(record as unknown as JsonRpcResponseMessage);
		}
	}

	#handleNotification(notification: JsonRpcNotificationMessage): void {
		for (const handler of this.#notificationHandlers) {
			try {
				handler(notification);
			} catch (error) {
				this.#logger?.warn(`notification handler failed for ${notification.method}`, error);
			}
		}
	}

	#handleResponse(response: JsonRpcResponseMessage): void {
		const pending = this.#pending.get(response.id);
		if (pending === undefined) {
			this.#logger?.debug("response for unknown request id");
			return;
		}
		clearTimeout(pending.timer);
		this.#pending.delete(response.id);

		if (response.error !== undefined) {
			pending.reject(jsonRpcErrorToAgentDeckError(response.error, pending.method));
			return;
		}
		pending.resolve(response.result);
	}

	async #handleIncomingRequest(request: JsonRpcRequestMessage): Promise<void> {
		if (this.#requestHandler === undefined) {
			// Always answer: an unanswered request would leave the server waiting.
			this.#write({
				id: request.id,
				error: { code: JSON_RPC_METHOD_NOT_FOUND, message: `Unsupported method: ${request.method}` },
			});
			return;
		}
		try {
			const result = await this.#requestHandler(request);
			this.#write({ id: request.id, result: result ?? {} });
		} catch (error) {
			this.#logger?.warn(`request handler failed for ${request.method}`, error);
			this.#write({
				id: request.id,
				error: { code: JSON_RPC_METHOD_NOT_FOUND, message: `Handler failed for ${request.method}` },
			});
		}
	}
}

/**
 * Classifies a JSON-RPC error by its numeric code only.
 *
 * Instructions §10: no branch may key off the server's message text. Whether the
 * account is signed in is answered by `account/read` in `CodexProvider`, not by
 * pattern-matching an error string that the server is free to reword or localise.
 */
export function jsonRpcErrorToAgentDeckError(error: JsonRpcErrorBody, method: string): AgentDeckError {
	if (error.code === CODEX_SERVER_OVERLOADED) {
		return new AgentDeckError("RATE_LIMITED", `${method}: ${error.message}`, { retryable: true });
	}
	return new AgentDeckError("PROTOCOL_ERROR", `${method}: ${error.message}`);
}
