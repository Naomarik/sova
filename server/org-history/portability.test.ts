// Run: node scripts/run-tests.mjs server/org-history/portability.test.ts. Portability
// over the workspace's own Git path: the commit carries history/events and history/rationale, never the
// host-local index or a crashed temp file; a clone opened on another state root keeps every event id
// and link, and its rebuilt index answers the same.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { commitAll, initRepo } from "../workspace-git";
import { OrgHistory } from "./service";
import { fixture } from "./test-fixture";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tracked = (repo: string): string[] => execFileSync("git", ["-C", repo, "ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);

test("committed, cloned and opened elsewhere: the same events, ids and links; nothing host-local travels", async () => {
  const root = mkdtempSync(join(tmpdir(), "org-history-port-"));
  dirs.push(root);
  const workspaceDir = join(root, "ws");
  mkdirSync(workspaceDir, { recursive: true });
  await initRepo(workspaceDir);
  const f = await fixture({ root, workspaceDir, stateDir: join(root, "state") });
  // a crashed temp file under history/ is swept at open, and ignored by the repo if it is still there
  const crashed = join(workspaceDir, "history", "rationale", `${f.ids["E6"]}.json.4242.tmp`);
  writeFileSync(crashed, "half a rationale");
  const reads = (h: OrgHistory) =>
    JSON.stringify([h.search({ role: "operator" }, {}), h.event({ role: "operator" }, f.ids["E6"]!), h.trace({ role: "operator" }, f.ids["E6"]!)]).replace(/"rebuiltAt":(null|\d+)/g, "");
  const here = reads(f.host.history);
  const out = await commitAll(workspaceDir, "test");
  assert.equal(out.committed, true, out.error);
  const files = tracked(workspaceDir);
  assert.ok(files.some((p) => /^history\/events\/\d{4}-\d{2}\.jsonl$/.test(p)), "the event segment is committed");
  assert.ok(files.includes(`history/rationale/${f.ids["E6"]}.json`), "a private rationale is committed");
  assert.ok(!files.some((p) => p.endsWith(".tmp")), "no temp file is committed");
  assert.ok(!files.some((p) => p.includes("index.json") || p.includes("org-history/") || p.includes("writer.json")), "the host-local index never travels");
  await f.host.close();

  const clone = join(root, "clone");
  execFileSync("git", ["clone", "-q", workspaceDir, clone]);
  const elsewhere = new OrgHistory("o1", clone, join(root, "state-2"), () => f.now.t);
  elsewhere.open();
  assert.equal(reads(elsewhere), here, "the clone's rebuilt index answers the same");
  assert.ok(existsSync(join(root, "state-2", "org-history", "o1", "index.json")));
  elsewhere.close();
  // a crashed temp file is swept when the history opens
  writeFileSync(join(clone, "history", "rationale", "x.json.1.tmp"), "torn");
  const again = new OrgHistory("o1", clone, join(root, "state-2"), () => f.now.t);
  again.open();
  assert.ok(!existsSync(join(clone, "history", "rationale", "x.json.1.tmp")));
  again.close();
});
