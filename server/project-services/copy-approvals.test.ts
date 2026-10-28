// The Overseers' copy acts on the user's word or behind a click (§app.overseer/copies, §app.project-services/callers):
// outside a turn the user started, teardown and reset of a copy the caller did not start, and down of a copy with share
// links, run only when the turn's click approved that verb on that copy; in a turn the user started, down of any copy
// runs, and so do teardown and reset once the conversation that started the copy is not working; slot 0 never; a plain
// stop and a session's rules unchanged. On a host in memory (fake-host.ts), a
// temp PI_CODING_AGENT_DIR, the preview address pinned by env.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { isVerbResult, type VerbResult } from "../../shared/project-contract";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "sova-copyok-agent-"));
process.env.SOVA_SHARE_PREVIEW_URL = "https://*.preview.example.invalid";

const { FakeHost } = await import("./fake-host");
const { ProjectEngine } = await import("./engine");
type Caller = import("./engine").Caller;
const { readRegistry } = await import("./store");
const { linksOf } = await import("./share");
const { mutateRegistry } = await import("./store");

const op: Caller = { kind: "operator" };
const BASE = 23_000;
const DEF = {
  version: 1,
  services: { web: { cmd: ["node", "web.mjs"], ports: { http: { base: BASE } } } },
  share: { endpoints: ["web.http"] },
};

let parent = "";
let project = "";
const engine = new ProjectEngine(new FakeHost().deps({ projectIdOf: async () => "prj_copyok" }));
const git = (args: string[], cwd = project) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
const shaped = (r: VerbResult) => {
  assert.ok(isVerbResult(r), `result shape: ${JSON.stringify(r).slice(0, 400)}`);
  return r;
};

/** A caller whose turn's click approved exactly `ok` ("teardown:<id>", …). */
const approving = (ok: string[]) => (verb: string, rec: { id: string }) => ok.includes(`${verb}:${rec.id}`);
const overseer = (ok: string[] = []): Caller => ({ kind: "overseer", id: "ov", approved: approving(ok) });
const acts: string[] = [];
const po = (ok: string[] = [], root = project): Caller => ({ kind: "project-overseer", id: "po", root, act: async (verb, instance) => void acts.push(`${verb}:${instance}`), approved: approving(ok) });
/** The same callers in a turn the user started; `working`: the starting conversations working now (absent: no lookup). */
const working = (ids: string[]) => async (sid: string) => ids.includes(sid);
const overseerWord = (o: { ok?: string[]; busy?: string[] | null } = {}): Caller => ({
  kind: "overseer",
  id: "ov",
  approved: approving(o.ok ?? []),
  word: () => true,
  ...(o.busy === null ? {} : { working: working(o.busy ?? []) }),
});
const poWord = (busy: string[] = []): Caller => ({ ...(po() as Extract<Caller, { kind: "project-overseer" }>), word: () => true, working: working(busy) });
/** Say a copy was started by conversation `sid`. */
const startedBy = (id: string, sid: string) => mutateRegistry((r) => void (r.instances.find((i) => i.id === id)!.createdBy = `session:${sid}`));

before(() => {
  parent = realpathSync(mkdtempSync(join(tmpdir(), "sova-copyok-proj-")));
  project = join(parent, "demo");
  mkdirSync(join(project, ".sova"), { recursive: true });
  writeFileSync(join(project, "web.mjs"), "");
  writeFileSync(join(project, ".sova", "project.json"), JSON.stringify(DEF, null, 2));
  git(["init", "-q", "-b", "main"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "fixture"]);
});

after(async () => {
  for (const i of readRegistry().instances) if (i.slot !== 0) await engine.run("teardown", { instance: i.id, confirm: true }, op);
  rmSync(parent, { recursive: true, force: true });
  rmSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true, force: true });
});

let a: VerbResult;

test("teardown and reset of a copy it did not start: refused with the card sentence, run when the click approved that verb", async () => {
  a = shaped(await engine.run("up", { project, branch: "sova/a" }, op));
  assert.equal(a.ok, true, JSON.stringify(a.error));
  const id = a.instance!;
  const t = shaped(await engine.run("teardown", { instance: id }, overseer()));
  assert.equal(t.error?.code, "needs-confirm");
  assert.match(t.error!.message, /^teardown of a copy you did not start \(operator's\) runs only on the user's word, in a turn they started: ask them/);
  // A click that approved a reset approves no teardown, and one for another copy approves nothing here.
  assert.equal((await engine.run("teardown", { instance: id }, overseer([`reset:${id}`, "teardown:other-copy"]))).error?.code, "needs-confirm");
  const r = shaped(await engine.run("reset", { instance: id }, overseer([`reset:${id}`])));
  assert.equal(r.ok, true, JSON.stringify(r.error));
  // The project overseer: the same rule in its own project, and its statechart's act still sent.
  acts.length = 0;
  assert.equal((await engine.run("reset", { instance: id }, po())).error?.code, "needs-confirm");
  assert.deepEqual(acts, [], "refused before its act");
  const pr = shaped(await engine.run("reset", { instance: id }, po([`reset:${id}`])));
  assert.equal(pr.ok, true, JSON.stringify(pr.error));
  assert.deepEqual(acts, [`reset:${id}`]);
  // Never another project's copy, approved or not.
  assert.equal((await engine.run("reset", { instance: id }, po([`reset:${id}`], "/elsewhere"))).error?.code, "forbidden");
});

test("a plain stop of a copy without links needs no click; a session's rules are unchanged", async () => {
  const id = a.instance!;
  const d = shaped(await engine.run("down", { instance: id }, overseer()));
  assert.equal(d.ok, true, JSON.stringify(d.error));
  assert.equal(shaped(await engine.run("up", { instance: id }, overseer())).ok, true);
  // A session that did not create it: the operator's, as before; an approval hook is no session's.
  const s = shaped(await engine.run("teardown", { instance: id }, { kind: "session", id: "s1", root: project, own: [a.checkout!] }));
  assert.equal(s.error?.code, "needs-confirm");
  assert.match(s.error!.message, /did not create is the operator's/);
});

test("down and teardown of a copy with share links: refused without the click, run with it (its links counted on the card)", async () => {
  const id = a.instance!;
  const sh = shaped(await engine.run("share", { instance: id, endpoint: "web.http", confirm: true }, op));
  assert.equal(sh.ok, true, JSON.stringify(sh.error));
  assert.equal(linksOf(id, { activeOnly: true }).length, 1);
  const no = shaped(await engine.run("down", { instance: id }, overseer()));
  assert.equal(no.error?.code, "needs-confirm");
  assert.match(no.error!.message, /1 active share link.*only on the user's word, in a turn they started/);
  assert.equal((await engine.run("down", { instance: id }, po())).error?.code, "needs-confirm");
  // A teardown approval is no stop approval.
  assert.equal((await engine.run("down", { instance: id }, overseer([`teardown:${id}`]))).error?.code, "needs-confirm");
  const ok = shaped(await engine.run("down", { instance: id }, overseer([`down:${id}`])));
  assert.equal(ok.ok, true, JSON.stringify(ok.error));
  assert.equal(linksOf(id, { activeOnly: true }).length, 1, "its links stay through down");
  // Teardown with the click: it ends its links as always.
  const t = shaped(await engine.run("teardown", { instance: id }, overseer([`teardown:${id}`])));
  assert.equal(t.ok, true, JSON.stringify(t.error));
  assert.equal(linksOf(id, { activeOnly: true }).length, 0);
  assert.equal(readRegistry().instances.some((i) => i.id === id), false);
});

test("on the user's word: down of a linked copy runs, its links kept; teardown and reset once the starting conversation is not working", async () => {
  const d = shaped(await engine.run("up", { project, branch: "sova/d" }, op));
  assert.equal(d.ok, true, JSON.stringify(d.error));
  const id = d.instance!;
  assert.equal(shaped(await engine.run("share", { instance: id, endpoint: "web.http", confirm: true }, op)).ok, true);
  // Down of a copy with a share link: the word is enough (no click); its link stays and the copy comes back up.
  const down = shaped(await engine.run("down", { instance: id }, overseerWord()));
  assert.equal(down.ok, true, JSON.stringify(down.error));
  assert.equal(linksOf(id, { activeOnly: true }).length, 1, "its links stay through down");
  acts.length = 0;
  assert.equal(shaped(await engine.run("up", { instance: id }, op)).ok, true);
  const pdown = shaped(await engine.run("down", { instance: id }, poWord()));
  assert.equal(pdown.ok, true, JSON.stringify(pdown.error));
  assert.deepEqual(acts, [`down:${id}`], "the project overseer's act is still sent");
  // Started by a conversation that is still working: the word is not enough, a click is.
  startedBy(id, "s-busy");
  const busy = shaped(await engine.run("reset", { instance: id }, overseerWord({ busy: ["s-busy"] })));
  assert.equal(busy.error?.code, "needs-confirm");
  assert.match(busy.error!.message, /^reset of a copy you did not start \(session:s-busy's\) runs only in the turn the user's click on a card listing it opens.*\(its conversation is still working\)$/);
  assert.equal((await engine.run("reset", { instance: id }, poWord(["s-busy"]))).error?.code, "needs-confirm");
  // No way to tell whether it works: as if it did.
  assert.equal((await engine.run("reset", { instance: id }, overseerWord({ busy: null }))).error?.code, "needs-confirm");
  const clicked = shaped(await engine.run("reset", { instance: id }, overseerWord({ ok: [`reset:${id}`], busy: ["s-busy"] })));
  assert.equal(clicked.ok, true, JSON.stringify(clicked.error));
  // Not working (finished or archived): the word is enough; outside a turn the user started it is not.
  assert.equal((await engine.run("reset", { instance: id }, overseer())).error?.code, "needs-confirm");
  const reset = shaped(await engine.run("reset", { instance: id }, poWord()));
  assert.equal(reset.ok, true, JSON.stringify(reset.error));
  const t = shaped(await engine.run("teardown", { instance: id }, overseerWord()));
  assert.equal(t.ok, true, JSON.stringify(t.error));
  assert.equal(linksOf(id, { activeOnly: true }).length, 0, "teardown ends its links");
  assert.equal(readRegistry().instances.some((i) => i.id === id), false);
  // A copy no conversation started (the operator's): the word is enough, with no lookup at all.
  const e = shaped(await engine.run("create", { project, branch: "sova/e" }, op));
  assert.equal(shaped(await engine.run("teardown", { instance: e.instance }, overseerWord({ busy: null }))).ok, true);
});

test("slot 0 is never approved, whatever the click said", async () => {
  const main = shaped(await engine.run("create", { project }, op));
  assert.equal(main.ok, true, JSON.stringify(main.error));
  assert.equal(main.slot, 0);
  const all = (v: string) => ["teardown", "reset", "down"].map((x) => `${x}:${v}`);
  assert.equal((await engine.run("reset", { instance: main.instance }, overseer(all(main.instance!)))).error?.code, "needs-confirm");
  assert.equal((await engine.run("teardown", { instance: main.instance }, overseer(all(main.instance!)))).error?.code, "needs-confirm", "the click approves no slot 0, before teardown's own refusal");
  assert.equal((await engine.run("reset", { instance: main.instance }, overseerWord({ ok: all(main.instance!) }))).error?.code, "needs-confirm", "nor does the user's word");
  assert.equal((await engine.run("teardown", { instance: main.instance, confirm: true }, op)).error?.code, "refused-slot0", "and slot 0 is no one's to tear down");
  assert.ok(readRegistry().instances.some((i) => i.id === main.instance), "the main copy stays");
});

test("teardown of a copy whose folder has uncommitted edits keeps them; one whose folder is gone tears down too", async () => {
  const b = shaped(await engine.run("create", { project, branch: "sova/b" }, op));
  assert.equal(b.ok, true, JSON.stringify(b.error));
  writeFileSync(join(b.checkout!, "wip.txt"), "unsaved work");
  const t = shaped(await engine.run("teardown", { instance: b.instance }, overseer([`teardown:${b.instance}`])));
  assert.equal(t.ok, true, JSON.stringify(t.error));
  const step = t.steps.find((s) => s.id === "worktree")!;
  assert.equal(step.result, "skipped", JSON.stringify(t.steps));
  assert.match(step.detail ?? "", /kept/);
  assert.ok(existsSync(join(b.checkout!, "wip.txt")), "the edits stay in their folder");
  const c = shaped(await engine.run("create", { project, branch: "sova/c" }, op));
  assert.equal(c.ok, true, JSON.stringify(c.error));
  rmSync(c.checkout!, { recursive: true, force: true });
  const gone = shaped(await engine.run("teardown", { instance: c.instance }, overseer([`teardown:${c.instance}`])));
  assert.equal(gone.ok, true, JSON.stringify(gone.error));
  assert.equal(readRegistry().instances.some((i) => i.id === c.instance), false, "its slot is freed");
});
