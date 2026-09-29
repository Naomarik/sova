// Run: pnpm exec tsx --test server/org-host/privacy.test.ts. The contact marker test (design §5.5
// Privacy), end to end on the shipped person chart: a contact value planted at start and changed by a
// person/edit reaches no log segment, no log read and no journal's rows; the snapshot is the only
// portable place that holds it. Plus the scrub rules for nested paths and field-change records.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { OrgHost } from "./index";
import { DEFAULT_REDACT, scrub, scrubChanged } from "./log";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const OLD = "ana.marker.old@example.org";
const NEW = "ana.marker.new@example.org";
const PHONE = "+1 555 0100 777";

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

test("scrub: a redacted key anywhere in a path, and a field-change record's values", () => {
  const rules = { ...DEFAULT_REDACT, contact: "contact" as const };
  assert.deepEqual(scrubChanged({ "contact.email": [OLD, NEW] }, rules), { "contact.email": ["[contact]", "[contact]"] });
  assert.deepEqual(scrubChanged({ "about.text": ["a", "b"] }, rules)["about.text"], [
    { sha: "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb", len: 1 },
    { sha: "3e23e8160039594a33894f6564e1b1348bbd7a0088d42c4acb73eeaed59c009d", len: 1 },
  ]);
  assert.deepEqual(scrubChanged({ "links.0": ["t1", "t2"] }, rules)["links.0"], ["[dropped]", "[dropped]"]);
  assert.deepEqual(scrub({ changed: [{ field: "contact", from: { email: OLD }, to: { email: NEW } }] }, rules), {
    changed: [{ field: "contact", from: "[contact]", to: "[contact]" }],
  });
  assert.deepEqual(scrub({ person: { name: "Ana", contact: { phone: PHONE } } }, rules), { person: { name: "Ana", contact: "[contact]" } });
});

test("the contact marker: planted and changed through person/edit, it is in the snapshot and nowhere in the log", async () => {
  const root = mkdtempSync(join(tmpdir(), "org-host-privacy-"));
  dirs.push(root);
  const workspaceDir = join(root, "ws");
  const stateDir = join(root, "state");
  let crash = false;
  const host = await OrgHost.open({ orgId: "o1", workspaceDir, stateDir, durable: false, commitHooks: { afterJournal: () => { if (crash) throw new Error("killed"); } } });
  const person = { name: "Ana Ruiz", contact: { email: OLD }, status: "active", role: "Owner", decides: [], skills: [] };
  await host.start("person/o1/p1", "person", { orgId: "o1", id: "p1", person, changed: [{ field: "contact", from: null, to: { email: OLD } }], by: { kind: "operator" } }, { by: "operator" });
  const r = await host.act("person/o1/p1", "person/edit", { patch: { contact: { email: NEW, phone: PHONE } } }, { by: "operator" });
  assert.equal(r.taken, true, r.refusal?.sentence);
  assert.equal((host.data("person/o1/p1")?.["contact"] as Record<string, string>)["email"], NEW, "the edit went through");
  // a torn commit: its journal is left in the state root (host-local), with the rows scrubbed
  crash = true;
  assert.throws(() => host.actNow("person/o1/p1", "person/edit", { patch: { contact: { email: OLD } } }, { by: "operator" }), /killed/);
  await host.close();

  const markers = [OLD, NEW, PHONE];
  const logText = [...filesUnder(host.paths.portableLog), ...filesUnder(host.paths.localLog)].map((f) => readFileSync(f, "utf8")).join("\n");
  assert.ok(logText.length > 0);
  for (const m of markers) assert.ok(!logText.includes(m), `${m} is not in any log segment`);
  const reads = JSON.stringify(host.log.rows());
  for (const m of markers) assert.ok(!reads.includes(m), `${m} is not in a log read`);
  const journals = filesUnder(host.paths.journal);
  assert.equal(journals.length, 1, "the torn journal is there");
  for (const f of journals) {
    const j = JSON.parse(readFileSync(f, "utf8")) as { rows: unknown[] };
    const rows = JSON.stringify(j.rows);
    for (const m of markers) assert.ok(!rows.includes(m), `${m} is not in a journal's rows`);
  }
  assert.ok(!journals.some((f) => f.startsWith(workspaceDir)), "journals never live in the workspace repo");
  // in the repo, only the snapshot holds the value
  const repoFiles = filesUnder(workspaceDir);
  const holding = repoFiles.filter((f) => markers.some((m) => readFileSync(f, "utf8").includes(m)));
  assert.deepEqual(holding.map((f) => f.slice(workspaceDir.length + 1)), ["charts/person/person%2Fo1%2Fp1.edn"]);
});
