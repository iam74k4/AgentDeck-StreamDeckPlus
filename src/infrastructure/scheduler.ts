/**
 * Interval scheduling — used for provider health checks and low-frequency git
 * polling (design §16.3, §17.4).
 *
 * Timers are unref'd so a pending interval can never hold the plugin process open.
 */

export interface ScheduledTask {
	stop(): void;
	/** Runs the task now without waiting for the next tick. */
	trigger(): void;
}

export interface SchedulerOptions {
	/** Run once immediately on start. Defaults to `false`. */
	immediate?: boolean;
	onError?: (error: unknown) => void;
}

export function scheduleInterval(
	intervalMs: number,
	task: () => void | Promise<void>,
	options: SchedulerOptions = {},
): ScheduledTask {
	let stopped = false;
	let running = false;

	const run = (): void => {
		if (stopped || running) {
			return;
		}
		running = true;
		void (async () => {
			try {
				await task();
			} catch (error) {
				options.onError?.(error);
			} finally {
				running = false;
			}
		})();
	};

	const timer = setInterval(run, Math.max(250, intervalMs));
	timer.unref?.();

	if (options.immediate === true) {
		run();
	}

	return {
		stop(): void {
			stopped = true;
			clearInterval(timer);
		},
		trigger: run,
	};
}

export function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
	});
}
