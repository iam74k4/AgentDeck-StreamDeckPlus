/**
 * Minimal Property Inspector runtime.
 *
 * Self-contained on purpose: no CDN component library, so the settings UI keeps
 * working offline and the plugin ships without a third-party runtime dependency.
 *
 * Elements opt in with `data-setting="<key>"`; `data-scope="global"` targets the
 * plugin's global settings (design §23.1) instead of the action's (design §23.2).
 */
(function () {
	"use strict";

	var socket = null;
	var uuid = null;
	var registerEvent = null;
	var actionInfo = null;
	var settings = {};
	var globalSettings = {};
	var readyCallbacks = [];
	var connected = false;

	function send(payload) {
		if (socket && socket.readyState === 1) {
			socket.send(JSON.stringify(payload));
		}
	}

	function setSettings(next) {
		settings = next;
		send({ event: "setSettings", context: uuid, payload: settings });
	}

	function setGlobalSettings(next) {
		globalSettings = next;
		send({ event: "setGlobalSettings", context: uuid, payload: globalSettings });
	}

	/** Returned by `coerce` when the field cannot be saved as typed. */
	var INVALID = {};

	function coerce(element) {
		if (element.type === "checkbox") {
			return element.checked;
		}
		if (element.type === "number" || element.dataset.type === "number") {
			var parsed = Number.parseFloat(element.value);
			return Number.isFinite(parsed) ? parsed : undefined;
		}
		if (element.dataset.type === "json") {
			if (element.value.trim() === "") {
				return undefined;
			}
			try {
				return JSON.parse(element.value);
			} catch {
				// Half-typed JSON must not overwrite a working list.
				return INVALID;
			}
		}
		return element.value === "" ? undefined : element.value;
	}

	/**
	 * Marks a field the user is part-way through, without discarding their text.
	 *
	 * The message is found by id rather than by walking up from the field, so it
	 * can sit wherever it reads best rather than having to be a sibling.
	 */
	function setValidity(element, valid) {
		element.setAttribute("aria-invalid", valid ? "false" : "true");
		if (!element.id) {
			return;
		}
		var message = document.querySelector('[data-error-for="' + element.id + '"]');
		if (message) {
			message.hidden = valid;
		}
	}

	function applyTo(element) {
		// Never overwrite the field the user is currently editing.
		if (document.activeElement === element) {
			return;
		}
		var scope = element.dataset.scope === "global" ? globalSettings : settings;
		var value = scope[element.dataset.setting];
		if (element.type === "checkbox") {
			element.checked = value === true;
			return;
		}
		if (element.dataset.type === "json") {
			element.value = value === undefined || value === null ? "" : JSON.stringify(value, null, 2);
			setValidity(element, true);
			return;
		}
		element.value = value === undefined || value === null ? "" : String(value);
	}

	function writeBack(element) {
		var key = element.dataset.setting;
		var value = coerce(element);
		if (value === INVALID) {
			setValidity(element, false);
			return;
		}
		setValidity(element, true);
		var isGlobal = element.dataset.scope === "global";
		var next = Object.assign({}, isGlobal ? globalSettings : settings);
		if (value === undefined) {
			delete next[key];
		} else {
			next[key] = value;
		}
		if (isGlobal) {
			setGlobalSettings(next);
		} else {
			setSettings(next);
		}
	}

	/**
	 * Text fields are debounced before the settings are written.
	 *
	 * Without it, typing `codex` into the executable field saves five times, and
	 * each save restarts the Codex app-server — the deck flashes CLI? per keystroke
	 * while five child processes are spawned and torn down. Selects and checkboxes
	 * are single, deliberate choices and are written immediately.
	 */
	var WRITE_DEBOUNCE_MS = 400;

	/**
	 * Rebuilds a `<select>` from a list held in the global settings.
	 *
	 * `data-options-from="projects"` fills the element from
	 * `globalSettings.projects`, keeping whatever placeholder option is already in
	 * the markup. Used so a project is chosen from what is registered rather than
	 * typed as an absolute path, which is the worst thing to ask of anyone in a
	 * panel this size.
	 */
	function refreshOptions(element) {
		var source = globalSettings[element.dataset.optionsFrom];
		var previous = element.value;

		// Anything the markup declared stays; only generated options are replaced.
		Array.prototype.forEach.call(element.querySelectorAll("option[data-generated]"), function (option) {
			option.remove();
		});

		if (Array.isArray(source)) {
			source.forEach(function (entry) {
				if (!entry || typeof entry.id !== "string") {
					return;
				}
				var option = document.createElement("option");
				option.value = entry.id;
				option.textContent = typeof entry.name === "string" && entry.name.length > 0 ? entry.name : entry.id;
				option.dataset.generated = "true";
				element.appendChild(option);
			});
		}
		// Restore the selection, unless what was selected is gone — a project the
		// user removed must not stay on screen as a choice. A browser would clear
		// an unmatched value on assignment anyway; checking the options says so
		// out loud rather than leaving the panel's behaviour resting on a rule the
		// next reader has to already know.
		var stillThere = Array.prototype.some.call(element.options || element.children, function (option) {
			return option.value === previous;
		});
		element.value = stillThere ? previous : "";
	}

	function refreshAllOptions() {
		Array.prototype.forEach.call(document.querySelectorAll("[data-options-from]"), refreshOptions);
	}

	function bind() {
		Array.prototype.forEach.call(document.querySelectorAll("[data-setting]"), function (element) {
			// Options first: `applyTo` cannot select a value that is not there yet.
			if (element.dataset.optionsFrom) {
				refreshOptions(element);
			}
			applyTo(element);

			var immediate = element.tagName === "SELECT" || element.type === "checkbox";
			if (immediate) {
				element.addEventListener("change", function () {
					writeBack(element);
					refreshConditionals();
				});
				return;
			}

			var timer = null;
			var flush = function () {
				timer = null;
				writeBack(element);
				refreshConditionals();
			};
			element.addEventListener("input", function () {
				if (timer !== null) {
					clearTimeout(timer);
				}
				timer = setTimeout(flush, WRITE_DEBOUNCE_MS);
			});
			// Leaving the field commits straight away rather than waiting out the timer.
			element.addEventListener("change", function () {
				if (timer !== null) {
					clearTimeout(timer);
				}
				flush();
			});
		});
		refreshConditionals();
	}

	/** Shows or hides rows whose `data-when="<key>=<value>"` condition is unmet. */
	function refreshConditionals() {
		Array.prototype.forEach.call(document.querySelectorAll("[data-when]"), function (row) {
			var parts = row.dataset.when.split("=");
			var control = document.querySelector('[data-setting="' + parts[0] + '"]');
			row.hidden = !control || control.value !== parts[1];
		});
	}

	function ready() {
		connected = true;
		bind();
		readyCallbacks.forEach(function (callback) {
			callback({ settings: settings, globalSettings: globalSettings, actionInfo: actionInfo });
		});
	}

	window.connectElgatoStreamDeckSocket = function (port, inUuid, inRegisterEvent, _inInfo, inActionInfo) {
		uuid = inUuid;
		registerEvent = inRegisterEvent;
		try {
			actionInfo = inActionInfo ? JSON.parse(inActionInfo) : null;
			settings = (actionInfo && actionInfo.payload && actionInfo.payload.settings) || {};
		} catch {
			settings = {};
		}

		socket = new WebSocket("ws://127.0.0.1:" + port);
		socket.onopen = function () {
			send({ event: registerEvent, uuid: uuid });
			send({ event: "getGlobalSettings", context: uuid });
		};
		socket.onmessage = function (message) {
			var data;
			try {
				data = JSON.parse(message.data);
			} catch {
				return;
			}
			if (data.event === "didReceiveGlobalSettings") {
				globalSettings = (data.payload && data.payload.settings) || {};
				if (connected) {
					refreshAllOptions();
					Array.prototype.forEach.call(document.querySelectorAll('[data-scope="global"]'), applyTo);
				} else {
					ready();
				}
				return;
			}
			if (data.event === "didReceiveSettings") {
				settings = (data.payload && data.payload.settings) || {};
				Array.prototype.forEach.call(
					document.querySelectorAll("[data-setting]:not([data-scope='global'])"),
					applyTo,
				);
				refreshConditionals();
			}
		};
	};

	window.AgentDeckPI = {
		onReady: function (callback) {
			if (connected) {
				callback({ settings: settings, globalSettings: globalSettings, actionInfo: actionInfo });
				return;
			}
			readyCallbacks.push(callback);
		},
		setSettings: setSettings,
		setGlobalSettings: setGlobalSettings,
	};
})();
