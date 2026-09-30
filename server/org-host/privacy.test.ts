// Run: pnpm exec tsx --test server/org-host/privacy.test.ts. The contact marker test (design §5.5
// Privacy), end to end on the shipped person chart: a contact value planted at start and changed by a
// person/edit reaches no log segment, no log read and no journal's rows; the snapshot is the only
// portable place that holds it. The same for what a log replay needs (r9): spawn data, a host start's
// data, a set-state's patch and an invocation's report. Plus the scrub rules for nested paths and
// field-change records.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { EngineOptions } from "../org-charts";
import { OrgHost } from "./index";
import { DEFAULT_REDACT, scrub, scrubChanged } from "./log";
import { HOST_CHARTS } from "./test-chart";

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
  // a build's start prompt (free text the operator or an overseer wrote) is a digest in the log
  assert.deepEqual(scrub({ prompt: "a" }, DEFAULT_REDACT), { prompt: { sha: "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb", len: 1 } });
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

test("what a log replay needs (r9) is redacted like the rest: spawn data, a start's data and envelope, a set-state patch (contact included), a report, a plain row", async () => {
  const root = mkdtempSync(join(tmpdir(), "org-host-privacy-"));
  dirs.push(root);
  const M = {
    spawnEmail: "spawn.marker@example.org",
    spawnPhone: "+1 555 0100 991",
    startEmail: "start.marker@example.org",
    startAbout: "START-ABOUT-MARKER likes tea",
    patchAbout: "PATCH-ABOUT-MARKER the About text",
    patchMessage: "PATCH-MESSAGE-MARKER what she wrote",
    patchEmail: "patch.marker@example.org",
    reportText: "REPORT-TEXT-MARKER the person's words",
    reportPhone: "+1 555 0100 992",
    startEnvelopeEmail: "start.envelope.marker@example.org",
    startEnvelopeMessage: "START-ENVELOPE-MESSAGE-MARKER",
    plainText: "PLAIN-TEXT-MARKER a note's words",
    plainEmail: "plain.marker@example.org",
  };
  const host = await OrgHost.open({ orgId: "o1", workspaceDir: join(root, "ws"), stateDir: join(root, "state"), durable: false, charts: HOST_CHARTS as unknown as EngineOptions["charts"] });
  host.invocations.register("sova/look", {
    start: (_inv, report) => void setTimeout(() => report("finished", undefined, { text: M.reportText, contact: { phone: M.reportPhone } }), 5),
    stop: () => {},
  });
  // spawn data: the shipped org chart spawns the person with its contact
  await host.start("org/o1", "org", { id: "o1", name: "Acme", slug: "acme", createdAt: 1 }, { by: "operator" });
  const added = await host.act("org/o1", "person/add", { personId: "p1", person: { name: "Ana Ruiz", contact: { email: M.spawnEmail, phone: M.spawnPhone } }, namesTaken: [] }, { by: "operator" });
  assert.equal(added.taken, true, added.refusal?.sentence);
  assert.equal((host.data("person/o1/p1")?.["contact"] as Record<string, string>)["email"], M.spawnEmail, "the person was spawned with it");
  // a host start's data, a set-state's patch and a look's report, on a project's session (so the feed shows them)
  // the start's envelope (its row's `envelope`) is scrubbed too, not only its data (`start`)
  await host.start("p/1", "host-probe", { projectId: "prj1", contact: { email: M.startEmail }, about: M.startAbout }, { by: "operator", contact: { email: M.startEnvelopeEmail }, message: M.startEnvelopeMessage } as never);
  const set = await host.setState("p/1", { states: ["timed"], patch: { about: M.patchAbout, message: M.patchMessage, contact: { email: M.patchEmail } }, reason: "stuck" }, { by: "overseer", attended: true });
  assert.equal(set.taken, true, set.refusal?.sentence);
  assert.equal(host.data("p/1")?.["about"], M.patchAbout, "the patch went in");
  await host.act("p/1", "tick", {}, { by: "operator" });
  await host.act("p/1", "look", {}, { by: "operator" });
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(host.configuration("p/1"), ["top", "idle"], "the report came back");
  // a plain row (logAct: a note) is scrubbed like a step's
  await host.logAct({ session: "p/1", event: "note/add", by: "operator", project: "prj1", envelope: { text: M.plainText, contact: { email: M.plainEmail } } });
  const rows = host.log.rows();
  assert.ok(rows.some((x) => x.event === "note/add" && x.plain), "the plain row is logged");
  assert.ok(rows.some((x) => x.event === "sova/started" && x.session === "p/1" && (x.envelope as Record<string, unknown>)["contact"] === "[contact]"), "the start's envelope is logged, scrubbed");
  assert.ok(rows.some((x) => x.event === "sova/started" && x.session === "person/o1/p1"), "the spawn is logged");
  assert.ok(rows.some((x) => x.event === "sova/started" && x.session === "p/1" && x.start), "a start's data is logged");
  assert.ok(rows.some((x) => x.event === "sova/set-state" && (x.envelope as Record<string, unknown>)["patch"]), "a patch is logged");
  assert.ok(rows.some((x) => x.event === "look/finished" && (x.envelope as Record<string, unknown>)["text"]), "a report's data is logged");
  const feed = host.feed("prj1", { includeQuiet: true });
  assert.ok(feed.length >= 3);
  await host.close();

  const logText = [...filesUnder(host.paths.portableLog), ...filesUnder(host.paths.localLog)].map((f) => readFileSync(f, "utf8")).join("\n");
  for (const [what, m] of Object.entries(M)) {
    assert.ok(!logText.includes(m), `${what} is not in any log segment`);
    assert.ok(!JSON.stringify(rows).includes(m), `${what} is not in a log read`);
    assert.ok(!JSON.stringify(feed).includes(m), `${what} is not in the project feed`);
  }
  assert.ok(logText.includes('"[contact]"') && logText.includes('"sha"'), "the values are there as markers and digests");
});
