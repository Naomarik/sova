// Run: node scripts/run-tests.mjs server/org-history/attach.test.ts. Portability through the
// real path: an org's history, recorded through its host, committed by the workspace's own commit, cloned,
// and attached on a host with none of the old host-local state: the same event ids and links, a decision's
// recorded reason still there, and the index rebuilt under this host's state root. A throwaway agent dir and
// workspaces in the OS temp dir, deleted after.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { scratchRoot } from "../test-scratch";

const tmp = scratchRoot("sova-org-history-attach-");
process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
mkdirSync(join(tmp, "agent", "sessions"), { recursive: true });

const orgs = await import("../orgs");
const engine = await import("../org-engine");
const { commitAll, settled } = await import("../workspace-git");

after(async () => {
  for (const o of orgs.readIndex().orgs) await settled(o.dir);
  rmSync(tmp, { recursive: true, force: true });
});

const operator = { role: "operator" } as const;

test("committed, cloned and attached: the same events, ids, links and recorded reason; the index rebuilt here", async () => {
  const ws = join(tmp, "ws");
  const org = await orgs.createOrg({ name: "Gate", dir: ws });
  const host = engine.hostOf(org.id);
  const [request] = await host.record([
    { kind: "request.made", outcome: "done", projects: { primary: null }, actors: { initiatedBy: { kind: "operator" } }, source: { adapter: "test", version: 1, key: "attach:request" } },
  ]);
  const [decision] = await host.record([
    {
      kind: "decision.recorded",
      outcome: "deferred",
      projects: { primary: null },
      actors: { decidedBy: { kind: "person", id: "p1" } },
      source: { adapter: "test", version: 1, key: "attach:decision" },
      triggeredBy: [{ event: request!, via: "tool-call" }],
      decision: { disposition: "defer", options: [{ id: "bank", outcome: "deferred" }], authority: { kind: "person", id: "p1" } },
      rationale: { what: "Bank sync deferred", reason: { text: "The ledger export is not approved.", author: { kind: "person", id: "p1" }, contemporaneous: true } },
    },
  ]);
  const before = host.history.search(operator, {}).items.map((i) => i.id);
  assert.ok(before.includes(request!) && before.includes(decision!));
  const oldLocal = host.history.paths.local;
  assert.ok(existsSync(join(oldLocal, "index.json")));

  const out = await commitAll(ws, "test");
  assert.equal(out.committed, true, out.error);
  const clone = join(tmp, "clone");
  execFileSync("git", ["clone", "-q", ws, clone]);

  // this host forgets the org and everything host-local about it
  await orgs.detachOrg(org.id);
  rmSync(oldLocal, { recursive: true, force: true });

  const attached = await orgs.attachOrg({ dir: clone, confirm: true });
  assert.equal(attached.id, org.id);
  const h = engine.hostOf(org.id).history;
  assert.ok(existsSync(join(h.paths.local, "index.json")), "the index was rebuilt under this host's state root");
  assert.ok(h.paths.root.startsWith(clone), "read from the clone");
  assert.deepEqual(h.search(operator, {}).items.map((i) => i.id), before, "the same ids, in the same order");
  const d = h.event(operator, decision!)!;
  assert.deepEqual(d.record?.triggeredBy, [{ event: request, via: "tool-call" }], "its link");
  assert.equal(d.event.headline, "Bank sync deferred");
  assert.equal(d.rationale?.reason?.text, "The ledger export is not approved.", "the recorded reason travelled");
  assert.equal(d.event.reasonState, "recorded");
});
