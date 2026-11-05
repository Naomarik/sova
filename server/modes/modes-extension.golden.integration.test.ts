// Run: pnpm test -- server/modes/modes-extension.golden.integration.test.ts. The modes recordings (server/modes/tests/harness.fixture.ts) with the switch off
// (Settings → Experimental → "Sova runs chat modes"): the pi-config mode extension runs every mode, as at
// master, so each case must match its recording, a1's intended additions (the spec tool, two sentences) aside.
// The cases that run programs (the spec tools, a project tool): hence this tier; the rest are in the unit file beside it.
// SOVA_MODES_GOLDEN=record re-takes the recordings from here (take them from master's code: server/modes/golden/README.md).
// Real chats in this process on a scripted model; a throwaway agent dir, ~/.pi is never read or written.
import { after, test } from "node:test";

const { beginCase, cm, matchRecording, setOwner, withoutA1 } = await import("./tests/harness.fixture");
const { CASES } = await import("./tests/cases.fixture");

setOwner("extension");
after(async () => {
  await cm.disposeAllChats();
});

for (const c of CASES.filter((c) => (c.proc === true) === true)) {
  test(`${c.name}: ${c.covers}`, async () => {
    beginCase("extension");
    const rec = await c.run("extension");
    if (c.unrecorded) c.unrecorded(rec);
    else matchRecording(c.name, rec, "extension", withoutA1);
  });
}
