// Run: pnpm exec tsx --test server/session-share-privacy.test.ts. §app.session-share/never: a unique
// marker is planted in every field a session share must never carry (thinking, tool calls and their
// arguments, tool results and their details, `!` commands, system and custom messages, subagent
// reports, compactions and branch summaries, model ids and usage costs, the session id, path and
// cwd, the home directory, /tmp and attachment paths, a known secret and a secret-shaped string, a
// non-raster image, an abandoned branch, what came after a snapshot's cut, a wake nudge and a link
// partner's message), each first shown to be really in the operator's own transcript (the positive
// control), then asserted absent from the view (both modes, every page), every image the route
// serves, and, through the share listener, the shell, every /api/s answer and the socket frames.
// §app.session-share/slice: a slice's text, image and vis source before its start, what came after
// its end, and every entry id never reach a recipient, in either mode. A throwaway
// PI_CODING_AGENT_DIR in the OS temp dir, deleted after; no model is called.
// The share listener's answers (the shell, /api/s, the socket frames) and the text work's CPU time are session-share-privacy.integration.test.ts.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import type { SessionShareView } from "../shared/session-share";
import { formatLinkMessage } from "../shared/link-message";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-session-share-leak-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sessions"), { recursive: true });
/** A secret the server knows by value (a secret-named variable), before the redactor first reads. */
process.env.MK_SHARE_API_KEY = "mkSecretValue-q7x-4f9a2c71be";

/** A stub share page: the shell must carry nothing of the session either. */
process.env.SOVA_SHARE_DIST = join(root, "dist-share");
mkdirSync(process.env.SOVA_SHARE_DIST, { recursive: true });
writeFileSync(join(process.env.SOVA_SHARE_DIST, "index.html"), "<!doctype html><title>Shared</title>");

const { sessionShareView, sessionShareImage, currentLeaf, resetShareViewCache, SESSION_SHARE_TEXT_MAX, SESSION_SHARE_TEXT_CEILING, cutAtToken, withoutImagePaths } = await import("./session-share-view");
const { normalizeEntries, toolContents } = await import("./transcript");
const { parseLines } = await import("./harness/pi/reader");

after(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Every marker, by the field it sits in. Each is unique and in no ordinary word. */
const M = {
  thinking: "MK-THINK-q7x",
  thinkingSig: "MK-THINKSIG-q7x",
  toolName: "mk_tool_q7x",
  toolArg: "MK-TOOLARG-q7x",
  toolOut: "MK-TOOLOUT-q7x",
  toolDetails: "MK-TOOLDETAILS-q7x",
  bashCmd: "MK-BASHCMD-q7x",
  bashOut: "MK-BASHOUT-q7x",
  system: "MK-SYSTEM-q7x",
  // pi 0.86+'s system entry: the prompt in named sections, whole tool declarations (§app.baton/told).
  systemPreamble: "MK-PREAMBLE-q7x",
  systemToolName: "mk_systool_q7x",
  systemToolDescription: "MK-SYSTOOLDESC-q7x",
  customMsg: "MK-CUSTOMMSG-q7x",
  report: "MK-REPORT-q7x",
  custom: "MK-CUSTOM-q7x",
  compaction: "MK-COMPACT-q7x",
  branchSummary: "MK-BRANCHSUM-q7x",
  provider: "mkprov-q7x",
  model: "mk-model-q7x",
  cost: "0.987654321",
  sessionName: "MK-SESSIONNAME-q7x",
  label: "MK-LABEL-q7x",
  abandoned: "MK-ABANDONED-q7x",
  afterCut: "MK-AFTERCUT-q7x",
  wake: "MK-WAKE-q7x",
  link: "MK-LINKMSG-q7x",
  svg: "MK-SVG-q7x",
  errorMessage: "MK-ERRMSG-q7x",
  tmpPath: "/tmp/pi-clipboard-0f8e1c7a-3b2d-4e5f-9a6b-7c8d9e0f1a2b.png",
  attachmentPath: join(root, "agent", "sova", "attachments", "mk-sess-q7x", "sova-11111111-2222-4333-8444-555555555555.png"),
  secret: process.env.MK_SHARE_API_KEY,
  secretShape: "sk-ant-api03-MKq7x0123456789abcdef",
  bearer: "mkBearerq7x0123456789",
  // Image paths in code: inline, in an ordinary fence, in a vis drawing's source.
  tmpInline: "/tmp/pi-clipboard-aaaaaaaa-3b2d-4e5f-9a6b-7c8d9e0f1a2b.png",
  fencePath: join(root, "agent", "sova", "attachments", "mk-sess-q7x", "sova-66666666-2222-4333-8444-555555555555.png"),
  visPath: "/tmp/pi-clipboard-bbbbbbbb-3b2d-4e5f-9a6b-7c8d9e0f1a2b.png",
  // An entry's timestamp as written: one no time at all, one a time with a tail.
  tsMarker: "MK-TS-q7x",
  tsBad: "2026-09-30T00:00:09.000Z MK-BADTS-q7x",
  // Image paths that cross an item's size cap: no cut may leave a prefix the scrubber can't see.
  capTmp: "MKCAPTMP-q7x",
  capAttachment: "MKCAPATT-q7x",
} as const;

const SESSION_ID = "0199aaaa-bbbb-7ccc-8ddd-q7xsessionid";
const home = homedir();
const cwd = join(home, "code", "mk-project-q7x");
const sessionPath = join(root, "agent", "sessions", `2026-09-30T00-00-00-000Z_${SESSION_ID}.jsonl`);
/** A 1×1 PNG. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

/** A non-raster image block: never counted, never served. */
const SVG_B64 = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><text>${M.svg}</text></svg>`).toString("base64");
/** Where each marker sits in the file and the transcript (the svg one only base64-encoded). */
const planted = (field: string, mark: string) => (field === "svg" ? SVG_B64 : mark);

const lines: Record<string, unknown>[] = [{ type: "session", version: 3, id: SESSION_ID, timestamp: "2026-09-30T00:00:00.000Z", cwd }];
let seq = 0;
let last: string | null = null;
const at = () => new Date(Date.UTC(2026, 8, 30, 0, 0, ++seq)).toISOString();
/** Append an entry parented on the last one (or on `parent`). Returns its id. */
const add = (entry: Record<string, unknown>, parent: string | null = last): string => {
  const id = `e${String(++seq).padStart(3, "0")}`;
  lines.push({ id, parentId: parent, timestamp: at(), ...entry });
  last = id;
  return id;
};
const user = (content: unknown) => add({ type: "message", message: { role: "user", content, timestamp: seq } });
const assistant = (content: unknown[], extra: Record<string, unknown> = {}) =>
  add({
    type: "message",
    message: {
      role: "assistant",
      content,
      provider: M.provider,
      model: M.model,
      api: "anthropic-messages",
      usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: Number(M.cost) } },
      stopReason: "stop",
      timestamp: seq,
      ...extra,
    },
  });

add({ type: "model_change", provider: M.provider, modelId: M.model });
add({ type: "thinking_level_change", thinkingLevel: "high" });
add({ type: "session_info", name: M.sessionName });
user([
  { type: "text", text: `VISIBLE-USER look at ${cwd}/src/app.ts and ${home}/notes.txt, key ${M.secret}, ${M.secretShape}, Authorization: Bearer ${M.bearer}\n\n${M.tmpPath} ${M.attachmentPath}` },
  { type: "image", data: PNG.toString("base64"), mimeType: "image/png" },
  { type: "image", data: SVG_B64, mimeType: "image/svg+xml" },
]);
const fork = assistant([
  { type: "thinking", thinking: M.thinking, thinkingSignature: M.thinkingSig },
  { type: "text", text: "VISIBLE-REPLY here is a drawing:\n\n```vis\n{\"kind\":\"steps\",\"steps\":[\"one\",\"two\"]}\n```" },
  { type: "toolCall", id: "call_1", name: M.toolName, arguments: { path: `${cwd}/x`, note: M.toolArg } },
]);
// An abandoned branch: a rewind left it behind.
add({ type: "message", message: { role: "user", content: [{ type: "text", text: M.abandoned }], timestamp: seq } }, fork);
last = fork;
add({ type: "message", message: { role: "toolResult", toolCallId: "call_1", toolName: M.toolName, content: [{ type: "text", text: M.toolOut }], details: { note: M.toolDetails }, isError: false, timestamp: seq } });
add({ type: "message", message: { role: "bashExecution", command: `echo ${M.bashCmd}`, output: M.bashOut, exitCode: 0, cancelled: false, truncated: false, timestamp: seq } });
add({ type: "message", message: { role: "system", content: [{ type: "text", text: M.system }], timestamp: seq } });
add({ type: "message", message: { role: "system", content: "", sections: { preamble: M.systemPreamble, cwd: "<cwd>(none)</cwd>" }, toolsAdded: [{ name: M.systemToolName, description: M.systemToolDescription, parameters: { type: "object" } }], toolsRemoved: [{ name: "read_link" }], timestamp: seq } });
add({ type: "custom_message", customType: "mk-ext", content: M.customMsg, display: true });
add({ type: "custom_message", customType: "subagent-report", content: `Report\n${M.report}`, display: true });
add({ type: "custom", customType: "worktrees", data: { note: M.custom } });
add({ type: "label", targetId: fork, label: M.label });
add({ type: "compaction", summary: M.compaction, firstKeptEntryId: fork, tokensBefore: 1234 });
add({ type: "branch_summary", fromId: fork, summary: M.branchSummary });
user([{ type: "text", text: formatLinkMessage({ linkId: "lk_0123456789abcdef", messageId: "lm_0123456789abcdef", fromTitle: "Partner", fromHost: "desk", fromSessionId: "0199-partner", text: M.link }) }]);
user([{ type: "text", text: `[wake_nudge n1] Scheduled wakeup fired (set 4m ago).\nReason: ${M.wake}\nContinue.` }]);
assistant([{ type: "text", text: "VISIBLE-SECOND reply" }], { stopReason: "error", errorMessage: M.errorMessage });
add({
  type: "message",
  timestamp: M.tsBad,
  message: {
    role: "assistant",
    content: [
      {
        type: "text",
        text: `VISIBLE-CODE see \`${M.tmpInline}\` and \`const kept = 1\`:\n\n\`\`\`sh\nfencedCodeKept ${M.fencePath}\n\`\`\`\n\n\`\`\`vis\n{"kind":"steps","steps":["${M.visPath}","visStepKept"]}\n\`\`\``,
      },
    ],
    stopReason: "stop",
    timestamp: seq,
  },
});
/** `path` placed so the item's cap falls inside it (its first `into` characters before the cap). */
const across = (path: string, into: number) => `${"w ".repeat((SESSION_SHARE_TEXT_MAX - into) / 2)}${path} tail`;
assistant([{ type: "text", text: across(`/tmp/${M.capTmp}-private-image.png`, 20) }]);
assistant([{ type: "text", text: across(`/${M.capAttachment}/sova/attachments/mk-sess-q7x/x.png`, 22) }]);
const cut = add({ type: "message", timestamp: M.tsMarker, message: { role: "user", content: [{ type: "text", text: "VISIBLE-LAST before the cut" }], timestamp: seq } });
assistant([{ type: "text", text: `Later: ${M.afterCut}` }]);
// A malformed record with no id (damaged or foreign-written): it must never widen the branch.
lines.push({ type: "custom", customType: "mk-noid", timestamp: at(), data: {} });
writeFileSync(sessionPath, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);

const src = (mode: "snapshot" | "live") => ({ sessionPath, cutEntryId: mode === "snapshot" ? cut : null, from: null, title: `A title with ${M.secret}`, sharedAt: "2026-09-30T01:00:00.000Z", mode });

/** Every page of a view, oldest first. */
async function everyPage(mode: "snapshot" | "live"): Promise<SessionShareView[]> {
  const out: SessionShareView[] = [];
  let before: number | undefined;
  do {
    const v = await sessionShareView(src(mode), before === undefined ? {} : { before });
    assert.ok(v, `${mode} view`);
    out.unshift(v);
    before = v.before;
  } while (before !== undefined);
  return out;
}

/** What must never leave the host, beyond the markers. */
const never = (): string[] => [SVG_B64, SESSION_ID, sessionPath, cwd, home, root, "thinking", "toolCall", "mimeType\":\"image/svg"];

describe("nothing private reaches a session share (§app.session-share/never)", () => {
  test("positive control: every marker is in the operator's own transcript or the session file", () => {
    const file = readFileSync(sessionPath, "utf8");
    // The operator's transcript: its rows, and every tool card's content as opening it loads it
    // (§chat.transcript/slim-rows).
    const rows = normalizeEntries(parseLines(file));
    const transcript = JSON.stringify([rows, toolContents(rows, rows.map((r) => r.id))]);
    for (const [field, m] of Object.entries(M)) {
      const mark = planted(field, m);
      assert.ok(file.includes(mark) || file.includes(JSON.stringify(mark).slice(1, -1)), `${field} was planted`);
      // A role:"system" message and extension state (`custom`) render no row of the operator's, and a
      // reasoning signature never reaches the operator's browser either (§chat.transcript/slim-rows);
      // the file holds them.
      if (!["system", "systemPreamble", "systemToolName", "systemToolDescription", "custom", "thinkingSig"].includes(field)) assert.ok(transcript.includes(mark), `${field} is in the operator's transcript`);
    }
    for (const s of [SESSION_ID, cwd, home]) assert.ok(file.includes(s), `${s} is in the session file`);
  });

  test("the view carries the conversation: user text, reply text with its vis fence, the raster image", async () => {
    for (const mode of ["snapshot", "live"] as const) {
      const body = JSON.stringify(await everyPage(mode));
      for (const seen of ["VISIBLE-USER", "VISIBLE-REPLY", "```vis", "VISIBLE-SECOND", "VISIBLE-LAST", "src/app.ts", "~/notes.txt", "[redacted]", "VISIBLE-CODE", "`const kept = 1`", "fencedCodeKept", "visStepKept"]) assert.ok(body.includes(seen), `${mode}: ${seen} shows`);
      const v = (await everyPage(mode)).at(-1)!;
      assert.equal(v.images, 1, `${mode}: only the raster image is counted`);
      assert.deepEqual(v.items[0]!.images, [{ n: 0, mime: "image/png" }]);
    }
    assert.ok(JSON.stringify(await everyPage("live")).includes(M.afterCut), "control: live mode shows what came after the cut");
  });

  test("no marker, id, path or excluded key in any page of either mode", async () => {
    for (const mode of ["snapshot", "live"] as const) {
      const pages = await everyPage(mode);
      for (const page of pages) {
        const body = JSON.stringify(page);
        for (const [field, mark] of Object.entries(M)) {
          if (mode === "live" && field === "afterCut") continue;
          assert.ok(!body.includes(mark), `${mode}: ${field} leaked`);
        }
        for (const s of never()) assert.ok(!body.includes(s), `${mode}: ${s} leaked`);
        const keys = new Set([...body.matchAll(/"([A-Za-z]+)":/g)].map((m) => m[1]!));
        for (const k of keys) assert.ok(["title", "sharedAt", "mode", "through", "items", "before", "images", "kind", "n", "text", "at", "mime", "lineage"].includes(k), `${mode}: unexpected key ${k}`);
      }
    }
  });

  test("the image route serves only the raster image, byte for byte", async () => {
    for (const mode of ["snapshot", "live"] as const) {
      const img = await sessionShareImage(src(mode), 0);
      assert.deepEqual(img, { mime: "image/png", bytes: PNG });
      for (const n of [1, 2, -1, 0.5, Number.NaN]) assert.equal(await sessionShareImage(src(mode), n), null, `${mode}: image ${n}`);
    }
  });

  test("a gone file or a cut no longer in it reads as nothing", async () => {
    assert.equal(await sessionShareView({ ...src("snapshot"), cutEntryId: "e-not-there" }), null);
    assert.equal(await sessionShareView({ ...src("live"), sessionPath: join(root, "nope.jsonl") }), null);
    resetShareViewCache();
    assert.deepEqual(await currentLeaf(sessionPath), { entryId: last, at: lines.find((l) => l.id === last)!.timestamp });
  });

  test("times go out only as canonical ISO times; a bad one is left out", async () => {
    for (const mode of ["snapshot", "live"] as const)
      for (const page of await everyPage(mode)) {
        const times = [page.through, ...page.items.map((i) => i.at)].filter((t) => t !== undefined && t !== null);
        for (const t of times) assert.equal(new Date(Date.parse(t!)).toISOString(), t, `${mode}: ${t}`);
        const code = page.items.find((i) => i.text.includes("VISIBLE-CODE"));
        if (code) assert.equal(code.at, undefined, `${mode}: a time with a tail is no time`);
      }
    const snap = (await everyPage("snapshot")).at(-1)!;
    assert.equal(snap.items.at(-1)!.at, undefined, "the cut's marker time is left out");
    assert.ok(snap.through && snap.through < "2026-09-30T00:01:00.000Z", "through is the newest valid time up to the cut");
  });

  test("the branch is chosen strictly: a broken chain reads as nothing, a genuine legacy file is linear", async () => {
    const write = (name: string, rows: Record<string, unknown>[]) => {
      const p = join(root, name);
      writeFileSync(p, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
      return p;
    };
    const msg = (role: string, text: string) => ({ type: "message", message: { role, content: [{ type: "text", text }] } });
    const forked = [lines[0]!, { id: "a", parentId: null, ...msg("user", "VISIBLE") }, { id: "x", parentId: "a", ...msg("user", M.abandoned) }, { id: "b", parentId: "a", ...msg("assistant", "VISIBLE_REPLY") }];
    for (const rows of [forked, [...forked, { type: "custom", customType: "mk-noid" }], [...forked.slice(0, 2), { type: "custom", customType: "mk-noid" }, ...forked.slice(2)]]) {
      const p = write("forked.jsonl", rows);
      resetShareViewCache();
      assert.deepEqual((await sessionShareView({ ...src("live"), sessionPath: p }))?.items.map((i) => i.text), ["VISIBLE", "VISIBLE_REPLY"], "Follow live: an id-less record never widens the branch");
    }
    const broken = write("broken.jsonl", [lines[0]!, { id: "a", parentId: null, ...msg("user", "hi") }, { id: "b", parentId: "missing", ...msg("assistant", "orphan") }]);
    assert.equal(await sessionShareView({ ...src("live"), sessionPath: broken }), null, "the leaf's chain doesn't reach the root");
    assert.equal(await currentLeaf(broken), null);
    const legacy = write("legacy.jsonl", [{ type: "session", id: "old", timestamp: "2024-01-01T00:00:00.000Z", cwd }, msg("user", "legacy-one"), msg("assistant", "legacy-two")]);
    const v = await sessionShareView({ ...src("live"), sessionPath: legacy });
    assert.deepEqual(v?.items.map((i) => i.text), ["legacy-one", "legacy-two"]);
    const mixedV1 = write("mixed-v1.jsonl", [{ type: "session", id: "old", cwd }, msg("user", "one"), { id: "x", parentId: null, ...msg("assistant", "two") }]);
    assert.deepEqual((await sessionShareView({ ...src("live"), sessionPath: mixedV1 }))?.items.map((i) => i.text), ["two"], "id-less records are ignored once any entry has an id");
  });
});

describe("the view's text work is linear: no recipient can make a read burn CPU", () => {
  // The adversarial reads, unmeasured: each reads, caps every item and leaves the scrubber; their
  // CPU time is session-share-privacy.integration.test.ts.
  const MB = 1024 * 1024;
  // Backtick runs of every length up to ~1400, none closed: a quadratic code-span matcher's worst case.
  const ticks = Array.from({ length: 1400 }, (_, i) => `${"`".repeat(i + 1)}a`).join("");
  const cases: [string, string][] = [
    ["one unbroken token", "x".repeat(MB)],
    ["path segments with the attachments tail at the end", `${"/a".repeat(MB / 2)}/sova/attachments/`],
    ["the attachments tail over and over", "/sova/attachments/".repeat(Math.floor(MB / 18))],
    ["a /tmp name that never ends in an image", `/tmp/${"a".repeat(MB)}`],
    ["/tmp/ over and over", "/tmp/".repeat(Math.floor(MB / 5))],
    ["unclosed backtick runs with a /tmp path", `/tmp/x.png ${ticks}`],
  ];
  for (const [name, text] of cases)
    test(`${name} (${Math.round(text.length / 1024)} KB) reads, capped, and the scrubber returns`, async () => {
      const p = join(root, "big.jsonl");
      const rows = [
        { type: "session", version: 3, id: "big", cwd },
        { id: "a", parentId: null, type: "message", message: { role: "user", content: [{ type: "text", text }] } },
        { id: "b", parentId: "a", type: "message", message: { role: "assistant", content: [{ type: "text", text }] } },
      ];
      writeFileSync(p, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
      resetShareViewCache();
      const v = await sessionShareView({ ...src("live"), sessionPath: p });
      assert.ok(v, "it reads (an item that is only a path is left out)");
      for (const it of v.items) assert.ok(it.text.length <= SESSION_SHARE_TEXT_MAX + 1, "each item's text is capped");
      // The scrubber itself, under no cap.
      assert.equal(typeof withoutImagePaths(text), "string");
    });

  test("a path crossing the read ceiling leaves nothing, even when the scrub shrinks the text below the cap", async () => {
    const filler = "/tmp/p.png ".repeat(Math.ceil(SESSION_SHARE_TEXT_CEILING / 11));
    const text = `${filler.slice(0, SESSION_SHARE_TEXT_CEILING - 12)}/tmp/MKCEIL-q7x-private.png and more`;
    const p = join(root, "ceiling.jsonl");
    const rows = [{ type: "session", version: 3, id: "c", cwd }, { id: "a", parentId: null, type: "message", message: { role: "assistant", content: [{ type: "text", text }] } }];
    writeFileSync(p, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
    resetShareViewCache();
    const body = JSON.stringify(await sessionShareView({ ...src("live"), sessionPath: p }));
    assert.ok(!body.includes("MKCEIL"), body.slice(-200));
    assert.equal(cutAtToken("keep /tmp/MKCUT-q7x.png", 15), "keep…");
    assert.equal(cutAtToken(`${"a".repeat(20)}`, 10), "…", "a token longer than the cut goes whole");
  });

  test("the scrubber still finds every path: prose removed, code and vis source stood in for", () => {
    assert.equal(withoutImagePaths("see /tmp/pi-clipboard-0f8e1c7a-3b2d-4e5f-9a6b-7c8d9e0f1a2b.png now"), "see now");
    assert.equal(withoutImagePaths("`/tmp/a.png` and (~/.pi/agent/sova/attachments/s1/x.png)"), "`[image]` and ([image])");
    assert.equal(withoutImagePaths('{"s":["/x/sova/attachments/s/y.png","kept"]}'), '{"s":["[image]","kept"]}');
    assert.equal(withoutImagePaths("docs/tmp/notes.md and /tmp/notes.txt stay"), "docs/tmp/notes.md and /tmp/notes.txt stay");
    assert.equal(withoutImagePaths("x sova-11111111-2222-4333-8444-555555555555.png"), "x [image]");
  });
});

describe("the view's code builds field by field", () => {
  const text = readFileSync(resolve(import.meta.dirname, "session-share-view.ts"), "utf8");
  test("never spreads an entry, a message or a block, and never uses the transcript's row builder", () => {
    assert.doesNotMatch(text, /\.\.\.(e|m|b|entry|message|block|msg|content)\b(?![.(\[])/);
    assert.doesNotMatch(text, /\bnormalizeEntr(y|ies)\b|\.raw\b/);
  });
});
