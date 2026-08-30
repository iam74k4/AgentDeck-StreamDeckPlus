/**
 * A stand-in for `codex app-server --stdio`.
 *
 * Speaks the real wire format — newline-delimited JSON-RPC with the `jsonrpc`
 * member omitted — so the integration tests exercise the transport, the
 * handshake ordering rule and the notification path for real, without needing the
 * Codex CLI installed.
 *
 * Configured through env vars:
 *   FAKE_RATE_LIMITS  JSON for the `account/rateLimits/read` result
 *   FAKE_THREADS      JSON for the `thread/list` result
 *   FAKE_SCRIPT       JSON array of { delayMs, method, params } notifications to
 *                     emit after `initialized`; an entry with `exit` terminates
 *                     the process instead, simulating a crash
 *   FAKE_FAIL         comma-separated method names that should answer with an error
 *   FAKE_NO_INIT_REPLY  set to skip the `initialize` response entirely
 */

import { createInterface } from "node:readline";

const parseEnv = (name, fallback) => {
	const raw = process.env[name];
	if (raw === undefined || raw === "") {
		return fallback;
	}
	try {
		return JSON.parse(raw);
	} catch {
		return fallback;
	}
};

const rateLimits = parseEnv("FAKE_RATE_LIMITS", {
	rateLimits: {
		limitId: null,
		limitName: "Codex",
		primary: { usedPercent: 41, windowDurationMins: 300, resetsAt: 1800000000 },
		secondary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: 1800600000 },
		planType: "plus",
		rateLimitReachedType: null,
	},
});
const threads = parseEnv("FAKE_THREADS", {
	data: [{ id: "thr_1", preview: "Fix the parser", status: { type: "idle" }, createdAt: 1700000000 }],
	nextCursor: null,
});
const script = parseEnv("FAKE_SCRIPT", []);
const failing = new Set((process.env.FAKE_FAIL ?? "").split(",").filter((entry) => entry.length > 0));

let initialized = false;
const interrupts = [];

function write(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function notify(method, params) {
	write({ method, params });
}

function runScript() {
	let elapsed = 0;
	for (const step of script) {
		elapsed += step.delayMs ?? 10;
		setTimeout(() => {
			if (step.exit !== undefined) {
				process.exit(step.exit);
			}
			notify(step.method, step.params);
		}, elapsed);
	}
}

function handle(message) {
	const { id, method, params } = message;

	if (method === "initialized") {
		initialized = true;
		runScript();
		return;
	}
	if (id === undefined) {
		return;
	}

	if (method === "initialize") {
		if (process.env.FAKE_NO_INIT_REPLY === "1") {
			return;
		}
		write({
			id,
			result: {
				userAgent: "fake-codex/0.0.0",
				codexHome: "/tmp/codex",
				platformFamily: "unix",
				platformOs: "linux",
			},
		});
		return;
	}

	// The real server refuses everything until the handshake completes.
	if (!initialized) {
		write({ id, error: { code: -32002, message: `${method} called before initialized` } });
		return;
	}

	if (failing.has(method)) {
		write({ id, error: { code: -32603, message: `${method} failed on purpose` } });
		return;
	}

	switch (method) {
		case "account/rateLimits/read":
			write({ id, result: rateLimits });
			return;
		case "account/read":
			write({ id, result: { type: "chatgpt", email: "dev@example.com", planType: "plus" } });
			return;
		case "thread/list":
			write({ id, result: threads });
			return;
		case "thread/read":
			write({
				id,
				result: {
					thread: {
						id: params?.threadId ?? "thr_1",
						status: { type: "active", activeFlags: [] },
						turns: [{ id: "turn_from_read", status: "inProgress" }],
					},
				},
			});
			return;
		case "turn/interrupt":
			interrupts.push(params);
			write({ id, result: {} });
			// The real server follows an interrupt with a turn/completed notification.
			notify("turn/completed", {
				threadId: params?.threadId,
				turn: { id: params?.turnId, status: "interrupted" },
			});
			return;
		case "model/list":
			write({
				id,
				result: {
					data: [
						{ id: "gpt-5.1-codex", displayName: "GPT-5.1 Codex", supportedReasoningEfforts: ["medium"] },
					],
				},
			});
			return;
		default:
			write({ id, error: { code: -32601, message: `Unknown method: ${method}` } });
	}
}

createInterface({ input: process.stdin }).on("line", (line) => {
	const trimmed = line.trim();
	if (trimmed.length === 0) {
		return;
	}
	try {
		handle(JSON.parse(trimmed));
	} catch (error) {
		process.stderr.write(`fake server error: ${String(error)}\n`);
	}
});

// Design §9.5: closing stdin must be enough to bring the process down.
process.stdin.on("end", () => process.exit(0));
