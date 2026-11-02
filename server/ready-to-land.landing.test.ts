// al_4 (§chat.worktrees/ready-to-land): spec drafts land with their branch, so they never keep a finished branch
// from Ready to land; Sova's try of the landing decides, and a Land It's drafts changing holds it. Driven through
// the published reading (configureReadiness seams), never by calling landingOf alone. Unit tier: no process runs
// here (docsPreview is a seam; previewOf is fed the draft tool's JSON as it prints it).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "sova-landing-readiness-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths

import type { SessionSummary, WorktreeStatus } from "../shared/protocol";
import type { GitResult } from "./worktrees";
const r = await import("./merge-readiness");
const { fileLandingStore } = await import("./ready-to-land");
type DocsPreview = import("./ready-to-land").DocsPreview;
const { draftsHash, draftsChanged } = await import("./spec-drafts-state");

const SID = "01a0eeee-e385-72b1-a202-737eb23ceb52";
let n = 0;
const id = () => `l${String(++n).padStart(7, "0")}`;
function sessionFile(lines: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), "sova-landing-s-"));
  const path = join(dir, `2026-10-26T00-00-00-000Z_${SID}.jsonl`);
  writeFileSync(path, `${[{ type: "session", version: 3, id: SID, timestamp: "2026-10-26T00:00:00.000Z", cwd: "/home/u/webapps/sova" }, ...lines].map((l) => JSON.stringify(l)).join("\n")}\n`);
  return path;
}
function chain(items: object[]): object[] {
  let parent: string | null = null;
  return items.map((it) => {
    const e = { ...it, id: id(), parentId: parent };
    parent = e.id;
    return e;
  });
}
const BRANCH = "feat/landing-docs";
const TREE = "/wt/landing-docs";
const worktrees = (at: string) => ({ type: "custom", customType: "worktrees", data: { version: 1, trees: [{ path: TREE, branch: BRANCH, base: "b0", baseBranch: "master", status: "active", session: SID, how: "created", at: 1 }] }, timestamp: at });
const assistant = (text: string, at: string) => ({ type: "message", timestamp: at, message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } });
const fakeGit = () => async (): Promise<GitResult> => ({ code: 1, stdout: "", stderr: "" });
const summary = (path: string): SessionSummary => ({ id: SID, path, cwd: "/home/u/webapps/sova", title: "t", createdAt: "", lastActiveAt: "2026-10-26T00:05:00.000Z", model: null, live: null, busy: false, origin: "web", archived: false });
const HEAD = "a".repeat(40);
const status = (head = HEAD): WorktreeStatus & { head?: string } => ({ path: TREE, source: "session", exists: true, branch: BRANCH, base: "master", merged: "no", ahead: 1, behind: 0, dirty: false, head });
const settle = async () => {
  await r.readinessIdle();
  for (let i = 0; i < 20; i++) await new Promise((done) => setTimeout(done, 1));
};

/** A finished session whose clean worktree has two drafts not yet official; `over` replaces any seam. */
function setUp(over: Partial<Parameters<typeof r.configureReadiness>[0]> = {}, finished: "yes" | "off" = "yes") {
  const path = sessionFile(chain([worktrees("2026-10-26T00:00:00.000Z"), assistant("Done, committed.", "2026-10-26T00:05:00.000Z")]));
  const sent: string[] = [];
  let now = 5_000_000 + n * 1000;
  r.configureReadiness({
    insights: { treeStatus: async () => status() },
    git: fakeGit(),
    asksUser: () => undefined,
    now: () => now,
    processStart: 0,
    landing: fileLandingStore(() => join(agentDir, `rtl-${n}.json`)),
    drafts: () => ["alpha", "beta"],
    draftsHash: () => ({ hash: "h".repeat(64), names: ["alpha", "beta"], each: { alpha: "1".repeat(64), beta: "2".repeat(64) } }),
    docsPreview: () => FITS,
    finished: () => finished,
    nudge: async (_p, text) => void sent.push(text),
    landingOffered: async () => true,
    ...over,
  });
  const row = summary(path);
  const read = async () => {
    r.readinessOverlay(row);
    await settle();
    const t = r.readinessReading(path);
    assert.ok(t.known);
    return t.value?.trees[0];
  };
  return { read, sent, tick: () => (now += r.READINESS_TTL_MS + 1) };
}
const FITS: DocsPreview = { drafts: ["alpha", "beta"], added: ["§x/new"], changed: ["§x/old"], problems: [] };

for (const mode of ["yes", "off"] as const) {
  test(`decisions ${mode === "yes" ? "on, the turn finished" : "off (code-only)"}: a clean branch with drafts that would land reads Ready to land with its docs, never Landing specs, and nobody is told to promote`, async () => {
    const s = setUp({}, mode);
    try {
      const t = await s.read();
      assert.equal(t?.landing?.state, "ready", JSON.stringify(t?.landing));
      assert.equal(t?.landing?.commit, HEAD);
      assert.deepEqual(t?.landing?.docs, { drafts: 2, added: 1, changed: 1, names: ["§x/new", "§x/old"] });
      assert.equal(t?.landing?.specsWhy, undefined);
      assert.deepEqual(s.sent, [], "no note: nothing to fix");
    } finally {
      r.resetReadiness();
    }
  });
}

test("the control: the same branch whose drafts wouldn't land reads Landing specs, and the session hears what doesn't fit once per head", async () => {
  const noNote = "§x/new (draft alpha): §x/new has no verification note from its chat";
  const s = setUp({ docsPreview: () => ({ ...FITS, problems: [noNote] }) });
  try {
    const t = await s.read();
    assert.equal(t?.landing?.state, "specs");
    assert.deepEqual(t?.landing?.docs?.problems, [noNote]);
    assert.equal(s.sent.length, 1);
    assert.ok(s.sent[0]!.includes(noNote), s.sent[0]);
    assert.doesNotMatch(s.sent[0]!, /Land It|promote/);
    s.tick();
    await s.read();
    assert.equal(s.sent.length, 1, "once per head");
  } finally {
    r.resetReadiness();
  }
});

test("not Ready to land until Sova has tried the drafts; its answer arriving reads the session again, and then it is", async () => {
  let done: (() => void) | undefined;
  let result: DocsPreview | "pending" = "pending";
  const calls: [string, string, string][] = [];
  const s = setUp({
    docsPreview: (dir, head, hash, cb) => {
      calls.push([dir, head, hash]);
      done = cb;
      return result;
    },
  });
  try {
    const first = await s.read();
    assert.equal(first?.landing, undefined, "pending: no landing yet");
    assert.deepEqual(calls[0], [TREE, HEAD, "h".repeat(64)], "tried at this head, keyed by the drafts' hash");
    result = FITS;
    done!();
    const after = await s.read();
    assert.equal(after?.landing?.state, "ready");
  } finally {
    r.resetReadiness();
  }
});

test("draftsChanged: per draft when the press kept each; every name when it didn't; added and removed drafts count", () => {
  const now = { hash: "n", names: ["a", "b", "c"], each: { a: "1", b: "2", c: "3" } };
  assert.deepEqual(draftsChanged({ hash: "n", names: ["a", "b", "c"] }, now), [], "the same hash: nothing");
  assert.deepEqual(draftsChanged({ hash: "o", names: ["a", "b"], each: { a: "1", b: "9" } }, now), ["b", "c"], "b changed, c is new");
  assert.deepEqual(draftsChanged({ hash: "o", names: ["a", "b"] }, now), ["a", "b", "c"], "an older press without each names every draft");
  assert.deepEqual(draftsChanged({ hash: "o", names: ["a", "z"], each: { a: "1", z: "5" } }, now), ["b", "c", "z"], "z was removed");
  assert.deepEqual(draftsChanged(undefined, now), []);
});

test("previewOf fails closed: the draft tool's refusal names each finding; no JSON is a problem, never a pass", async () => {
  const { previewOf } = await import("./merge-readiness");
  const ok = previewOf(JSON.stringify({ exit: 0, drafts: [{ name: "alpha", added: ["§x/new"], changed: [], removed: ["§x/gone"] }], findings: [] }));
  assert.deepEqual(ok, { drafts: ["alpha"], added: ["§x/new"], changed: ["§x/gone"], problems: [] });
  const refused = previewOf(JSON.stringify({ exit: 1, drafts: [], findings: [{ severity: "warn", draft: "alpha", id: "§x/new", code: "verification-missing", message: "§x/new has no verification note from its chat", fix: "…" }] }));
  assert.equal(refused.problems.length, 1);
  assert.ok(refused.problems[0]!.includes("§x/new") && refused.problems[0]!.includes("alpha"), refused.problems[0]);
  for (const out of ["", "not json", "{}"]) assert.equal(previewOf(out, new Error("killed")).problems.length, 1, `fails closed on ${JSON.stringify(out)}`);
  assert.equal(previewOf(JSON.stringify({ exit: 1, findings: [] })).problems.length, 1, "a refusal with no finding is still a problem");
});

test("the server's draftsHash is the definition: sha256 over sorted '<draft>/<path under spec/> <sha256>' lines, per draft too; draft.json and dot-dirs are out", () => {
  const dir = mkdtempSync(join(tmpdir(), "sova-landing-hash-"));
  const put = (rel: string, text: string) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); };
  assert.equal(draftsHash(dir), undefined, "no drafts");
  put(".sova/spec/drafts/one/spec/manifest.json", "{}\n");
  put(".sova/spec/drafts/one/spec/claims/a/b.md", "# §a/b\n");
  put(".sova/spec/drafts/one/draft.json", "{\"x\":1}\n");
  put(".sova/spec/drafts/two/spec/claims/c/d.md", "# §c/d\n");
  put(".sova/spec/drafts/.land/journal.json", "{}\n");
  const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
  const linesOf = (name: string) => {
    const out: string[] = [];
    const walk = (d: string, rel: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = rel ? `${rel}/${e.name}` : e.name; e.isDirectory() ? walk(join(d, e.name), p) : out.push(`${name}/${p} ${sha(readFileSync(join(d, e.name)))}`); } };
    walk(join(dir, ".sova/spec/drafts", name, "spec"), "");
    return out;
  };
  const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const h = (l: string[]) => sha([...l].sort(byCodePoint).join("\n"));
  const want = { hash: h([...linesOf("one"), ...linesOf("two")]), names: ["one", "two"], each: { one: h(linesOf("one")), two: h(linesOf("two")) } };
  assert.deepEqual(draftsHash(dir), want);
  put(".sova/spec/drafts/one/draft.json", "{\"x\":2}\n");
  assert.deepEqual(draftsHash(dir), want, "draft.json doesn't move it");
  put(".sova/spec/drafts/two/spec/claims/c/d.md", "# §c/d\n\nmore\n");
  const moved = draftsHash(dir)!;
  assert.notEqual(moved.hash, want.hash);
  assert.equal(moved.each.one, want.each.one, "one draft's change moves only its own hash");
  assert.notEqual(moved.each.two, want.each.two);
});
