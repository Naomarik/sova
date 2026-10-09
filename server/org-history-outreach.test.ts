// Run: node scripts/run-tests.mjs server/org-history-outreach.test.ts. An outside send interrupted before it was
// acknowledged reads Unknown in the org's history, never sent or failed, through the
// real restart path: the send's step had marked itself in flight (outreach-pending.json) when the server stopped;
// at the next open the org engine runs the pending effect again, the send step answers "may or may not have gone",
// and the history records that answer, triggered by the send. A throwaway agent dir (outreach-test-fixtures.ts).
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { ann, cleanup, gathering, logOf, org, sendLink } from "./outreach-test-fixtures";

const engine = await import("./org-engine");
const orgs = await import("./orgs");
const { stateRoot } = await import("./state-root");

test("a send cut off by a restart: recorded as sent-then-Unknown, linked to the send, never Failed", async () => {
  try {
    const sid = await gathering(ann.id);
    const host = engine.hostOf(org.id);
    // The step's own first half, then the server stops: it marks itself in flight (as send() does once it has
    // what it will send) and never answers.
    let started: () => void = () => {};
    const inFlight = new Promise<void>((r) => (started = r));
    host.effects.register("outreach-send", async (e) => {
      const key = typeof e.statechartKey === "string" && e.statechartKey ? e.statechartKey : String(e.key);
      const file = join(stateRoot(), "outreach-pending.json");
      let steps: Record<string, unknown> = {};
      try {
        steps = JSON.parse(readFileSync(file, "utf8")).steps ?? {};
      } catch {
        // none yet
      }
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify({ version: 1, steps: { ...steps, [key]: { kind: "handoff", minted: {} } } })}\n`, { mode: 0o600 });
      started();
      return new Promise(() => {});
    });
    void sendLink(sid);
    await inFlight;

    await engine.closeOrgHost(org.id);
    await orgs.openAttachedOrgs();
    const reopened = engine.hostOf(org.id);
    await reopened.idle();

    const h = reopened.history;
    const records = h.search({ role: "operator" }, { kinds: ["outreach.sent"] }).items.map((i) => h.event({ role: "operator" }, i.id)!.record!);
    const send = records.find((r) => r.outcome === "started");
    const answer = records.find((r) => r.outcome !== "started");
    assert.ok(send && answer, records.map((r) => r.outcome).join(","));
    assert.equal(answer!.outcome, "unknown");
    assert.deepEqual(answer!.triggeredBy, [{ event: send!.id, via: "effect" }]);
    assert.deepEqual(send!.entities.filter((x) => x.type === "person"), [{ type: "person", id: ann.id }]);
    // Ann's number in any spelling (a bare "555" also matched random hex ids, a 1-in-8 false failure).
    assert.ok(!/555\D?000\D?0100|share\.example|\/h\//.test(JSON.stringify(records)), "no number, link or token in the history");
    assert.equal(logOf().at(-1)!.event, "unknown", "the send log says the same");
  } finally {
    await cleanup();
  }
});
