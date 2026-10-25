// The runs a chat process's death cut off (§app.overseer/auto-resume): the resume decision.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CRASH_RESUME_TEXT, type InFlight, resumeInterrupted, resumeBriefText, type ResumeDeps } from "./auto-resume";

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
        assert.equal(text, CRASH_RESUME_TEXT);
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

  test("each cut-off session gets one continue; the overseers and baton sessions are left alone, the rest reported", async () => {
    const h = deps();
    const out = await resumeInterrupted(runs(["/a", { since: 1 }], ["/arch", { since: 2 }], ["/tui", { since: 3 }], ["/ov", { since: 4 }], ["/bat", { since: 5 }], ["/gone", { since: 6 }]), h.d);
    assert.deepEqual(h.sent, ["/a"]);
    assert.deepEqual(out.resumed, [{ id: "a", name: "Fix sandbox menu" }]);
    assert.deepEqual(out.skipped.map((s) => s.why), ["it is archived", "it is open in a terminal", "it is gone"]);
    assert.equal(h.briefs.length, 1);
    assert.match(h.briefs[0]!, /^A chat process stopped unexpectedly\. 1 interrupted session resumed, 3 not:\n- resumed: \[Fix sandbox menu\]\(sova:\/\/s\/a\)/);
  });

  test("within the running-at-once cap, oldest first; a resume cut off again is not resumed twice", async () => {
    const h = deps();
    h.setFree(1);
    const out = await resumeInterrupted(runs(["/b", { since: 9 }], ["/a", { since: 1 }]), h.d);
    assert.deepEqual(h.sent, ["/a"]);
    assert.deepEqual(out.skipped, [{ id: "b", name: "B work", why: "the running-at-once limit was reached" }]);
    const again = deps();
    const o2 = await resumeInterrupted(runs(["/a", { since: 1, auto: true }]), again.d);
    assert.deepEqual(again.sent, []);
    assert.equal(o2.skipped[0]!.why, "it was cut off again while resuming");
  });

  test("off in Settings: nothing is sent and nothing is briefed", async () => {
    const h = deps({ enabled: false });
    const out = await resumeInterrupted(runs(["/a", { since: 1 }]), h.d);
    assert.deepEqual([h.sent, h.briefs, out.resumed], [[], [], []]);
  });

  test("a refused prompt is reported with the refusal", async () => {
    const h = deps({ prompt: async () => { throw new Error("That is a baton session: only its participants write in it."); } });
    const out = await resumeInterrupted(runs(["/a", { since: 1 }]), h.d);
    assert.equal(out.skipped[0]!.why, "That is a baton session: only its participants write in it.");
    assert.match(resumeBriefText(out), /not resumed: \[Fix sandbox menu\]\(sova:\/\/s\/a\) — That is a baton session/);
  });

  test("a chat whose own process died gets the crash text, and its brief says a chat process stopped (§app.chat-processes/crash)", async () => {
    const texts: string[] = [];
    const h = deps({ prompt: async (_p, text) => void texts.push(text) });
    const out = await resumeInterrupted(runs(["/b", { since: 1 }]), h.d);
    assert.deepEqual(texts, [CRASH_RESUME_TEXT]);
    assert.deepEqual(out.resumed, [{ id: "b", name: "B work" }]);
    assert.match(h.briefs[0]!, /^A chat process stopped unexpectedly\. 1 interrupted session resumed:/);
    const again = deps({ prompt: async () => assert.fail("never twice") });
    const twice = await resumeInterrupted(runs(["/b", { since: 1, auto: true }]), again.d);
    assert.equal(twice.skipped[0]!.why, "it was cut off again while resuming");
  });
});
