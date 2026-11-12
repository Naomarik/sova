import assert from "node:assert/strict";
import { test } from "node:test";
import type { ArchiveCopy } from "../../shared/projects";
import { ADOPTED_ARCHIVE_LINE, afterStops, archivedRunningLine, archiveUnavailable, blockingCopies, copiesLead, copyKey, copyStateWord, runsLine, stopLabel, stoppableCopies } from "./archive-copies";

const copy = (name: string, extra: Partial<ArchiveCopy> = {}): ArchiveCopy => ({
  instance: `p:${name}`,
  name,
  branch: name,
  checkout: `/p/${name}`,
  slot: 1,
  services: [{ name: "web", state: "running" }],
  adopted: false,
  down: { instance: `p:${name}`, confirm: true },
  ...extra,
});
const adopted = copy("Main copy", { slot: 0, adopted: true, down: null, services: [{ name: "web", state: "running", adopted: true }] });
const shared = copy("Shared services", { instance: null, branch: null, checkout: null, slot: null, services: [{ name: "db", state: "running" }], down: { instance: "p:a", services: ["db"], confirm: true } });

test("an adopted main is listed but never blocks archiving, nor is it stopped", () => {
  const feat = copy("feat-x");
  assert.deepEqual(blockingCopies([adopted, feat]), [feat]);
  assert.deepEqual(stoppableCopies([adopted, feat]), [feat]);
  assert.equal(archiveUnavailable([adopted]), null);
  assert.equal(archiveUnavailable([adopted, feat]), "Stop the running copy first");
  assert.equal(archiveUnavailable([feat, copy("b")]), "Stop the 2 running copies first");
  assert.equal(archiveUnavailable(undefined), "Reading what runs");
  assert.equal(archiveUnavailable([]), null);
  assert.equal(ADOPTED_ARCHIVE_LINE, "Runs outside Sova; stop it yourself.");
});

test("a copy Sova can't stop still blocks, and Stop Running Copies skips it", () => {
  const stuck = copy("x", { down: null, why: "No copy to stop it through." });
  assert.deepEqual(blockingCopies([stuck]), [stuck]);
  assert.deepEqual(stoppableCopies([stuck]), []);
});

test("the lead speaks of what blocks only", () => {
  assert.equal(copiesLead([]), null);
  assert.equal(copiesLead([adopted]), null);
  assert.equal(copiesLead([copy("a")]), "This still runs. Stop it to archive the project; its data stays.");
  assert.equal(copiesLead([copy("a"), copy("b"), adopted]), "These still run. Stop them to archive the project; their data stays.");
});

test("a copy with a service waiting to restart reads as Restarting; what it runs is its services", () => {
  assert.deepEqual(copyStateWord(copy("a")), { word: "Running", tone: "success" });
  assert.deepEqual(copyStateWord(copy("a", { services: [{ name: "web", state: "starting" }] })), { word: "Starting", tone: "info" });
  assert.deepEqual(copyStateWord(copy("a", { services: [{ name: "web", state: "running" }, { name: "worker", state: "restarting" }] })), { word: "Restarting", tone: "warn" });
  assert.equal(runsLine(copy("a", { services: [{ name: "web", state: "running" }, { name: "worker", state: "restarting" }] })), "web, worker");
});

test("Stop Running Copies counts its progress", () => {
  assert.equal(stopLabel(null), "Stop Running Copies");
  assert.equal(stopLabel({ done: 0, of: 2 }), "Stopping 1 of 2…");
  assert.equal(stopLabel({ done: 2, of: 2 }), "Stopping 2 of 2…");
});

test("a failed stop's sentence stays only while its copy is listed", () => {
  const a = copy("a");
  assert.equal(copyKey(shared), "shared");
  assert.deepEqual(afterStops([a], { [copyKey(a)]: "Couldn't stop.", "p:gone": "x" }), { "p:a": "Couldn't stop." });
});

test("the archived banner names what was left running", () => {
  assert.equal(archivedRunningLine([]), null);
  assert.equal(archivedRunningLine([adopted]), null);
  assert.equal(archivedRunningLine([copy("a")]), "1 copy of it still runs. Stop it on Branches.");
  assert.equal(archivedRunningLine([copy("a"), copy("b")]), "2 copies of it still run. Stop them on Branches.");
  assert.equal(archivedRunningLine([copy("a"), shared]), "1 copy and its shared services still run. Stop them on Branches.");
  assert.equal(archivedRunningLine([shared]), "Its shared services still run. Stop them on Branches.");
});
