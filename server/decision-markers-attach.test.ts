// Run: node scripts/run-tests.mjs server/decision-markers-attach.test.ts. A clone attached with a decision
// marker left without its decision: once this host holds the org, the decision is recovered, and it and its
// history event are committed in the same attach call (the workspace is clean), never left for the hourly
// commit. A throwaway agent dir and workspaces in the OS temp dir, deleted after.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { after, test } from "node:test";
import { BATON_DECISION_ENTRY } from "../shared/baton";
import { scratchRoot } from "./test-scratch";

const tmp = scratchRoot("sova-decision-markers-attach-");
process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
mkdirSync(join(tmp, "agent", "sessions"), { recursive: true });

const orgs = await import("./orgs");
const baton = await import("./baton");
const reconcile = await import("./reconcile");
const engine = await import("./org-engine");
const { commitAll, settled } = await import("./workspace-git");

after(async () => {
  for (const o of orgs.readIndex().orgs) await settled(o.dir);
  rmSync(tmp, { recursive: true, force: true });
});

const lastId = (file: string): string => JSON.parse(readFileSync(file, "utf8").trim().split("\n").at(-1)!).id;
const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });

test("attaching a clone with an orphan decision marker: the decision is recovered and committed at once", async () => {
  const ws = join(tmp, "ws");
  const org = await orgs.createOrg({ name: "Gate", dir: ws });
  mkdirSync(join(tmp, "client"));
  const project = await orgs.addProject(org.id, { name: "Portal", root: join(tmp, "client") });
  const maria = await orgs.addPerson(org.id, { name: "Maria Lopez", role: "Payroll" });
  const s = await baton.createBaton({ orgId: org.id, projectId: project.id, to: maria.id, publicTitle: "Payroll", goal: "g" });

  // Maria's message with its sender marker, then record_decision's marker, and nothing after it
  const ts = new Date().toISOString();
  appendFileSync(s.path, `${JSON.stringify({ type: "message", id: "u0000001", parentId: lastId(s.path), timestamp: ts, message: { role: "user", content: [{ type: "text", text: "Pay runs on the 25th." }] } })}\n`);
  appendFileSync(s.path, `${JSON.stringify({ type: "custom", customType: "sova-baton-sent", data: { v: 1, targetId: "u0000001", by: maria.id }, id: "s0000001", parentId: "u0000001", timestamp: ts })}\n`);
  appendFileSync(s.path, `${JSON.stringify({ type: "custom", customType: BATON_DECISION_ENTRY, data: { v: 1, area: "Payday", ownerArea: "none", statement: "Pay runs on the 25th.", quote: "Pay runs on the 25th.", by: maria.id, name: "Maria Lopez" }, id: "d0000001", parentId: "s0000001", timestamp: ts })}\n`);
  const rel = relative(ws, s.path);

  // the workspace as committed, pushed to a bare remote and cloned from it; this host lets the org go
  assert.equal((await commitAll(ws, "test")).committed, true);
  const remote = join(tmp, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", remote]);
  git(ws, "push", "-q", remote, "HEAD:refs/heads/main");
  git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
  const clone = join(tmp, "clone");
  execFileSync("git", ["clone", "-q", remote, clone]);
  await orgs.detachOrg(org.id);

  await orgs.attachOrg({ dir: clone });
  const id = `${s.sessionId}:d0000001`;
  const rows = reconcile.listDecisions(org.id, project.id).decisions.filter((d) => d.id === id);
  assert.equal(rows.length, 1, "recovered once");
  assert.equal(rows[0]!.by, maria.id);
  const events = () => engine.hostOf(org.id).history.search({ role: "operator" }, { kinds: ["decision.recorded"] }).items.length;
  assert.equal(events(), 1, "one history event");
  // committed in the attach call: clean once the workspace's writes settle, and still clean after an idle
  await settled(clone);
  assert.equal(git(clone, "status", "--porcelain"), "", "the recovered decision and its history are committed");
  await new Promise((r) => setTimeout(r, 1500));
  await settled(clone);
  assert.equal(git(clone, "status", "--porcelain"), "", "still clean after an idle");
  assert.equal(events(), 1);
  // and pushed: the remote's HEAD has the decision's statechart and its history event
  const tracked = git(remote, "ls-tree", "-r", "--name-only", "HEAD");
  assert.match(tracked, /^statecharts\/decision\//m, "the decision statechart is on the remote");
  assert.match(tracked, /^history\/rationale\/he_[0-9a-f]+\.json$/m, "its history rationale is on the remote");
  assert.ok(readFileSync(join(clone, rel), "utf8").includes("d0000001"));
});

test("attaching a clone with no orphan marker makes no extra commit", async () => {
  const ws = join(tmp, "ws2");
  const org = await orgs.createOrg({ name: "Plain", dir: ws });
  await commitAll(ws, "test"); // whatever the create left uncommitted, if anything
  await settled(ws);
  assert.equal(git(ws, "status", "--porcelain"), "");
  // cloned from a bare remote, as an attach is: never from the original workspace, which commits its own release
  // on detach after the clone and would leave the attach's push behind it
  const remote = join(tmp, "remote2.git");
  execFileSync("git", ["init", "-q", "--bare", remote]);
  git(ws, "push", "-q", remote, "HEAD:refs/heads/main");
  git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
  const clone = join(tmp, "clone2");
  execFileSync("git", ["clone", "-q", remote, clone]);
  await orgs.detachOrg(org.id);
  await orgs.attachOrg({ dir: clone });
  await settled(clone);
  assert.match(git(clone, "log", "-1", "--format=%s"), /^Attached on /);
  assert.equal(git(clone, "status", "--porcelain"), "");
});
