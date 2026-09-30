// The runs a restart cut off (§app.overseer/auto-resume): the ledger and the resume decision.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { type InFlight, RESUME_TEXT, resumeInterrupted, resumeBriefText, RunLedger, type ResumeDeps } from "./auto-resume";

const dir = mkdtempSync(join(tmpdir(), "sova-auto-resume-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let k = 0;
const file = () => join(dir, `runs-${++k}.json`);

describe("the ledger of runs in flight", () => {
  test("a run that settles leaves it; one a stop cuts off stays, and the next process reads it once", () => {
    const f = file();
    const before = new RunLedger(f);
    before.started("/s/a.jsonl", 1);
    before.started("/s/b.jsonl", 2);
    before.settled("/s/a.jsonl");
    before.freeze();
    // The shutdown's own aborts settle every run: frozen, the ledger keeps them.
    before.settled("/s/b.jsonl");
    const next = new RunLedger(f);
    assert.deepEqual([...next.takeInterrupted().entries()], [["/s/b.jsonl", { since: 2 }]]);
    assert.equal(next.takeInterrupted().size, 0, "read and emptied: one stop is answered once");
  });

  test("a crash (no freeze) leaves what was running; a resumed run cut off again is marked", () => {
    const f = file();
    const first = new RunLedger(f);
    first.markResuming("/s/a.jsonl");
    first.started("/s/a.jsonl", 5);
    assert.deepEqual([...new RunLedger(f).takeInterrupted().entries()], [["/s/a.jsonl", { since: 5, auto: true }]]);
  });
});

describe("resuming", () => {
  function deps(over: Partial<ResumeDeps> = {}) {
    const sent: string[] = [];
    const logs: string[] = [];
    const briefs: string[] = [];
    const sessions: Record<string, Awaited<ReturnType<ResumeDeps["session"]>>> = {
      "/a": { id: "a", title: "fix the thing", name: "Fix sandbox menu" },
      "/b": { id: "b", title: "b", name: "B work" },
      "/arch": { id: "arch", title: "x", name: "Old", archived: true },
      "/tui": { id: "tui", title: "x", name: "Terminal", live: { pid: 1 } },
      "/ov": { id: "ov", title: "x", name: "Overseer", overseer: true },
      "/bat": { id: "bat", title: "x", name: "Baton", baton: {} },
    };
    let free = 10;
    const d: ResumeDeps = {
      enabled: true,
      session: async (p) => sessions[p] ?? null,
      freeSlots: () => free,
      prompt: async (p, text) => {
        assert.equal(text, RESUME_TEXT);
        sent.push(p);
        free--;
      },
      log: (p, outcome, why) => logs.push(`${p} ${outcome}${why ? ` ${why}` : ""}`),
      brief: async (t) => void briefs.push(t),
      ...over,
    };
    return { d, sent, logs, briefs, setFree: (n: number) => (free = n) };
  }
  const runs = (...paths: [string, InFlight][]) => new Map(paths);
  const marks = { markResuming: () => {} };

  test("each cut-off session gets one continue; the overseers and baton sessions are left alone, the rest reported", async () => {
    const h = deps();
    const out = await resumeInterrupted(runs(["/a", { since: 1 }], ["/arch", { since: 2 }], ["/tui", { since: 3 }], ["/ov", { since: 4 }], ["/bat", { since: 5 }], ["/gone", { since: 6 }]), h.d, marks);
    assert.deepEqual(h.sent, ["/a"]);
    assert.deepEqual(out.resumed, [{ id: "a", name: "Fix sandbox menu" }]);
    assert.deepEqual(out.skipped.map((s) => s.why), ["it is archived", "it is open in a terminal", "it is gone"]);
    assert.equal(h.briefs.length, 1);
    assert.match(h.briefs[0]!, /^The server restarted\. 1 interrupted session resumed, 3 not:\n- resumed: \[Fix sandbox menu\]\(sova:\/\/s\/a\)/);
  });

  test("within the running-at-once cap, oldest first; a resume cut off again is not resumed twice", async () => {
    const h = deps();
    h.setFree(1);
    const out = await resumeInterrupted(runs(["/b", { since: 9 }], ["/a", { since: 1 }]), h.d, marks);
    assert.deepEqual(h.sent, ["/a"]);
    assert.deepEqual(out.skipped, [{ id: "b", name: "B work", why: "the running-at-once limit was reached" }]);
    const again = deps();
    const o2 = await resumeInterrupted(runs(["/a", { since: 1, auto: true }]), again.d, marks);
    assert.deepEqual(again.sent, []);
    assert.equal(o2.skipped[0]!.why, "it was cut off again while resuming");
  });

  test("off in Settings: nothing is sent and nothing is briefed", async () => {
    const h = deps({ enabled: false });
    const out = await resumeInterrupted(runs(["/a", { since: 1 }]), h.d, marks);
    assert.deepEqual([h.sent, h.briefs, out.resumed], [[], [], []]);
  });

  test("a refused prompt is reported with the refusal", async () => {
    const h = deps({ prompt: async () => { throw new Error("That is a baton session: only its participants write in it."); } });
    const out = await resumeInterrupted(runs(["/a", { since: 1 }]), h.d, marks);
    assert.equal(out.skipped[0]!.why, "That is a baton session: only its participants write in it.");
    assert.match(resumeBriefText(out), /not resumed: \[Fix sandbox menu\]\(sova:\/\/s\/a\) — That is a baton session/);
  });
});
