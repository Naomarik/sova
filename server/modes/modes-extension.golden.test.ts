// Run: pnpm test -- server/modes/modes-extension.golden.test.ts. The modes recordings (server/modes/tests/harness.fixture.ts) with the switch off
// (Settings → Experimental → "Sova runs chat modes"): the pi-config mode extension runs every mode, as at
// master, so each case must match its recording, a1's intended additions (the spec tool, two sentences) aside.
// The cases that run no program; those that do are in the .integration.test.ts beside it.
// SOVA_MODES_GOLDEN=record re-takes the recordings from here (take them from master's code: server/modes/golden/README.md).
// Real chats in this process on a scripted model; a throwaway agent dir, ~/.pi is never read or written.
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { after, test } from "node:test";

const { beginCase, cm, matchRecording, setOwner, withoutA1 } = await import("./tests/harness.fixture");
const { CASES } = await import("./tests/cases.fixture");
const { RECORD, referencedBlobs, STORE_DIR } = await import("./tests/store.fixture");

setOwner("extension");
after(async () => {
  await cm.disposeAllChats();
});

for (const c of CASES.filter((c) => (c.proc === true) === false)) {
  test(`${c.name}: ${c.covers}`, async () => {
    beginCase("extension");
    if (c.unrecorded && RECORD) return; // nothing to record (and master, where recordings are taken, lacks what it checks)
    const rec = await c.run("extension");
    if (c.unrecorded) c.unrecorded(rec);
    else matchRecording(c.name, rec, "extension", withoutA1);
  });
}

test("the store holds exactly what the recordings refer to (a re-record deletes what it no longer uses)", { skip: RECORD ? "recording" : false }, () => {
  const used = referencedBlobs();
  const stored = readdirSync(STORE_DIR).map((f) => f.replace(/\.json$/, ""));
  assert.deepEqual(stored.filter((k) => !used.has(k)), [], "store files no recording refers to");
  assert.deepEqual([...used].filter((k) => !stored.includes(k)), [], "references with no store file");
});
