/**
 * Create's guide (§chat.create-mode/contents, §chat.create-mode/entries): one file per topic in this
 * folder, plus shared.md (the rules every lookup returns) and overview.md (the mode's block). Node
 * builtins only, read once at load from beside this module, so a chat carries the guide of the code it
 * runs: it needs no checkout, no project and no spec, and it works on a remote target because the
 * lookup answers in the chat's own process.
 *
 * A topic file's first line is its table of contents line, `# <topic>: <words>`, so the list and the
 * files can't disagree. This module holds only what no file can: which groups there are, and the order.
 * The file format is in shared.md's owner note; HTML comments (owner notes) never reach the model.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { restoreActive } from "../../sandbox/state.ts";

/** The groups and their topics, in the table of contents' order. A topic with no file isn't listed or looked up. */
export const CREATE_GROUPS: readonly { title: string; topics: readonly string[] }[] = [
	{ title: "Make it yours.", topics: ["appearance", "models", "workers"] },
	{ title: "Teach your chats.", topics: ["instructions", "skills", "modes", "profiles"] },
	{ title: "Give them new abilities.", topics: ["tools", "extensions", "pi-extensions", "scripts"] },
	{ title: "Keep it safe.", topics: ["safety"] },
	{ title: "Run your project.", topics: ["project", "landing", "releases", "playbooks", "automation", "cards", "overseers"] },
	{ title: "Reach you and others.", topics: ["attention", "computers"] },
];

/** The words `create_guide` takes, as the groups order them. */
export const CREATE_TOPICS: readonly string[] = CREATE_GROUPS.flatMap((group) => group.topics);

/** The topic files and the two that aren't topics, by name without `.md`, as written. */
const dir = new URL("./", import.meta.url);
export const CREATE_FILES: Readonly<Record<string, string>> = Object.fromEntries(
	readdirSync(dir)
		.filter((name) => name.endsWith(".md"))
		.sort()
		.map((name) => [name.slice(0, -3), readFileSync(new URL(name, dir), "utf8")]),
);

/** Owner notes out, ends trimmed: the text the model reads. */
export function stripOwnerNotes(md: string): string {
	return md.replace(/<!--[\s\S]*?-->\n?/g, "").trim();
}

/** A topic file's header: `# models: which models you can use`. */
const HEADER = /^# ([a-z-]+): (.+)$/;

/** The topic and the words a topic file's first line gives, or undefined when it has no header line. */
export function parseHeader(md: string): { topic: string; line: string } | undefined {
	const match = HEADER.exec(md.split("\n", 1)[0] ?? "");
	return match ? { topic: match[1]!, line: match[2]!.trim() } : undefined;
}

/** A topic is listed and looked up only when its file's header names it. */
const lineOf = (topic: string): string | undefined => {
	const file = CREATE_FILES[topic];
	const header = file === undefined ? undefined : parseHeader(file);
	return header?.topic === topic ? header.line : undefined;
};

/** The topics a lookup answers. */
export const CREATE_GUIDE_NAMES: readonly string[] = CREATE_TOPICS.filter((topic) => lineOf(topic) !== undefined);

/** The table of contents: the groups in order, each topic's line from its own file. */
export function createContents(): string {
	return CREATE_GROUPS.flatMap((group) => {
		const lines = group.topics.flatMap((topic) => {
			const line = lineOf(topic);
			return line === undefined ? [] : [`  - \`${topic}\`: ${line}`];
		});
		return lines.length ? [`- **${group.title}**`, ...lines] : [];
	}).join("\n");
}

/** The mode's block: overview.md with the table of contents in its `{{CONTENTS}}` place. */
export const CREATE_INSTRUCTIONS = stripOwnerNotes(CREATE_FILES.overview ?? "").replace("{{CONTENTS}}", () => createContents());

/**
 * What a lookup says first in a chat with its sandbox On, from the chat's own `sandbox` entries (On is
 * always recorded), or undefined in a chat with no such limit. A tool result is the one place the
 * sandbox may reach the model (§chat.sandbox/states), and an unlimited chat gets nothing to talk about.
 */
export function sandboxNote(entries: readonly { type: string; customType?: string; data?: unknown }[]): string | undefined {
	if (!restoreActive(entries)?.on) return undefined;
	return "This chat's sandbox is On: you can't write files on this computer, reach Sova's commands or run project tools here. If you haven't told the person, say so first, before you offer a change.";
}

/**
 * The playbook know-how's sections, in the contents page's order: one file each in `playbooks/` beside this
 * module, whose first line is its contents line, `# <section>: <words>`, as a topic's is. Making a playbook
 * (Create's `playbooks` topic) and running one (the run's message, which the server builds from
 * `playbookSections`) share this one contents page, so neither can drift from the files.
 */
export const PLAYBOOK_SECTION_ORDER: readonly string[] = ["what", "cast", "choices", "steps", "card", "repeats", "commands", "saving"];

const sectionsDir = new URL("./playbooks/", import.meta.url);
/** The section files, by name without `.md`, as written. */
export const PLAYBOOK_SECTION_FILES: Readonly<Record<string, string>> = Object.fromEntries(
	readdirSync(sectionsDir)
		.filter((name) => name.endsWith(".md"))
		.sort()
		.map((name) => [name.slice(0, -3), readFileSync(new URL(name, sectionsDir), "utf8")]),
);

/** A section is listed and opened only when its file's header names it. */
const sectionLine = (name: string): string | undefined => {
	const file = PLAYBOOK_SECTION_FILES[name];
	const header = file === undefined ? undefined : parseHeader(file);
	return header?.topic === name ? header.line : undefined;
};

/** The sections a lookup opens, in order. */
export const PLAYBOOK_SECTION_NAMES: readonly string[] = PLAYBOOK_SECTION_ORDER.filter((name) => sectionLine(name) !== undefined);

/** The contents page's sections, for a run's message: each name, its contents line, and its file (absolute). */
export function playbookSections(): { name: string; line: string; file: string }[] {
	return PLAYBOOK_SECTION_NAMES.map((name) => ({ name, line: sectionLine(name)!, file: fileURLToPath(new URL(`${name}.md`, sectionsDir)) }));
}

/** The contents list, one line per section: `- \`cast\`: who runs it, …`. */
export function playbookContents(): string {
	return PLAYBOOK_SECTION_NAMES.map((name) => `- \`${name}\`: ${sectionLine(name)}`).join("\n");
}

/** One section's text, owner notes out. */
export function playbookSection(name: string): string {
	if (!PLAYBOOK_SECTION_NAMES.includes(name)) throw new Error(`No section ${name} in playbooks. Sections: ${PLAYBOOK_SECTION_NAMES.join(", ")}.`);
	return stripOwnerNotes(PLAYBOOK_SECTION_FILES[name]!);
}

/** The topics that have sections: only `playbooks`. */
export const TOPICS_WITH_SECTIONS: readonly string[] = ["playbooks"];

/**
 * What `create_guide {topic}` returns: the shared rules, then that topic's entry (the `playbooks` entry with its
 * contents list in its `{{SECTIONS}}` place). With a section, only that section (§chat.create-mode/entries): the
 * shared rules came with the topic. A topic that isn't listed is refused, naming the topics, and so is a section
 * that isn't (§design.copy-deck/create-mode).
 */
export function createGuide(topic: string, section?: string): string {
	if (!CREATE_GUIDE_NAMES.includes(topic)) throw new Error(`No topic ${topic}. Topics: ${CREATE_GUIDE_NAMES.join(", ")}.`);
	if (section !== undefined && section !== "") {
		if (!TOPICS_WITH_SECTIONS.includes(topic)) throw new Error(`The ${topic} topic has no sections: open it with the topic alone.`);
		return playbookSection(section);
	}
	const entry = stripOwnerNotes(CREATE_FILES[topic]!).replace("{{SECTIONS}}", () => playbookContents());
	return `${stripOwnerNotes(CREATE_FILES.shared ?? "")}\n\n${entry}`;
}
