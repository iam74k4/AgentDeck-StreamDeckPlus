/**
 * Instructions §7.1 / §7.2 — framing, correlation and handshake enforcement.
 */
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { AppServerClient } from "@/providers/codex/app-server-client.js";
import { JsonRpcTransport, jsonRpcErrorToAgentDeckError } from "@/providers/codex/json-rpc.js";

interface Harness {
	transport: JsonRpcTransport;
	input: PassThrough;
	written: () => Record<string, unknown>[];
	push: (message: object) => void;
}

function harness(options: { requestTimeoutMs?: number } = {}): Harness {
	const input = new PassThrough();
	const output = new PassThrough();
	const lines: string[] = [];
	output.on("data", (chunk: Buffer) => lines.push(chunk.toString("utf8")));

	const transport = new JsonRpcTransport({
		input,
		output,
		...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
	});

	return {
		transport,
		input,
		written: () =>
			lines
				.join("")
				.split("\n")
				.filter((line) => line.trim().length > 0)
				.map((line) => JSON.parse(line) as Record<string, unknown>),
		push: (message: object) => input.write(`${JSON.stringify(message)}\n`),
	};
}

describe("JSONL framing", () => {
	it("writes one newline-delimited object per message", async () => {
		const h = harness();
		void h.transport.request("a/b", { x: 1 });
		h.transport.notify("c/d");

		expect(h.written()).toEqual([{ id: 0, method: "a/b", params: { x: 1 } }, { method: "c/d" }]);
	});

	it("reassembles messages split across chunks", async () => {
		const h = harness();
		const notifications: string[] = [];
		h.transport.onNotification((n) => notifications.push(n.method));

		h.input.write('{"method":"par');
		h.input.write('tial/one"}\n{"method":"partial/two"}\n');
		await new Promise((resolve) => setImmediate(resolve));

		expect(notifications).toEqual(["partial/one", "partial/two"]);
	});

	it("handles several messages arriving in one chunk", async () => {
		const h = harness();
		const notifications: string[] = [];
		h.transport.onNotification((n) => notifications.push(n.method));

		h.input.write('{"method":"a"}\n{"method":"b"}\n{"method":"c"}\n');
		await new Promise((resolve) => setImmediate(resolve));
		expect(notifications).toEqual(["a", "b", "c"]);
	});

	it("skips non-JSON diagnostic output without dropping the stream", async () => {
		const h = harness();
		const notifications: string[] = [];
		h.transport.onNotification((n) => notifications.push(n.method));

		h.input.write("warning: something happened\n");
		h.push({ method: "still/works" });
		await new Promise((resolve) => setImmediate(resolve));
		expect(notifications).toEqual(["still/works"]);
	});
});

describe("request correlation", () => {
	it("resolves each request with its own response, out of order", async () => {
		const h = harness();
		const first = h.transport.request<string>("a");
		const second = h.transport.request<string>("b");

		h.push({ id: 1, result: "second" });
		h.push({ id: 0, result: "first" });

		await expect(first).resolves.toBe("first");
		await expect(second).resolves.toBe("second");
	});

	it("rejects with a typed error when the server returns one", async () => {
		const h = harness();
		const pending = h.transport.request("a/b");
		h.push({ id: 0, error: { code: -32603, message: "boom" } });
		await expect(pending).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
	});

	it("times out rather than leaving a caller hanging", async () => {
		const h = harness({ requestTimeoutMs: 20 });
		await expect(h.transport.request("slow")).rejects.toMatchObject({ code: "TIMEOUT" });
	});

	it("rejects everything in flight when the transport closes", async () => {
		const h = harness();
		const pending = h.transport.request("a");
		h.transport.close();
		await expect(pending).rejects.toMatchObject({ code: "PROVIDER_OFFLINE" });
		await expect(h.transport.request("b")).rejects.toMatchObject({ code: "PROVIDER_OFFLINE" });
	});

	it("ignores a response for an id it never sent", async () => {
		const h = harness();
		expect(() => h.push({ id: 999, result: {} })).not.toThrow();
	});
});

describe("server-initiated requests", () => {
	it("always answers, even with no handler registered", async () => {
		const h = harness();
		h.push({ id: 7, method: "execCommandApproval", params: {} });
		await new Promise((resolve) => setImmediate(resolve));

		expect(h.written()).toEqual([
			{ id: 7, error: { code: -32601, message: "Unsupported method: execCommandApproval" } },
		]);
	});

	it("returns the handler's result", async () => {
		const h = harness();
		h.transport.setRequestHandler(() => ({ decision: "denied" }));
		h.push({ id: 7, method: "askSomething" });
		await new Promise((resolve) => setImmediate(resolve));

		expect(h.written()[0]).toEqual({ id: 7, result: { decision: "denied" } });
	});

	it("answers with an error when the handler throws", async () => {
		const h = harness();
		h.transport.setRequestHandler(() => {
			throw new Error("nope");
		});
		h.push({ id: 7, method: "askSomething" });
		await new Promise((resolve) => setImmediate(resolve));

		expect(h.written()[0]).toMatchObject({ id: 7, error: { code: -32601 } });
	});
});

describe("error classification", () => {
	it("treats server overload as retryable rate limiting", () => {
		const error = jsonRpcErrorToAgentDeckError({ code: -32001, message: "Server overloaded" }, "a");
		expect(error.code).toBe("RATE_LIMITED");
		expect(error.retryable).toBe(true);
	});

	it("never classifies by the server's message text (instructions §10)", () => {
		// Sign-in state is established from `account/read`, not from prose that the
		// server is free to reword or localise.
		for (const message of ["not logged in", "unauthorized", "認証されていません"]) {
			expect(jsonRpcErrorToAgentDeckError({ code: -32000, message }, "a").code).toBe("PROTOCOL_ERROR");
		}
	});
});

describe("handshake ordering (instructions §7.1)", () => {
	const client = (h: Harness): AppServerClient =>
		new AppServerClient({ transport: h.transport, clientInfo: { name: "agentdeck", version: "0.0.1" } });

	it("refuses every API call before initialize completes", async () => {
		const h = harness();
		const c = client(h);

		await expect(c.readRateLimits()).rejects.toMatchObject({ code: "INITIALIZATION_FAILED" });
		await expect(c.listThreads()).rejects.toMatchObject({ code: "INITIALIZATION_FAILED" });
		await expect(c.interruptTurn("thr", "turn")).rejects.toMatchObject({ code: "INITIALIZATION_FAILED" });
		// Nothing was put on the wire.
		expect(h.written()).toEqual([]);
	});

	it("sends initialize, then the initialized notification, then unlocks the API", async () => {
		const h = harness();
		const c = client(h);

		const pending = c.initialize();
		h.push({ id: 0, result: { platformOs: "windows" } });
		await pending;

		expect(h.written().map((m) => m.method)).toEqual(["initialize", "initialized"]);
		expect(c.initialized).toBe(true);

		void c.readRateLimits();
		await new Promise((resolve) => setImmediate(resolve));
		expect(h.written().map((m) => m.method)).toEqual([
			"initialize",
			"initialized",
			"account/rateLimits/read",
		]);
	});

	it("does not mark itself initialized when initialize fails", async () => {
		const h = harness();
		const c = client(h);

		const pending = c.initialize();
		h.push({ id: 0, error: { code: -32603, message: "nope" } });
		await expect(pending).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });

		expect(c.initialized).toBe(false);
		expect(h.written().map((m) => m.method)).toEqual(["initialize"]);
	});

	it("does not advertise experimental capabilities (design §9.3)", async () => {
		const h = harness();
		const c = client(h);
		void c.initialize();
		await new Promise((resolve) => setImmediate(resolve));

		const params = h.written()[0]?.params as { capabilities?: { experimentalApi?: boolean } };
		expect(params.capabilities?.experimentalApi).toBe(false);
	});

	it("survives a notification handler that throws", async () => {
		const h = harness();
		const good = vi.fn();
		h.transport.onNotification(() => {
			throw new Error("bad handler");
		});
		h.transport.onNotification(good);

		h.push({ method: "a/b" });
		await new Promise((resolve) => setImmediate(resolve));
		expect(good).toHaveBeenCalled();
	});
});
