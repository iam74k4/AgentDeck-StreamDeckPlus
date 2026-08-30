/**
 * Logging facade — design §21.2.
 *
 * Deliberately independent of the Stream Deck SDK so it can be unit-tested and so
 * every layer shares one redaction path. `plugin.ts` supplies the real sink.
 */

import { redact, redactString } from "./redact.js";

export type LogLevel = "error" | "warn" | "info" | "debug";

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = { error: 0, warn: 1, info: 2, debug: 3 };

export interface LogSink {
	error(message: string): void;
	warn(message: string): void;
	info(message: string): void;
	debug(message: string): void;
}

export interface Logger {
	error(message: string, context?: unknown): void;
	warn(message: string, context?: unknown): void;
	info(message: string, context?: unknown): void;
	debug(message: string, context?: unknown): void;
	/** Creates a scoped logger that shares this logger's sink and level. */
	child(scope: string): Logger;
	/** Applies to this logger and every child derived from it. */
	setLevel(level: LogLevel): void;
	getLevel(): LogLevel;
}

/* eslint-disable no-console */
export const consoleSink: LogSink = {
	error: (m) => console.error(m),
	warn: (m) => console.warn(m),
	info: (m) => console.info(m),
	debug: (m) => console.debug(m),
};
/* eslint-enable no-console */

export const nullSink: LogSink = {
	error: () => {},
	warn: () => {},
	info: () => {},
	debug: () => {},
};

/** Level shared by a logger and all of its children. */
interface LevelBox {
	level: LogLevel;
}

class ScopedLogger implements Logger {
	readonly #sink: LogSink;
	readonly #levelBox: LevelBox;
	readonly #scope: string | undefined;

	public constructor(sink: LogSink, levelBox: LevelBox, scope?: string) {
		this.#sink = sink;
		this.#levelBox = levelBox;
		this.#scope = scope;
	}

	public error(message: string, context?: unknown): void {
		this.#write("error", message, context);
	}

	public warn(message: string, context?: unknown): void {
		this.#write("warn", message, context);
	}

	public info(message: string, context?: unknown): void {
		this.#write("info", message, context);
	}

	public debug(message: string, context?: unknown): void {
		this.#write("debug", message, context);
	}

	public child(scope: string): Logger {
		const merged = this.#scope === undefined ? scope : `${this.#scope}:${scope}`;
		return new ScopedLogger(this.#sink, this.#levelBox, merged);
	}

	public setLevel(level: LogLevel): void {
		this.#levelBox.level = level;
	}

	public getLevel(): LogLevel {
		return this.#levelBox.level;
	}

	#write(target: LogLevel, message: string, context?: unknown): void {
		if (LEVEL_ORDER[target] > LEVEL_ORDER[this.#levelBox.level]) {
			return;
		}
		const prefix = this.#scope === undefined ? "" : `[${this.#scope}] `;
		let line = `${prefix}${redactString(message)}`;
		if (context !== undefined) {
			line += ` ${safeStringify(redact(context))}`;
		}
		this.#sink[target](line);
	}
}

export interface LoggerOptions {
	sink?: LogSink;
	level?: LogLevel;
	scope?: string;
}

export function createLogger(options: LoggerOptions = {}): Logger {
	return new ScopedLogger(options.sink ?? consoleSink, { level: options.level ?? "info" }, options.scope);
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return "«unserialisable»";
	}
}
