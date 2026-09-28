/**
 * The explain child's prompt-cache contract, as pure functions (child.ts wires them into pi).
 *
 * Why a mirror. A provider's prompt cache matches an exact prefix: tools, then the system
 * prompt, then the messages. Since pi 0.86 the system prompt and the tool loadout are part of
 * the TRANSCRIPT: role:"system" messages carrying named `sections` and `toolsAdded` /
 * `toolsRemoved` (pi-ai `utils/transcript.js`). A forked child therefore starts with the
 * parent's exact prefix already in its copy, and loses it only by DECLARING something different:
 * before each request pi diffs its own freshly built sections against the replayed ones (by
 * section name, `diffSystemPromptSections`) and its active tools against the replayed tools (by
 * serialized declaration, pi-agent-core `agent-loop.js`), and appends a system message for any
 * difference. A removed or redeclared tool makes pi send providers a whole new checkpoint, so the
 * cached prefix is gone from the very first token.
 *
 * So the child does not try to rebuild the parent's prompt (same extensions, same mode blocks,
 * same AGENTS files, same pi version: every one of those can drift). It replays what the parent
 * DECLARED and declares exactly that back:
 *
 *  - sections: `before_agent_start` builds the prompt from the replayed sections verbatim
 *    (`mirrorPrompt`), so the diff is empty;
 *  - tools: every declared tool stays active with the parent's declaration. A tool the child may
 *    call and has itself with the same declaration is used as is; a built-in whose declaration
 *    differs (another pi version) is re-registered with the parent's declaration over the child's
 *    own implementation; everything else is a stub that can never run.
 *
 * What the child may DO is decided at call time instead (`gateToolCall`), which leaves the prefix
 * untouched: reading tools, web tools, and writing only inside its own store directory.
 */

/** The child's store directory: the only place it may write. Set by worker.ts, read by child.ts. */
export const EXPLAIN_STORE_ENV = "PI_EXPLAIN_STORE_DIR";
/** The parent's pi session id, for the provider cache key. Set by worker.ts, read by child.ts. */
export const EXPLAIN_PARENT_SESSION_ENV = "PI_EXPLAIN_PARENT_SESSION";

/** A tool as the model sees it: pi-ai's `toToolDeclaration` shape. */
export interface ToolDeclaration {
	name: string;
	description: string;
	parameters: unknown;
	constrainedSampling?: unknown;
}

/** What the transcript declared, after replaying every system message in order. */
export interface DeclaredState {
	/** Section name -> rendered text (`preamble` bare, the others wrapped `<name>\n…\n</name>`). */
	sections: Record<string, string>;
	/** Current tools, in first-declaration order (the order providers receive them). */
	tools: ToolDeclaration[];
}

interface SystemMessageLike {
	role: string;
	sections?: Record<string, string | null>;
	toolsAdded?: ToolDeclaration[];
	toolsRemoved?: { name: string }[];
}

/**
 * Replay the transcript's system messages the way pi-ai's `getCurrentSystemMessage` does:
 * sections patched by name (null deletes), tools deleted then set, in message order. Undefined
 * when the transcript declares nothing (an unforked child).
 */
export function declaredState(messages: readonly { role: string }[]): DeclaredState | undefined {
	const sections = new Map<string, string>();
	const tools = new Map<string, ToolDeclaration>();
	let seen = false;
	for (const message of messages as readonly SystemMessageLike[]) {
		if (message.role !== "system") continue;
		seen = true;
		for (const [name, value] of Object.entries(message.sections ?? {})) {
			if (value === null) sections.delete(name);
			else sections.set(name, value);
		}
		for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
		for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool);
	}
	return seen ? { sections: Object.fromEntries(sections), tools: [...tools.values()] } : undefined;
}

/** The body of a rendered `<name>\n…\n</name>` section, or undefined if it is not framed that way. */
export function sectionBody(name: string, text: string): string | undefined {
	const open = `<${name}>\n`;
	const close = `\n</${name}>`;
	if (!text.startsWith(open) || !text.endsWith(close) || text.length < open.length + close.length) return undefined;
	return text.slice(open.length, text.length - close.length);
}

/** Prompt options that rebuild `sections` exactly (see `applyMirror`). */
export interface PromptMirror {
	customPrompt: string;
	sections: Record<string, string>;
}

/**
 * pi's builder (`buildSystemPromptSections`) with a `customPrompt` emits: the prompt as
 * `preamble`, `cwd` always, and `addendum` / `project_context` / `skills` only when their inputs
 * are non-empty; then every custom section, overriding one of the same name, each wrapped
 * `<name>\n…\n</name>`. So a mirror is: the replayed preamble as the custom prompt, every other
 * replayed section as a custom section, and the inputs of the optional built-in sections emptied.
 * Undefined when the replay cannot be reproduced (no preamble, a section not framed by its name,
 * or no `cwd`, which pi would then add).
 */
export function mirrorPrompt(sections: Record<string, string>): PromptMirror | undefined {
	const preamble = sections.preamble;
	if (!preamble) return undefined;
	const custom: Record<string, string> = {};
	for (const [name, text] of Object.entries(sections)) {
		if (name === "preamble") continue;
		const body = sectionBody(name, text);
		if (body === undefined || !/^[a-z][a-z0-9_-]*$/.test(name)) return undefined;
		custom[name] = body;
	}
	if (custom.cwd === undefined) return undefined;
	return { customPrompt: preamble, sections: custom };
}

/** The mutable part of pi's `BuildSystemPromptOptions` that a mirror sets. */
export interface MirrorablePromptOptions {
	customPrompt?: string;
	forceSystemPrompt?: string;
	sections: Record<string, string>;
	appendSystemPrompt: string;
	contextFiles: unknown[];
	skills: unknown[];
}

/** Point `before_agent_start`'s prompt options at the mirror, in place. Tools are left alone. */
export function applyMirror(options: MirrorablePromptOptions, mirror: PromptMirror): void {
	options.customPrompt = mirror.customPrompt;
	delete options.forceSystemPrompt;
	options.sections = { ...mirror.sections };
	options.appendSystemPrompt = "";
	options.contextFiles = [];
	options.skills = [];
}

/** pi-ai's `declarationsEqual`: both sides through the declaration shape, compared serialized. */
export function sameDeclaration(a: ToolDeclaration, b: ToolDeclaration): boolean {
	const shape = (tool: ToolDeclaration) =>
		JSON.stringify({
			name: tool.name,
			description: tool.description,
			parameters: JSON.parse(JSON.stringify(tool.parameters ?? {})),
			...(tool.constrainedSampling === undefined ? {} : { constrainedSampling: tool.constrainedSampling }),
		});
	return shape(a) === shape(b);
}

/** Built-ins that only read. */
export const READ_TOOLS: readonly string[] = ["read", "grep", "find", "ls"];
/** Built-ins that write, allowed only inside the store directory. */
export const STORE_WRITE_TOOLS: readonly string[] = ["write", "edit"];
/** pi-web-access's default tool names: network reads, loaded only when that package is installed. */
export const WEB_TOOLS: readonly string[] = ["web_search", "fetch_content", "get_search_content", "source_check"];
/**
 * The shell, allowed only for one read-only command line (`readOnlyShellCommand`). A parent's
 * default tools are read, bash, edit and write: no grep, find or ls. Declaring those in the child
 * would change the prefix, so a mirrored child searches through bash instead.
 */
export const SHELL_TOOL = "bash";
/** Tools the child activates even when the parent did not declare them: it must read, and write its page. */
export const REQUIRED_TOOLS: readonly string[] = ["read", "write"];

export function callable(name: string): boolean {
	return READ_TOOLS.includes(name) || STORE_WRITE_TOOLS.includes(name) || WEB_TOOLS.includes(name) || name === SHELL_TOOL;
}

/**
 * Programs a read-only command line may run, and the arguments that would make each one write,
 * execute something else, or reach the network. Anything not listed is refused.
 */
const SHELL_PROGRAMS: Record<string, (args: readonly string[]) => string | undefined> = {
	rg: (args) => args.find((a) => /^--pre(-glob)?(=|$)/.test(a) || a === "--search-zip" || a === "-z") && "rg --pre and --search-zip run other programs",
	grep: () => undefined,
	egrep: () => undefined,
	fgrep: () => undefined,
	find: (args) => args.find((a) => /^-(exec|execdir|ok|okdir|delete|fprint0?|fprintf|fls)$/.test(a)) && "find may not execute, delete or write files",
	ls: () => undefined,
	cat: () => undefined,
	head: () => undefined,
	tail: (args) => args.find((a) => /^(-f|-F|--follow)/.test(a)) && "tail -f never ends",
	wc: () => undefined,
	file: () => undefined,
	stat: () => undefined,
	tree: (args) => args.find((a) => a === "-o" || a.startsWith("--output")) && "tree -o writes a file",
	pwd: () => undefined,
	realpath: () => undefined,
	dirname: () => undefined,
	basename: () => undefined,
	du: () => undefined,
	diff: () => undefined,
	cut: () => undefined,
	sort: (args) => args.find((a) => a === "-o" || a.startsWith("--output") || a.startsWith("--compress-program")) && "sort -o writes a file",
	jq: () => undefined,
	git: (args) => {
		const sub = args.find((a) => !a.startsWith("-"));
		if (!sub || !["log", "show", "diff", "status", "grep", "ls-files", "blame", "rev-parse", "shortlog", "describe"].includes(sub)) return `git ${sub ?? ""} is not a read-only git command here`.trim();
		if (args.some((a) => a.startsWith("--output") || a.startsWith("--ext-diff") || a === "-c" || a.startsWith("--exec") || a.startsWith("--git-dir") || a.startsWith("--work-tree"))) return "that git option can write or run other programs";
		return undefined;
	},
};

/**
 * Split a command line into pipeline segments of words, honouring quotes. Undefined for anything
 * a plain word list cannot express: expansion (`$`, backticks), redirection, chaining (`;`, `&`,
 * newlines), subshells, globbing is fine (it only names files).
 */
export function shellPipeline(command: string): string[][] | undefined {
	const segments: string[][] = [[]];
	let word: string | undefined;
	const end = () => {
		if (word !== undefined) segments[segments.length - 1]!.push(word);
		word = undefined;
	};
	for (let i = 0; i < command.length; i++) {
		const c = command[i]!;
		if (c === "'") {
			const close = command.indexOf("'", i + 1);
			if (close < 0) return undefined;
			word = (word ?? "") + command.slice(i + 1, close);
			i = close;
		} else if (c === '"') {
			let j = i + 1;
			let text = "";
			for (; j < command.length && command[j] !== '"'; j++) {
				const d = command[j]!;
				if (d === "$" || d === "`") return undefined;
				if (d === "\\" && j + 1 < command.length) text += command[++j];
				else text += d;
			}
			if (j >= command.length) return undefined;
			word = (word ?? "") + text;
			i = j;
		} else if (c === "\\") {
			if (i + 1 >= command.length || command[i + 1] === "\n") return undefined;
			word = (word ?? "") + command[++i];
		} else if (c === " " || c === "\t") end();
		else if (c === "|") {
			if (command[i + 1] === "|") return undefined;
			end();
			segments.push([]);
		} else if ("$`;&<>()\n\r{}".includes(c)) return undefined;
		else word = (word ?? "") + c;
	}
	end();
	return segments.every((segment) => segment.length > 0) ? segments : undefined;
}

/** Why `command` is not one read-only command line, or undefined if it is. */
export function readOnlyShellCommand(command: unknown): string | undefined {
	if (typeof command !== "string" || !command.trim()) return "no command";
	const pipeline = shellPipeline(command.trim());
	if (!pipeline) return "only plain commands and pipes: no redirection, chaining, substitution or variables";
	for (const [program, ...args] of pipeline) {
		const check = SHELL_PROGRAMS[program!];
		if (!check) return `"${program}" is not on the read-only list (${Object.keys(SHELL_PROGRAMS).join(", ")})`;
		const why = check(args);
		if (why) return why;
	}
	return undefined;
}

export type ToolAction =
	/** The child's own tool, whose declaration already equals the parent's. */
	| "own"
	/** A built-in the child re-registers with the parent's declaration over its own implementation. */
	| "wrap"
	/** Declared, never runnable: kept only so the declared tool set is unchanged. */
	| "stub";

export interface ToolPlanEntry {
	name: string;
	action: ToolAction;
	/** The declaration to register for `wrap` and `stub`. */
	declaration: ToolDeclaration;
}

/**
 * One entry per tool the child activates, in order: the parent's declared tools first (their
 * order is the request's), then any `REQUIRED_TOOLS` the parent lacked. Those extra tools are the
 * one case where the child changes the declared set: additive, so a provider that anchors tool
 * additions keeps the prefix, and the others lose it (a parent in strict mode has no `write`).
 * With no declared state (an unforked child) the child gets its callable tools, and nothing else.
 */
export function planTools(
	declared: readonly ToolDeclaration[] | undefined,
	own: ReadonlyMap<string, ToolDeclaration>,
	wrappable: ReadonlySet<string>,
): ToolPlanEntry[] {
	const plan: ToolPlanEntry[] = [];
	for (const declaration of declared ?? []) {
		const mine = own.get(declaration.name);
		const action: ToolAction = !callable(declaration.name)
			? "stub"
			: mine && sameDeclaration(mine, declaration)
				? "own"
				: wrappable.has(declaration.name)
					? "wrap"
					: "stub";
		plan.push({ name: declaration.name, action, declaration });
	}
	const planned = new Set(plan.map((entry) => entry.name));
	// Unforked, the child has grep, find and ls of its own and needs no shell.
	const extra = declared ? REQUIRED_TOOLS : [...READ_TOOLS, ...STORE_WRITE_TOOLS, ...WEB_TOOLS];
	for (const name of extra) {
		const mine = own.get(name);
		if (planned.has(name) || !mine) continue;
		plan.push({ name, action: "own", declaration: mine });
		planned.add(name);
	}
	return plan;
}

/** True when `target` is `dir` or inside it, after resolving both as absolute paths. */
export function insideDir(dir: string, target: string, resolve: (...parts: string[]) => string, sep = "/"): boolean {
	const root = resolve(dir);
	const path = resolve(target);
	return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Why a call must not run, or undefined if it may. Pure: `resolve` is `path.resolve` bound to the
 * child's cwd (pi resolves a tool's relative path against it). A path with `..` or a symlink in
 * the store directory is not a concern: the store is created fresh by the parent, and only the
 * child writes into it.
 */
export function gateToolCall(toolName: string, input: unknown, storeDir: string, resolve: (...parts: string[]) => string): string | undefined {
	if (READ_TOOLS.includes(toolName) || WEB_TOOLS.includes(toolName)) return undefined;
	if (toolName === SHELL_TOOL) {
		const why = readOnlyShellCommand(input && typeof input === "object" ? (input as { command?: unknown }).command : undefined);
		return why ? `The /explain worker runs bash only for one read-only command line (rg, grep, find, ls, cat, head, git log…, pipes allowed): ${why}.` : undefined;
	}
	if (STORE_WRITE_TOOLS.includes(toolName)) {
		const path = input && typeof input === "object" ? (input as { path?: unknown }).path : undefined;
		if (typeof path === "string" && path && insideDir(storeDir, path, resolve)) return undefined;
		return `The /explain worker writes only inside ${storeDir}. Write index.html and meta.json there; nothing else on disk.`;
	}
	return `The /explain worker is read-only: "${toolName}" is not available here. Research with read (and grep, find, ls, or read-only bash, whichever you have), and write only inside ${storeDir}.`;
}

/** The btw extension's visible side-thread notes (`btw/btw.ts` BTW_MESSAGE_TYPE), which its `context` handler drops from every request. */
export const BTW_MESSAGE_TYPE = "btw-note";

/** Drop what the parent's btw extension drops, so the child's messages match the parent's requests. */
export function withoutBtwNotes<T extends { role: string; customType?: string }>(messages: readonly T[]): T[] | undefined {
	const kept = messages.filter((message) => !(message.role === "custom" && message.customType === BTW_MESSAGE_TYPE));
	return kept.length === messages.length ? undefined : kept;
}

/**
 * OpenAI-style providers route their cache by `prompt_cache_key`, which pi sets to the session
 * id. The child's session id is new, so it asks for the parent's cache under the parent's key.
 */
export function withParentCacheKey(payload: unknown, ownSessionId: string | undefined, parentSessionId: string | undefined): unknown {
	if (!parentSessionId || !ownSessionId || !payload || typeof payload !== "object") return undefined;
	const body = payload as Record<string, unknown>;
	if (body.prompt_cache_key !== ownSessionId) return undefined;
	return { ...body, prompt_cache_key: parentSessionId };
}
