// Run: pnpm test -- server/modes/modes-sova.golden.integration.test.ts. The modes recordings (server/modes/tests/harness.fixture.ts) with the switch on
// (Settings → Experimental → "Sova runs chat modes"): each case runs with the switch off, then on, in this
// process, each run in folders of its own; the on run must give exactly the off run's bytes (no filter),
// and the off run its recording (a1's intended additions aside). Every chat and worker of the on run
// loads Sova's engine in the mode slot and never the extension (assertOwner), so it can't pass on old code.
// The cases that run programs (the spec tools, a project tool): hence this tier; the rest are in the unit file beside it.
// Real chats in this process on a scripted model; a throwaway agent dir, ~/.pi is never read or written.
import { after, test } from "node:test";

const { beginCase, cm, matchRecording, setOwner, withoutA1 } = await import("./tests/harness.fixture");
const { assertSameRecord } = await import("./tests/store.fixture");
const { CASES } = await import("./tests/cases.fixture");

after(async () => {
  await cm.disposeAllChats();
});

for (const c of CASES.filter((c) => (c.proc === true) === true)) {
  test(`${c.name}: Sova's engine gives the extension's bytes; ${c.covers}`, async () => {
    setOwner("extension");
    beginCase("extension");
    const off = await c.run("extension");
    if (c.unrecorded) c.unrecorded(off);
    else matchRecording(c.name, off, "extension", withoutA1);
    setOwner("sova");
    beginCase("sova");
    const on = await c.run("sova");
    if (c.onDiffers) c.onDiffers(on, off);
    else assertSameRecord(`${c.name}: with the switch on, the record differs from the switch off`, on, off);
  });
}
