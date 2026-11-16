// The modes recordings (server/modes/tests/harness.fixture.ts): Sova's engine runs every mode in every chat and worker,
// and each case must give its recording's bytes, unfiltered (golden/README.md). Every chat and worker loads Sova's
// engine in the mode slot and never the pi-config mode extension (assertOwner), whatever the pi folder links.
// The cases that run programs (the spec tools, a project tool): hence this tier; the rest are in the unit file beside it.
// SOVA_MODES_GOLDEN=record re-takes the recordings from here.
// Real chats in this process on a scripted model; a throwaway agent dir, ~/.pi is never read or written.
import { after, test } from "node:test";

const { beginCase, cm, matchRecording } = await import("./tests/harness.fixture");
const { CASES } = await import("./tests/cases.fixture");

after(async () => {
  await cm.disposeAllChats();
});

for (const c of CASES.filter((c) => (c.proc === true) === true)) {
  test(`${c.name}: ${c.covers}`, async () => {
    beginCase();
    const rec = await c.run();
    c.check?.(rec);
    matchRecording(c.name, rec);
  });
}
