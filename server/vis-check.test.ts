// Run: npx tsx --test server/vis-check.test.ts (or pnpm test). The vis feedback loop: fence
// extraction, which parses trigger a retry, the one-retry bound, the hidden message's shape, vis off,
// the vis_check tool, and — in a real AgentSession with a scripted provider — that a broken block
// costs exactly one more request and its note never reaches the transcript.
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "sova-vis-check-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before mode-state computes its paths
after(() => rmSync(agentDir, { recursive: true, force: true }));

const { visFences, visFailures, retryText, retryEntry, VisRetry, visCheck, frameDocument, visCheckExtension, VIS_RETRY_MESSAGE, VIS_CHECK_TOOL } = await import("./vis-check");
const { parseVis } = await import("../src/vis/parse");
const { FRAME_HARD_CHARS, FRAME_SOFT_CHARS } = await import("../src/vis/kinds/frame/parse");
const { normalizeEntry } = await import("./transcript");

const fence = (kind: string, body: string, marker = "```") => `${marker}vis ${kind}\n${body}\n${marker}`;
const GOOD_FLOW = "a -> b";
/** Two arrows in a row: a structural error under any leniency. */
const BROKEN_FLOW = "a -> -> b";
const host = (over: Partial<{ visOn: boolean; queued: boolean; writable: boolean }> = {}) => ({
  visOn: () => over.visOn ?? true,
  queued: () => over.queued ?? false,
  writable: () => over.writable ?? true,
});
const text = (t: string) => [{ type: "text", text: t }];

test("the broken fixture is a hard error and the good one draws, by the renderer's own parser", () => {
  assert.equal(parseVis("flow", GOOD_FLOW).ok, true);
  assert.equal(parseVis("flow", BROKEN_FLOW).ok, false);
});

// ---- fence extraction ----------------------------------------------------------------------------

test("visFences finds vis fences in each text block, numbered across the reply, and nothing else", () => {
  const block1 = ["Intro", "", fence("flow", GOOD_FLOW), "", "```ts\nconst x = 1;\n```", "", fence("sequence", "a -> b: hi", "~~~")].join("\n");
  const block2 = ["- item", "", "  ```vis tree", "  root", "  ```"].join("\n");
  const got = visFences([block1, block2]);
  assert.deepEqual(
    got.map((f) => [f.index, f.kind, f.line]),
    [
      [1, "flow", 3],
      [2, "sequence", 11],
      [3, "tree", 3],
    ],
  );
  assert.equal(got[0]!.body, `${GOOD_FLOW}\n`);
  assert.equal(got[2]!.body, "root\n", "a fence in a list item is the item's, de-indented, as the view renders it");
});

test("a vis fence quoted inside a longer fence is its content, not a block", () => {
  const quoted = ["````markdown", fence("flow", BROKEN_FLOW), "````"].join("\n");
  assert.deepEqual(visFences([quoted]), []);
});

test("`vis` alone is a fence with an empty kind (the renderer reports it), a `visual` fence is not vis", () => {
  const got = visFences(["```vis\na -> b\n```\n\n```visual\nx\n```"]);
  assert.deepEqual(
    got.map((f) => f.kind),
    [""],
  );
});

// ---- which parses trigger ------------------------------------------------------------------------

test("only a hard error is a failure: a figure that draws with warnings is not", () => {
  const large = `<div>${"x".repeat(FRAME_SOFT_CHARS + 100)}</div>`;
  const soft = parseVis("html", large);
  assert.equal(soft.ok, true, "over the soft budget still draws");
  assert.ok(soft.ok && soft.warnings.length > 0, "…with a warning");
  const failures = visFailures(visFences([[fence("html", large), fence("flow", GOOD_FLOW), fence("flow", BROKEN_FLOW)].join("\n\n")]));
  assert.deepEqual(
    failures.map((f) => [f.index, f.kind]),
    [[3, "flow"]],
  );
  const r = parseVis("flow", BROKEN_FLOW);
  assert.ok(!r.ok);
  assert.equal(failures[0]!.line, r.line);
  assert.equal(failures[0]!.message, r.message);
  assert.equal(failures[0]!.first, BROKEN_FLOW);
});

test("an unknown kind and an over-budget html are failures of the block as a whole", () => {
  const huge = `<p>${"y".repeat(FRAME_HARD_CHARS + 10)}</p>`;
  const failures = visFailures(visFences([[fence("pie", "a 1"), fence("html", huge)].join("\n\n")]));
  assert.deepEqual(
    failures.map((f) => [f.kind, f.line]),
    [
      ["pie", 0],
      ["html", 0],
    ],
  );
});

// ---- the hidden message --------------------------------------------------------------------------

test("the retry entry is a hidden custom message naming each block, its line and its error", () => {
  const failures = visFailures(visFences([[fence("flow", GOOD_FLOW), fence("flow", `title: T\n${BROKEN_FLOW}`)].join("\n\n")]));
  const entry = retryEntry(failures);
  assert.equal(entry.type, "custom_message");
  assert.equal(entry.customType, VIS_RETRY_MESSAGE);
  assert.equal(entry.display, false);
  const r = parseVis("flow", `title: T\n${BROKEN_FLOW}\n`);
  assert.ok(!r.ok);
  assert.ok(entry.content.includes(`Block 2 (\`vis flow\`, starting \`title: T\`): line ${r.line}: ${r.message}`), entry.content);
  assert.match(entry.content, /Re-send only the fixed block/);
  assert.deepEqual(entry.details, { v: 1, blocks: [{ index: 2, kind: "flow", line: r.line, message: r.message }] });
  assert.match(retryText([...failures, { ...failures[0]!, index: 3 }]), /could not draw 2 vis blocks/);
});

test("the transcript never shows the hidden message, as an entry or as a message", () => {
  const entry = { id: "e1", parentId: null, timestamp: new Date().toISOString(), ...retryEntry(visFailures(visFences([fence("flow", BROKEN_FLOW)]))) };
  assert.deepEqual(normalizeEntry(entry as never), []);
  const shown = { ...entry, display: true };
  assert.equal(normalizeEntry(shown as never).length, 1, "the same entry displayed would be a row: the check can tell the two apart");
});

// ---- the retry's bounds --------------------------------------------------------------------------

test("a completed run with a broken block retries once; the retry's own reply is never retried", () => {
  const r = new VisRetry();
  r.assistant(text(fence("flow", BROKEN_FLOW)));
  const first = r.beforeSettle("completed", host());
  assert.ok(first);
  r.assistant(text(fence("flow", BROKEN_FLOW)));
  assert.equal(r.beforeSettle("completed", host()), null, "still broken after the retry: no second one");
  r.settled();
  r.assistant(text(fence("flow", BROKEN_FLOW)));
  assert.ok(r.beforeSettle("completed", host()), "the next run gets its own retry");
});

test("no retry for a clean reply, an aborted or errored run, a queued message, a foreign writer, or vis off", () => {
  const cases: [string, (r: InstanceType<typeof VisRetry>) => unknown][] = [
    ["clean", (r) => (r.assistant(text(fence("flow", GOOD_FLOW))), r.beforeSettle("completed", host()))],
    ["no text", (r) => r.beforeSettle("completed", host())],
    ["aborted", (r) => (r.assistant(text(fence("flow", BROKEN_FLOW))), r.beforeSettle("aborted", host()))],
    ["error", (r) => (r.assistant(text(fence("flow", BROKEN_FLOW))), r.beforeSettle("error", host()))],
    ["queued", (r) => (r.assistant(text(fence("flow", BROKEN_FLOW))), r.beforeSettle("completed", host({ queued: true })))],
    ["not writable", (r) => (r.assistant(text(fence("flow", BROKEN_FLOW))), r.beforeSettle("completed", host({ writable: false })))],
    ["vis off", (r) => (r.assistant(text(fence("flow", BROKEN_FLOW))), r.beforeSettle("completed", host({ visOn: false })))],
  ];
  for (const [name, run] of cases) assert.equal(run(new VisRetry()), null, name);
  // The same broken reply with every condition met does retry: the cases above are not vacuous.
  const r = new VisRetry();
  r.assistant(text(fence("flow", BROKEN_FLOW)));
  assert.ok(r.beforeSettle("completed", host()));
});

test("thinking and tool calls are not reply text", () => {
  const r = new VisRetry();
  r.assistant([{ type: "thinking", thinking: fence("flow", BROKEN_FLOW) }, { type: "toolCall", id: "t", name: "x", arguments: { s: fence("flow", BROKEN_FLOW) } }]);
  assert.equal(r.beforeSettle("completed", host()), null);
});

// ---- vis_check -----------------------------------------------------------------------------------

test("frameDocument is the frame parser's own document on every body it accepts", () => {
  const bodies = [
    "<svg viewBox='0 0 1 1'></svg>",
    "title: Hi\ncaption: \"A caption\"\n\n<div>é ✓ 𝒳</div>\n",
    "\n\ntitle: x\n<p>a</p>\n\n",
    "caption: c\n  <b>x</b>  ",
  ];
  for (const body of bodies) {
    for (const kind of ["html", "svg"] as const) {
      const r = parseVis(kind, body);
      if (r.ok) assert.equal(frameDocument(body), (r.spec as { source: string }).source, `${kind}: ${JSON.stringify(body)}`);
    }
  }
  assert.ok(parseVis("svg", bodies[0]!).ok && parseVis("html", bodies[1]!).ok, "the loop above compared something");
});

test("vis_check reports ok, a soft overrun, a hard overrun and a parse error, with the character count", () => {
  const ok = visCheck("html", "title: T\n<div>é</div>");
  assert.equal(ok.details.ok, true);
  assert.equal(ok.details.chars, "<div>é</div>".length);
  assert.match(ok.text, /^OK: this vis html block draws\./);
  assert.match(ok.text, /within the 8192-character target/);

  // Multibyte: counted in characters, so 8,000 two-byte letters are within the target.
  const multi = visCheck("html", `<p>${"é".repeat(8000)}</p>`);
  assert.equal(multi.details.chars, 8007);
  assert.equal(multi.details.warnings.length, 0);

  const soft = visCheck("html", `<p>${"x".repeat(FRAME_SOFT_CHARS)}</p>`);
  assert.equal(soft.details.ok, true);
  assert.ok(soft.details.warnings.length > 0);
  assert.match(soft.text, /draws, marked large/);

  const hard = visCheck("html", `<p>${"x".repeat(FRAME_HARD_CHARS)}</p>`);
  assert.equal(hard.details.ok, false);
  assert.match(hard.text, /^ERROR: this vis html block would not draw/);
  assert.match(hard.text, /over the hard limit of 16384 characters/);

  const svg = visCheck("svg", "title: S\n<div></div>");
  assert.equal(svg.details.ok, false);
  assert.deepEqual(svg.details.error, { line: 2, message: "vis svg must start with <svg" });
});

// ---- in a real AgentSession ----------------------------------------------------------------------

const pi = await import("@earendil-works/pi-coding-agent");
const piAi = await import(pathToFileURL(join(realpathSync(join(process.cwd(), "node_modules/@earendil-works/pi-coding-agent")), "..", "pi-ai", "dist", "index.js")).href);

/** A session whose model answers from `script`, one text per request, with the vis extension. */
async function scriptedSession(script: string[], visOn: () => boolean, queued: () => boolean = () => false) {
  const requests: unknown[][] = [];
  function streamSimple(model: any, context: any) {
    const stream = piAi.createAssistantMessageEventStream();
    requests.push(context.messages);
    const reply = script.shift() ?? "ok";
    const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    const message = { role: "assistant", content: [{ type: "text", text: reply }], api: model.api, provider: model.provider, model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: zero }, stopReason: "stop", timestamp: Date.now() };
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      stream.push({ type: "text_end", contentIndex: 0, content: reply, partial: message });
      stream.push({ type: "done", reason: "stop", message });
    });
    return stream;
  }
  const cwd = mkdtempSync(join(agentDir, "cwd-"));
  const resourceLoader = new pi.DefaultResourceLoader({
    cwd,
    agentDir,
    extensionFactories: [
      (api: any) =>
        api.registerProvider("scripted", {
          baseUrl: "http://localhost",
          apiKey: "unused",
          api: "openai-completions",
          models: [{ id: "scripted-1", name: "Scripted", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
          streamSimple,
        }),
      visCheckExtension(() => ({ visOn, queued, writable: () => true })),
    ],
  });
  await resourceLoader.reload();
  const sessionManager = pi.SessionManager.inMemory(cwd);
  const { session } = await pi.createAgentSession({ cwd, agentDir, resourceLoader, settingsManager: pi.SettingsManager.inMemory(), sessionManager });
  await session.bindExtensions({ mode: "rpc" });
  const model = session.modelRuntime.getModel("scripted", "scripted-1");
  assert.ok(model);
  await session.setModel(model);
  return { session, sessionManager, requests };
}

const hidden = (sm: { getBranch(): any[] }) => sm.getBranch().filter((e) => e.type === "custom_message" && e.customType === VIS_RETRY_MESSAGE);
const replies = (sm: { getBranch(): any[] }) => sm.getBranch().filter((e) => e.type === "message" && e.message.role === "assistant");

test("SDK: a broken block costs one more request carrying the note, and the fix is not checked again", async () => {
  const { session, sessionManager, requests } = await scriptedSession([`Here:\n\n${fence("flow", BROKEN_FLOW)}`, `Fixed:\n\n${fence("flow", BROKEN_FLOW)}`, "never"], () => true);
  try {
    await session.prompt("draw it");
    assert.equal(requests.length, 2, "exactly one continuation, even though its block is still broken");
    assert.equal(replies(sessionManager).length, 2);
    const notes = hidden(sessionManager);
    assert.equal(notes.length, 1);
    assert.equal(notes[0].display, false);
    assert.match(JSON.stringify(requests[1]), /Sova could not draw one vis block/, "the continuation carried the note");
    assert.deepEqual(sessionManager.getBranch().flatMap((e) => normalizeEntry(e as never)).filter((i) => /could not draw/.test(i.text ?? "")), [], "no transcript row shows it");
    // A new user reply gets its own retry.
    const before = requests.length;
    await session.prompt("again");
    assert.equal(requests.length, before + 1, "'never' is a clean reply: nothing to retry");
  } finally {
    session.dispose();
  }
});

test("SDK: vis off — no retry and no vis_check tool; vis on — the tool is in the loadout", async () => {
  let on = false;
  const { session, sessionManager, requests } = await scriptedSession([fence("flow", BROKEN_FLOW), fence("flow", BROKEN_FLOW)], () => on);
  try {
    assert.equal(session.getActiveToolNames().includes(VIS_CHECK_TOOL), false, "taken out at session_start");
    await session.prompt("draw it");
    assert.equal(requests.length, 1);
    assert.equal(hidden(sessionManager).length, 0);
    on = true;
    await session.prompt("draw it again");
    assert.equal(session.getActiveToolNames().includes(VIS_CHECK_TOOL), true, "added when the next run starts");
    assert.equal(requests.length, 3, "vis on: the broken reply got its retry");
  } finally {
    session.dispose();
  }
});

test("SDK: a message queued behind the run goes first, with no retry", async () => {
  const { session, sessionManager, requests } = await scriptedSession([fence("flow", BROKEN_FLOW)], () => true, () => true);
  try {
    await session.prompt("draw it");
    assert.equal(requests.length, 1);
    assert.equal(hidden(sessionManager).length, 0);
  } finally {
    session.dispose();
  }
});

test("SDK: vis_check runs as a tool", async () => {
  const { session } = await scriptedSession([], () => true);
  try {
    const tool = session.getToolDefinition(VIS_CHECK_TOOL);
    assert.ok(tool);
    const res = await tool.execute("c1", { kind: "svg", source: "<svg></svg>" }, undefined, undefined, undefined as never);
    assert.match((res.content[0] as { text: string }).text, /^OK: this vis svg block draws/);
    await assert.rejects(tool.execute("c2", { kind: "flow", source: "a -> b" } as never, undefined, undefined, undefined as never), /only html and svg/);
  } finally {
    session.dispose();
  }
});
