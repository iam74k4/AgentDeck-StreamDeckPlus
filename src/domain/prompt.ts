/**
 * Prompt presets — design §14.
 *
 * The deck does not get a key per prompt; it gets a dial that selects one
 * (design §14 "Promptは固定キーを大量に作らない"). A preset is a template plus
 * where its input comes from and where the result goes.
 */

export type PromptInputSource = "none" | "clipboard" | "selection" | "screenshot";
export type PromptTarget = "active-session" | "new-session" | "clipboard";

export interface PromptPreset {
	id: string;
	name: string;
	template: string;
	inputSource: PromptInputSource;
	target: PromptTarget;
}

/**
 * The starting set from design §14.
 *
 * Editable and replaceable from the Property Inspector; nothing in the code
 * depends on these particular entries existing.
 */
export const DEFAULT_PROMPT_PRESETS: readonly PromptPreset[] = [
	{
		id: "explain",
		name: "Explain",
		template: "Explain what this does, briefly:\n\n{{input}}",
		inputSource: "clipboard",
		target: "active-session",
	},
	{
		id: "review",
		name: "Review",
		template: "Review this for correctness and clarity. List concrete problems only:\n\n{{input}}",
		inputSource: "clipboard",
		target: "active-session",
	},
	{
		id: "refactor",
		name: "Refactor",
		template: "Refactor this, keeping behaviour identical. Explain each change in one line:\n\n{{input}}",
		inputSource: "clipboard",
		target: "active-session",
	},
	{
		id: "test",
		name: "Test",
		template: "Write tests for this. Cover the failure cases, not just the happy path:\n\n{{input}}",
		inputSource: "clipboard",
		target: "active-session",
	},
	{
		id: "security",
		name: "Security",
		template: "Look at this for security problems. Say what an attacker could do:\n\n{{input}}",
		inputSource: "clipboard",
		target: "active-session",
	},
	{
		id: "performance",
		name: "Performance",
		template: "Where does this spend its time, and what would you change first?\n\n{{input}}",
		inputSource: "clipboard",
		target: "active-session",
	},
	{
		id: "custom",
		name: "Custom",
		template: "{{input}}",
		inputSource: "clipboard",
		target: "active-session",
	},
	// Design §15.1's screenshot presets.
	{
		id: "explain-screen",
		name: "Explain Screen",
		template: "Explain what is on this screen.",
		inputSource: "screenshot",
		target: "active-session",
	},
	{
		id: "debug-screen",
		name: "Debug Screen",
		template: "This is what I am looking at. What is going wrong, and what should I check first?",
		inputSource: "screenshot",
		target: "active-session",
	},
	{
		id: "review-ui",
		name: "Review UI",
		template: "Review this interface. Point out what is unclear or inconsistent.",
		inputSource: "screenshot",
		target: "active-session",
	},
];

/** Where the captured input is substituted, if the template says where. */
export const INPUT_PLACEHOLDER = "{{input}}";

/**
 * Fills a preset's template.
 *
 * A template without the placeholder still gets the input, appended after a
 * blank line: a preset the user edited and forgot the placeholder in should send
 * what they copied, not silently drop it.
 */
export function renderPrompt(template: string, input: string | undefined): string {
	const value = input ?? "";
	if (template.includes(INPUT_PLACEHOLDER)) {
		return template.split(INPUT_PLACEHOLDER).join(value).trim();
	}
	if (value.length === 0) {
		return template.trim();
	}
	return `${template.trim()}\n\n${value}`.trim();
}

/**
 * Upper bound on captured input — design §15.2 ("巨大な場合は上限を設ける").
 *
 * Large enough for a file, small enough that a stray Ctrl+A never turns into a
 * multi-megabyte prompt.
 */
export const MAX_INPUT_CHARACTERS = 20_000;

export function clampInput(value: string, limit = MAX_INPUT_CHARACTERS): string {
	if (value.length <= limit) {
		return value;
	}
	return `${value.slice(0, limit)}\n\n[truncated by AgentDeck at ${limit} characters]`;
}

export function isPromptPreset(value: unknown): value is PromptPreset {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const candidate = value as Partial<PromptPreset>;
	return (
		typeof candidate.id === "string" &&
		candidate.id.length > 0 &&
		typeof candidate.name === "string" &&
		typeof candidate.template === "string" &&
		typeof candidate.inputSource === "string" &&
		typeof candidate.target === "string"
	);
}
