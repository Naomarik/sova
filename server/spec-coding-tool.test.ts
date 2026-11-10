// The coding chats' `spec` tool: argv it spells, where its root may be, its remote refusal, its plain
// "no spec here", and the § reads the census counts. The spec tools themselves run in the integration sibling.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { StateView, ToolCtx } from "../shared/harness";
import { WORKTREES } from "./harness/state-kinds";
import { draftDir, NO_SPEC_HERE, REMOTE_REFUSAL, SPEC_CODING_TOOL, specAnswer, specArgs, specCodingTool, specRootFor, SpecToolRefusal } from "./spec-coding-tool";
import { setSpecToolForTest } from "./spec-runner";
import { targetsRoot } from "./targets";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "spec-tool-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  setSpecToolForTest(null);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tree = (path: string, status = "active") => ({ path, branch: "feat/x", base: "abc", baseBranch: "master", status, session: "s", how: "created", at: 1 });
function ctxOf(cwd: string, trees: ReturnType<typeof tree>[] = []): ToolCtx {
  const state = { latest: (k: unknown) => (k === WORKTREES && trees.length ? { data: { version: 1, trees } } : null) } as unknown as StateView;
  return { sessionId: "s", cwd, leafId: () => null, branch: () => [], state: () => state };
}

test("argv: each op spells the CLI's own command, flags in their command's form", () => {
  assert.deepEqual(specArgs({ op: "where", query: " password reset  email expiry " }), ["where", "password", "reset", "email", "expiry"]);
  assert.deepEqual(specArgs({ op: "map" }), ["map"]);
  assert.deepEqual(specArgs({ op: "map", query: "app" }), ["map", "app"]);
  assert.deepEqual(specArgs({ op: "toc", id: "§app/x" }), ["toc", "§app/x", "--dir", "out"]);
  assert.deepEqual(specArgs({ op: "toc", id: "§app/x", dir: "down" }), ["toc", "§app/x", "--dir", "down"]);
  assert.deepEqual(specArgs({ op: "read", id: "§app/x", whole: true, noFrame: true }), ["read", "§app/x", "--whole", "--no-frame"]);
  assert.deepEqual(specArgs({ op: "impact", id: "§app/x", near: true, cursor: "c1" }), ["impact", "§app/x", "--near", "--cursor", "c1"]);
  assert.deepEqual(specArgs({ op: "read", id: "§app/x", draft: "my-draft" }), ["read", "§app/x", "--spec", ".sova/spec/drafts/my-draft/spec"]);
  assert.throws(() => specArgs({ op: "read", id: "§app/x", draft: "../other/spec" }), /names one of the root's drafts/, "a draft is a name, never a path");
});

test("argv: a missing argument or a word posing as a flag is refused, never passed on", () => {
  assert.throws(() => specArgs({ op: "where" }), SpecToolRefusal);
  assert.throws(() => specArgs({ op: "read" }), /read needs id/);
  assert.throws(() => specArgs({ op: "where", query: "a --root /etc" }), /must not start with "-"/);
  assert.throws(() => specArgs({ op: "read", id: "--whole" }), /must not start/);
  assert.throws(() => specArgs({ op: "census" as never }), /Unknown op census/);
  assert.throws(() => draftDir(".hidden"), SpecToolRefusal);
  assert.equal(draftDir("sova-modes"), ".sova/spec/drafts/sova-modes/spec");
});

test("root: the session's cwd by default, and anything at or below it", async () => {
  const cwd = tmp();
  mkdirSync(join(cwd, "sub"));
  assert.equal(specRootFor(ctxOf(cwd), undefined), cwd);
  assert.equal(specRootFor(ctxOf(cwd), "sub"), join(cwd, "sub"));
  assert.equal(specRootFor(ctxOf(cwd), join(cwd, "sub")), join(cwd, "sub"));
});

test("root: outside the cwd and its active tracked worktrees is refused, naming where it may read", async () => {
  const cwd = tmp(), wt = tmp(), gone = tmp(), other = tmp();
  assert.throws(() => specRootFor(ctxOf(cwd), other), (e: Error) => e instanceof SpecToolRefusal && e.message.includes(cwd));
  assert.equal(specRootFor(ctxOf(cwd, [tree(wt)]), wt), wt, "an active tracked worktree");
  assert.throws(() => specRootFor(ctxOf(cwd, [tree(gone, "merged")]), gone), SpecToolRefusal, "a merged one no longer counts");
  assert.throws(() => specRootFor(ctxOf(cwd), join(cwd, "..")), SpecToolRefusal, ".. never climbs out");
  // A symlink inside the cwd is judged by where it leads.
  symlinkSync(other, join(cwd, "link"));
  assert.throws(() => specRootFor(ctxOf(cwd), join(cwd, "link")), SpecToolRefusal);
});

test("remote: a session on a target is refused, whatever the root", async () => {
  const cwd = join(targetsRoot(), "box", "srv", "app");
  assert.throws(() => specRootFor(ctxOf(cwd), undefined), (e: Error) => e.message === REMOTE_REFUSAL);
  let ran = false;
  setSpecToolForTest(async () => ((ran = true), {}));
  await assert.rejects(specCodingTool().execute("t", { op: "map" }, undefined, undefined, ctxOf(cwd)), /remote target/);
  assert.equal(ran, false, "nothing runs");
});

test("execute: runs the shared runner on the confined root with the call's argv; a project without a spec answers plainly", async () => {
  const cwd = tmp();
  const calls: [string, string[]][] = [];
  setSpecToolForTest(async (root, args) => (calls.push([root, args]), { tool: "sova-spec", command: "read", status: "done", id: "§a/b" }));
  const tool = specCodingTool();
  assert.equal(tool.name, SPEC_CODING_TOOL);
  const r = await tool.execute("t", { op: "read", id: "§a/b" }, undefined, undefined, ctxOf(cwd));
  assert.deepEqual(calls, [[cwd, ["read", "§a/b"]]]);
  assert.deepEqual(JSON.parse((r.content[0] as { text: string }).text), { tool: "sova-spec", command: "read", status: "done", id: "§a/b" });
  setSpecToolForTest(async () => ({ tool: "sova-spec", command: "read", exit: 2, status: "refused", code: "graph-untrusted", cause: "manifest-not-found" }));
  assert.equal(((await tool.execute("t", { op: "read", id: "§a/b" }, undefined, undefined, ctxOf(cwd))).content[0] as { text: string }).text, NO_SPEC_HERE);
  assert.equal(specAnswer({ findings: [{ code: "manifest-not-found" }], exit: 2 }), NO_SPEC_HERE, "the non-pull commands say it in a finding");
});

test("a root that doesn't exist is refused, saying so, and never reaches the spec tools; an existing folder with no spec still does", async () => {
  const cwd = tmp(), wt = tmp();
  mkdirSync(join(cwd, "bare"));
  writeFileSync(join(cwd, "a-file"), "");
  symlinkSync(join(cwd, "nowhere"), join(cwd, "dangling"));
  rmSync(wt, { recursive: true });
  const calls: string[] = [];
  // What the spec tools answer for any root with no manifest, an absent one included: the case to tell apart.
  setSpecToolForTest(async (root) => (calls.push(root), { exit: 2, status: "refused", code: "graph-untrusted", cause: "manifest-not-found" }));
  const tool = specCodingTool();
  const missing = (ctx: ToolCtx, root: string | undefined, path: string) =>
    assert.rejects(tool.execute("t", { op: "map", ...(root === undefined ? {} : { root }) }, undefined, undefined, ctx), (e: Error) => {
      assert.ok(e instanceof SpecToolRefusal, String(e));
      assert.ok(e.message.includes(path), e.message);
      assert.match(e.message, /does not exist/);
      assert.ok(!e.message.includes(NO_SPEC_HERE), e.message);
      return true;
    });
  await missing(ctxOf(cwd), ".cache/master", join(cwd, ".cache/master"));
  await missing(ctxOf(cwd), join(cwd, "gone"), join(cwd, "gone"));
  await missing(ctxOf(cwd), "dangling", join(cwd, "dangling"));
  await missing(ctxOf(cwd, [tree(wt)]), wt, wt);
  await missing(ctxOf(join(cwd, "removed")), undefined, join(cwd, "removed"));
  await assert.rejects(tool.execute("t", { op: "map", root: "a-file" }, undefined, undefined, ctxOf(cwd)), /not a folder/);
  assert.deepEqual(calls, [], "none of them ran the spec tools");
  // Confinement is judged first: a missing path outside the session's folders says what it always said.
  await assert.rejects(tool.execute("t", { op: "map", root: join(wt, "..", "elsewhere") }, undefined, undefined, ctxOf(cwd)), /outside this session's folder/);
  const bare = await tool.execute("t", { op: "map", root: "bare" }, undefined, undefined, ctxOf(cwd));
  assert.equal((bare.content[0] as { text: string }).text, NO_SPEC_HERE, "an existing folder with no spec keeps its answer");
  assert.deepEqual(calls, [join(cwd, "bare")]);
});
