// The modes recordings (server/modes/tests/harness.fixture.ts): Sova's engine runs every mode in every chat and worker,
// and each case must give its recording's bytes, unfiltered (golden/README.md). Every chat and worker loads Sova's
// engine in the mode slot and never the pi-config mode extension (assertOwner), whatever the pi folder links.
// The cases that run no program; those that do are in the .integration.test.ts beside it.
// SOVA_MODES_GOLDEN=record re-takes the recordings from here.
// Real chats in this process on a scripted model; a throwaway agent dir, ~/.pi is never read or written.
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { after, test } from "node:test";

const { beginCase, cm, matchRecording } = await import("./tests/harness.fixture");
const { CASES } = await import("./tests/cases.fixture");
const { RECORD, referencedBlobs, STORE_DIR } = await import("./tests/store.fixture");

after(async () => {
  await cm.disposeAllChats();
});

for (const c of CASES.filter((c) => (c.proc === true) === false)) {
  test(`${c.name}: ${c.covers}`, async () => {
    beginCase();
    const rec = await c.run();
    c.check?.(rec);
    matchRecording(c.name, rec);
  });
}

test("the store holds exactly what the recordings refer to (a re-record deletes what it no longer uses)", { skip: RECORD ? "recording" : false }, () => {
  const used = referencedBlobs();
  const stored = readdirSync(STORE_DIR).map((f) => f.replace(/\.json$/, ""));
  assert.deepEqual(stored.filter((k) => !used.has(k)), [], "store files no recording refers to");
  assert.deepEqual([...used].filter((k) => !stored.includes(k)), [], "references with no store file");
});
