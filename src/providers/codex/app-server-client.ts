/**
 * Typed client for `codex app-server --stdio` (instructions §7.1).
 *
 * Enforces the handshake order:
 *   initialize request → initialize response → `initialized` notification → API calls.
 * Any account/thread/turn call attempted before that throws instead of being sent.
 */

import { AgentDeckError } from "../../domain/errors.js";
import type { Logger } from "../../infrastructure/logger.js";
import type { JsonRpcTransport, NotificationHandler } from "./json-rpc.js";
import {
	CodexMethod,
	type WireAccount,
	type WireGetAccountRateLimitsResponse,
	type WireInitializeParams,
	type WireInitializeResponse,
	type WireModelListResponse,
	type WireThread,
	type WireThreadListResponse,
	type WireThreadSettingsUpdateParams,
	type WireTurn,
} from "./protocol.js";

export interface AppServerClientOptions {
	transport: JsonRpcTransport;
	clientInfo: { name: string; title?: string; version: string };
	logger?: Logger;
	initializeTimeoutMs?: number;
}

export interface WireThreadReadResponse {
	thread?: (WireThread & { turns?: WireTurn[] | null }) | null;
}

export class AppServerClient {
	readonly #transport: JsonRpcTransport;
	readonly #clientInfo: { name: string; title?: string; version: string };
	readonly #logger: Logger | undefined;
	readonly #initializeTimeoutMs: number;
	#initialized = false;

	public constructor(options: AppServerClientOptions) {
		this.#transport = options.transport;
		this.#clientInfo = options.clientInfo;
		this.#logger = options.logger;
		this.#initializeTimeoutMs = options.initializeTimeoutMs ?? 20_000;
	}

	public get initialized(): boolean {
		return this.#initialized;
	}

	public onNotification(handler: NotificationHandler): () => void {
		return this.#transport.onNotification(handler);
	}

	/**
	 * Performs the handshake. Resolves only once `initialized` has been sent, at
	 * which point the remaining API surface unlocks.
	 */
	public async initialize(): Promise<WireInitializeResponse> {
		if (this.#initialized) {
			throw new AgentDeckError("PROTOCOL_ERROR", "App server is already initialized.");
		}

		const params: WireInitializeParams = {
			clientInfo: this.#clientInfo,
			// Design §9.3: experimental APIs are not an MVP requirement.
			capabilities: { experimentalApi: false },
		};

		const response = await this.#transport.request<WireInitializeResponse>(
			CodexMethod.Initialize,
			params,
			this.#initializeTimeoutMs,
		);

		this.#transport.notify(CodexMethod.Initialized, {});
		this.#initialized = true;
		this.#logger?.info("codex app-server initialized", {
			platformOs: response?.platformOs,
			platformFamily: response?.platformFamily,
		});
		return response ?? {};
	}

	public readAccount(): Promise<WireAccount> {
		return this.#call<WireAccount>(CodexMethod.AccountRead, {});
	}

	public readRateLimits(): Promise<WireGetAccountRateLimitsResponse> {
		return this.#call<WireGetAccountRateLimitsResponse>(CodexMethod.AccountRateLimitsRead, {});
	}

	public listThreads(limit = 20): Promise<WireThreadListResponse> {
		return this.#call<WireThreadListResponse>(CodexMethod.ThreadList, {
			cursor: null,
			limit,
			sortDirection: "desc",
			archived: false,
		});
	}

	public readThread(threadId: string, includeTurns = false): Promise<WireThreadReadResponse> {
		return this.#call<WireThreadReadResponse>(CodexMethod.ThreadRead, { threadId, includeTurns });
	}

	public interruptTurn(threadId: string, turnId: string): Promise<unknown> {
		return this.#call<unknown>(CodexMethod.TurnInterrupt, { threadId, turnId });
	}

	/** Design §19 — applies a model / reasoning choice to subsequent turns. */
	public updateThreadSettings(params: WireThreadSettingsUpdateParams): Promise<unknown> {
		return this.#call<unknown>(CodexMethod.ThreadSettingsUpdate, params);
	}

	public listModels(): Promise<WireModelListResponse> {
		return this.#call<WireModelListResponse>(CodexMethod.ModelList, { includeHidden: false });
	}

	#call<T>(method: string, params: unknown): Promise<T> {
		if (!this.#initialized) {
			return Promise.reject(
				new AgentDeckError(
					"INITIALIZATION_FAILED",
					`${method} was called before the app-server handshake completed.`,
				),
			);
		}
		return this.#transport.request<T>(method, params);
	}
}
