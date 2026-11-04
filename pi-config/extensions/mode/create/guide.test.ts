import assert from "node:assert/strict";
import { test } from "node:test";
import { CREATE_FILES, CREATE_GROUPS, CREATE_GUIDE_NAMES, CREATE_INSTRUCTIONS, CREATE_TOPICS, createContents, createGuide, parseHeader, stripOwnerNotes } from "./guide.ts";

/** §chat.create-mode/contents, word for word: the table of contents the mode promises. */
const PROMISED = `- **Make it yours.**
  - \`appearance\`: colours, type and how this browser shows Sova
  - \`models\`: which models you can use, what new chats start on, and the sign-ins behind them
  - \`workers\`: which models your workers and teams run on, and named worker personas
- **Teach your chats.**
  - \`instructions\`: standing rules every chat in a folder, or on this computer, follows
  - \`skills\`: recipes a chat loads when relevant, and reusable slash commands
  - \`modes\`: what new chats start in, how planning behaves, and modes your project ships
  - \`profiles\`: named kinds of chat, what each may and may not do
- **Give them new abilities.**
  - \`tools\`: a new tool for the agent to call, and how it gets approved
  - \`extensions\`: your own page, buttons and cards inside Sova
  - \`pi-extensions\`: add-ons that change what a chat can do, from a file or a package
  - \`scripts\`: drive Sova from your own program, and follow what happens
- **Keep it safe.**
  - \`safety\`: what agents may touch, and who approves what
- **Run your project.**
  - \`project\`: how your project runs, tests, shares and ships
  - \`landing\`: what must pass before a branch reaches your project, and how it lands
  - \`automation\`: recipes you run by hand, or that run by themselves
  - \`cards\`: buttons, cards and drawings that are your project's own
  - \`overseers\`: how the Overseers and the Project Assistant watch, act and hold back
- **Reach you and others.**
  - \`attention\`: how Sova tells you things, and what it writes for you
  - \`computers\`: your other computers, public links, and this computer's setup`;

const FIELDS = ["Change", "Lives", "Approves", "By", "Live", "Check"];
const WAY = "(?:Screen|Card|Land|OK|Terminal|None)";
const BY = new RegExp(`^${WAY}(?: or ${WAY})*(?![A-Za-z])`);

/** What is wrong with one entry's structure, one line each; empty when it holds. */
function entryProblems(topic: string, md: string): string[] {
	const problems: string[] = [];
	// A fenced example isn't part of the list, whatever it looks like (YAML has lines just like these).
	const text = stripOwnerNotes(md).replace(/^```[\s\S]*?^```$/gm, "");
	const [, ...sections] = text.split(/^## /m);
	if (sections.length === 0) problems.push(`${topic}: no "## <thing>" section`);
	for (const section of sections) {
		const thing = section.split("\n", 1)[0]!;
		const found = [...section.matchAll(/^- ([A-Za-z]+): *(.*)$/gm)];
		const names = found.map((m) => m[1]);
		if (names.join() !== FIELDS.join()) problems.push(`${topic} / ${thing}: its lines are [${names.join(", ")}], want [${FIELDS.join(", ")}] in that order`);
		for (const m of found) if (!m[2]!.trim()) problems.push(`${topic} / ${thing}: ${m[1]} is empty`);
		const by = found.find((m) => m[1] === "By")?.[2] ?? "";
		if (!BY.test(by)) problems.push(`${topic} / ${thing}: By must start with one of Screen, Card, Land, OK, Terminal, None: "${by}"`);
	}
	return problems;
}

/** What an entry must not lean on: it is read in a chat on any project, with no Sova checkout. */
const NOT_STANDALONE: [RegExp, string][] = [
	[/§/, "a § ID"],
	[/\.sova\/spec/, "Sova's spec"],
	[/(?:^|[\s`("])(?:server|shared|pi-config|statecharts)\/[\w./-]+/m, "a path into Sova's checkout"],
	[/~\/webapps|\/home\//, "a machine's own path"],
];

test("the table of contents is the promised list, generated from each file's own header line", () => {
	assert.equal(createContents(), PROMISED);
	assert.equal(CREATE_GROUPS.length, 6);
	assert.equal(CREATE_TOPICS.length, 19);
	assert.deepEqual(CREATE_GUIDE_NAMES, CREATE_TOPICS);
	assert.deepEqual(CREATE_TOPICS.filter((topic, i) => CREATE_TOPICS.indexOf(topic) !== i), []);
});

test("every file in the folder is a topic, or shared.md, or overview.md", () => {
	assert.deepEqual(Object.keys(CREATE_FILES).filter((name) => !CREATE_TOPICS.includes(name) && name !== "shared" && name !== "overview"), []);
	assert.ok(CREATE_INSTRUCTIONS.includes(PROMISED), "the block carries the table of contents in place");
	assert.ok(!CREATE_INSTRUCTIONS.includes("{{"), "no placeholder left");
	assert.ok(!CREATE_INSTRUCTIONS.includes("<!--"), "no owner note reaches the model");
});

test("the block has a limited chat say what it can't do in its first reply, finding out by a read-only probe", () => {
	const limits = CREATE_INSTRUCTIONS.split("\n").find((line) => line.startsWith("In your first reply after entering Create"));
	assert.ok(limits, "the paragraph is there");
	for (const can_t of ["project modes and cards", "write files on this computer", "reach Sova's commands", "run project tools"]) assert.ok(limits.includes(can_t), can_t);
	assert.ok(limits.includes("`test -w "), "the sandbox's state is never told to the model, so the block must say how to find out");
});

test("a header line is `# <topic>: <words>`, and a file whose header names another topic isn't listed", () => {
	assert.deepEqual(parseHeader("# models: which models\n\nbody"), { topic: "models", line: "which models" });
	assert.equal(parseHeader("models: which models"), undefined);
	assert.equal(parseHeader("## models: which models"), undefined);
});

test("the lookup returns the shared rules, then the entry, with owner notes out", () => {
	const got = createGuide("appearance");
	const shared = stripOwnerNotes(CREATE_FILES.shared!);
	assert.ok(shared.length > 0);
	assert.ok(got.startsWith(shared));
	assert.ok(got.endsWith(stripOwnerNotes(CREATE_FILES.appearance!)));
	assert.ok(!got.includes("<!--"));
});

test("the shared rules define <agent dir>, so an entry that uses it can't be read as ~/.pi/agent", () => {
	const shared = stripOwnerNotes(CREATE_FILES.shared!);
	assert.ok(shared.includes('"${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"'));
	assert.ok(CREATE_TOPICS.some((topic) => CREATE_FILES[topic]!.includes("<agent dir>")), "entries use the name the rule defines");
	assert.ok(/Resolve `<agent dir>` first[^\n]*real path in the brief/.test(CREATE_INSTRUCTIONS), "a worker never gets the rule, so the block must have the chat resolve it for the brief");
});

test("Land starts with a worktree, in the words every turn carries, and every lookup says to find out where the chat is first", () => {
	assert.ok(/starts with the `worktree` tool/.test(CREATE_INSTRUCTIONS));
	assert.ok(/never commit to the main branch and you never merge, in any kind of folder/.test(CREATE_INSTRUCTIONS));
	assert.ok(/With no queue there's no Land, so never mention it/.test(CREATE_INSTRUCTIONS));
	assert.ok(/call `sova_settings` get and tell the person which kind of folder this is/.test(CREATE_INSTRUCTIONS));
	const shared = stripOwnerNotes(CREATE_FILES.shared!);
	for (const words of ["`sova_settings` get", "A project with a merge queue", "A project with no merge queue", "offer Initialize", "A folder that isn't a project", "offer Add as Project", "A folder that isn't in Git", "made by hand"]) assert.ok(shared.includes(words), words);
});

test("an alignment's go-ahead is never the OK, in the block and in the shared rules", () => {
	assert.ok(CREATE_INSTRUCTIONS.includes("An alignment's go-ahead is never that OK."));
	assert.ok(stripOwnerNotes(CREATE_FILES.shared!).includes("An alignment's go-ahead or a decided question is not one"));
});

test("a topic that isn't listed is refused, and the answer lists the topics", () => {
	assert.throws(() => createGuide("nope"), (err: Error) => err.message === `No topic nope. Topics: ${CREATE_TOPICS.join(", ")}.`);
	assert.throws(() => createGuide("shared"), /^Error: No topic shared\./);
	assert.throws(() => createGuide("overview"), /^Error: No topic overview\./);
});

test("the structure check tells a good entry from a bad one", () => {
	const good = "# x: y\n\n## Thing\n\n- Change: a.\n- Lives: b.\n- Approves: c.\n- By: Card or Land. Words.\n- Live: d.\n- Check: e.\n";
	assert.deepEqual(entryProblems("x", good), []);
	assert.equal(entryProblems("x", "# x: y\n").length, 1);
	assert.equal(entryProblems("x", good.replace("- Lives: b.\n", "")).length, 1);
	assert.equal(entryProblems("x", good.replace("- Check: e.", "- Check:")).length, 1);
	assert.equal(entryProblems("x", good.replace("By: Card or Land", "By: Landing")).length, 1);
	assert.equal(entryProblems("x", good.replace("By: Card or Land", "By: Sometimes")).length, 1);
	assert.deepEqual(entryProblems("x", `${good}\n\`\`\`yaml\n- name: example\n- Check:\n\`\`\`\n`), [], "a fenced example may follow the list");
});

test("every entry says, for each thing, what can change, where it lives, who approves, how it changes, how it goes live and how to check it", () => {
	assert.deepEqual(CREATE_TOPICS.flatMap((topic) => entryProblems(topic, CREATE_FILES[topic] ?? "")), []);
});

test("every entry stands alone: it depends on no project, no checkout and no spec", () => {
	const found = ["shared", "overview", ...CREATE_TOPICS].flatMap((name) => {
		const text = stripOwnerNotes(CREATE_FILES[name] ?? "");
		return NOT_STANDALONE.filter(([pattern]) => pattern.test(text)).map(([, what]) => `${name}: ${what}`);
	});
	assert.deepEqual(found, []);
});
