/**
 * Approval domain model — design §12.4, §22.2.
 *
 * Two rules are structural and hold everywhere:
 *   - there is no "always approve" variant;
 *   - high-risk requests must be confirmed with a hold, never a single tap.
 */

export type ApprovalType = "command" | "file-change" | "other";
export type ApprovalRisk = "low" | "medium" | "high";

export interface ApprovalRequest {
	id: string;
	sessionId: string;
	type: ApprovalType;
	title: string;
	summary: string;
	risk: ApprovalRisk;
}

/** Only `approve-once` and `deny` exist. Design §12.4 / §22.2. */
export type ApprovalDecision = "approve-once" | "deny";

export function requiresHoldToApprove(request: ApprovalRequest): boolean {
	return request.risk === "high";
}

/** Neutral description of what is being asked for, free of any provider's schema. */
export interface RiskInput {
	type: ApprovalType;
	/** Argv of the command, when the provider reports one. */
	command?: readonly string[];
	/** A shell command line, when the provider reports the command pre-joined. */
	commandLine?: string;
	/** Paths the request would write to, when it is a file change. */
	paths?: readonly string[];
	/** Directory the command would run in, and the project root if known. */
	cwd?: string;
	projectPath?: string;
}

/**
 * Commands that are destructive, escape the machine, or hand control to code
 * fetched at runtime. Matching is per token, never on a joined string: a
 * filename containing "rm -rf" must not raise the risk of an unrelated command.
 */
const HIGH_RISK_EXECUTABLES = new Set([
	"rm",
	"rmdir",
	"del",
	"rd",
	"format",
	"mkfs",
	"dd",
	"shutdown",
	"reboot",
	"diskpart",
	"chown",
	"chmod",
	"sudo",
	"doas",
	"runas",
]);

/** Fetchers: whatever they return tends to be executed moments later. */
const NETWORK_EXECUTABLES = /^(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)$/i;

const HIGH_RISK_ARGUMENTS: readonly RegExp[] = [
	/^--force$/i,
	/^-f$/i,
	/^-rf$/i,
	/^-fr$/i,
	/^--hard$/i,
	/^--no-verify$/i,
];

/**
 * Shells, with the flag that introduces the script they are about to run.
 *
 * Codex nearly always executes through one of these, so an argv of
 * `["bash", "-lc", "git status && rm -rf build"]` is the normal case rather than
 * the exotic one. Looking only at argv[0] would call every such command `bash`.
 */
const SHELL_SCRIPT_FLAGS: Readonly<Record<string, readonly string[]>> = {
	sh: ["-c", "-lc", "-ic"],
	bash: ["-c", "-lc", "-ic"],
	zsh: ["-c", "-lc", "-ic"],
	dash: ["-c", "-lc"],
	ksh: ["-c", "-lc"],
	fish: ["-c"],
	pwsh: ["-command", "-c"],
	powershell: ["-command", "-c"],
	"powershell.exe": ["-command", "-c"],
	cmd: ["/c", "/k"],
	"cmd.exe": ["/c", "/k"],
};

/** Wrappers that pass their remaining arguments through to another command. */
const PASSTHROUGH_PREFIXES = new Set(["env", "command", "nohup", "time", "exec", "nice", "xargs"]);

/**
 * Assesses how dangerous a request is.
 *
 * Deliberately pessimistic: anything this cannot understand is `high`, so an
 * unparseable command gets hold-to-approve rather than a single tap. Design
 * §22.2 puts safety ahead of convenience, and the cost of over-classifying is
 * one extra second of the user's time.
 */
export function assessRisk(input: RiskInput): ApprovalRisk {
	if (input.type === "command") {
		return assessCommandRisk(input);
	}
	if (input.type === "file-change") {
		return assessFileChangeRisk(input);
	}
	// Anything the deck cannot describe gets the most cautious treatment.
	return "high";
}

function assessCommandRisk(input: RiskInput): ApprovalRisk {
	const segments = commandSegments(input);
	if (segments === undefined || segments.length === 0) {
		return "high";
	}
	if (segments.some((segment) => isHighRiskSegment(segment))) {
		return "high";
	}
	// Running outside the project is not necessarily destructive, but it is not
	// what the user asked the agent to work on either.
	if (input.projectPath !== undefined && input.cwd !== undefined && !isInside(input.cwd, input.projectPath)) {
		return "medium";
	}
	return "low";
}

function assessFileChangeRisk(input: RiskInput): ApprovalRisk {
	const paths = input.paths ?? [];
	if (paths.length === 0) {
		// The v2 surface reports the change by item id and not by path, so this is
		// the ordinary case there, not a malformed one. Without the paths there is
		// nothing to judge, which is exactly when a hold is warranted.
		return "high";
	}
	if (input.projectPath !== undefined && paths.some((path) => !isInside(path, input.projectPath as string))) {
		return "high";
	}
	return paths.length > 20 ? "medium" : "low";
}

/**
 * Reduces a request to the individual commands it would run.
 *
 * Returns `undefined` when the command cannot be read with confidence, which the
 * caller turns into `high`.
 */
function commandSegments(input: RiskInput): string[][] | undefined {
	const argv = input.command ?? [];
	if (argv.length > 0) {
		const script = shellScriptOf(argv);
		if (script === undefined) {
			return [[...argv]];
		}
		return splitScript(script);
	}
	if (input.commandLine !== undefined && input.commandLine.trim().length > 0) {
		return splitScript(input.commandLine);
	}
	return undefined;
}

/** The script argument of a shell invocation, if that is what this argv is. */
function shellScriptOf(argv: readonly string[]): string | undefined {
	const executable = basename(argv[0] ?? "").toLowerCase();
	const flags = SHELL_SCRIPT_FLAGS[executable];
	if (flags === undefined) {
		return undefined;
	}
	for (let index = 1; index < argv.length; index += 1) {
		const argument = (argv[index] ?? "").toLowerCase();
		if (flags.includes(argument)) {
			return argv[index + 1];
		}
	}
	return undefined;
}

function isHighRiskSegment(segment: readonly string[]): boolean {
	const words = stripCommandPrefixes(segment);
	if (words.length === 0) {
		return false;
	}
	const executable = basename(words[0] ?? "").toLowerCase();
	if (HIGH_RISK_EXECUTABLES.has(executable) || NETWORK_EXECUTABLES.test(executable)) {
		return true;
	}
	return words.some((word) => HIGH_RISK_ARGUMENTS.some((pattern) => pattern.test(word)));
}

/** Drops `FOO=bar` assignments and wrappers so the real executable is examined. */
function stripCommandPrefixes(segment: readonly string[]): string[] {
	const words = [...segment];
	while (words.length > 0) {
		const word = words[0] ?? "";
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || PASSTHROUGH_PREFIXES.has(basename(word).toLowerCase())) {
			words.shift();
			continue;
		}
		break;
	}
	return words;
}

const OPERATOR_CHARACTERS = new Set(["|", "&", ";", "\n"]);
const REDIRECT_CHARACTERS = new Set([">", "<"]);

/**
 * Splits a shell script into the commands it runs.
 *
 * This is not a shell parser and does not try to be one. It understands quoting
 * and the separators that chain commands, and gives up — returning `undefined`,
 * which means `high` — on anything that could hide a command from it, such as
 * substitution or an unbalanced quote.
 */
function splitScript(script: string): string[][] | undefined {
	const segments: string[][] = [];
	let words: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	let hasWord = false;

	const endWord = (): void => {
		if (hasWord) {
			words.push(current);
			current = "";
			hasWord = false;
		}
	};
	const endSegment = (): void => {
		endWord();
		if (words.length > 0) {
			segments.push(words);
			words = [];
		}
	};

	for (let index = 0; index < script.length; index += 1) {
		const character = script[index] ?? "";

		if (quote !== undefined) {
			if (character === quote) {
				quote = undefined;
				continue;
			}
			// A substitution inside double quotes still runs a command.
			if (quote === '"' && isSubstitutionStart(script, index)) {
				return undefined;
			}
			current += character;
			hasWord = true;
			continue;
		}

		if (character === '"' || character === "'") {
			quote = character;
			hasWord = true;
			continue;
		}
		if (character === "\\") {
			index += 1;
			const escaped = script[index];
			if (escaped !== undefined) {
				current += escaped;
				hasWord = true;
			}
			continue;
		}
		if (isSubstitutionStart(script, index)) {
			return undefined;
		}
		if (OPERATOR_CHARACTERS.has(character)) {
			endSegment();
			continue;
		}
		if (REDIRECT_CHARACTERS.has(character)) {
			// The target stays a word; only the operator itself is dropped.
			endWord();
			continue;
		}
		if (/\s/.test(character)) {
			endWord();
			continue;
		}
		current += character;
		hasWord = true;
	}

	if (quote !== undefined) {
		return undefined;
	}
	endSegment();
	return segments;
}

function isSubstitutionStart(script: string, index: number): boolean {
	const character = script[index];
	if (character === "`") {
		return true;
	}
	return character === "$" && (script[index + 1] === "(" || script[index + 1] === "{");
}

function basename(path: string): string {
	const segments = path.split(/[\\/]/);
	return segments[segments.length - 1] ?? path;
}

function isInside(candidate: string, root: string): boolean {
	const normalise = (value: string): string => value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
	const normalisedRoot = normalise(root);
	const normalisedCandidate = normalise(candidate);
	return normalisedCandidate === normalisedRoot || normalisedCandidate.startsWith(`${normalisedRoot}/`);
}
