// Run: pnpm exec tsx --test server/org-host/offer-reach.test.ts. r12 (q15 = C), the host side of an offer
// reaching each invitee in their own hours (offer-delivery-scope §7, tests 9–11): across a restart the
// reach timer fires at open and reaches only who is in hours then; each invitee's link is its own keyed
// effect, re-run alone after a crash; the log keeps no contact value and replays to the snapshot.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { OrgHost, type Effect } from "./index";
import { verifyOrg } from "./rebuild";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const t0 = 1700000000000; // Tuesday 2023-11-14 22:13:20 UTC
const hour = 3_600_000;
const wed03 = Date.UTC(2023, 10, 15, 3, 0, 0);
const everyDay = [0, 1, 2, 3, 4, 5, 6];
const ana = { id: "p1", name: "Ana", status: "active", tz: "UTC", hours: { days: everyDay, from: "22:00", to: "23:30" } };
const bo = { id: "p2", name: "Bo", status: "active", tz: "UTC", hours: { days: everyDay, from: "03:00", to: "11:00" } };
const cy = { id: "p3", name: "Cy", status: "active" };
const BATON = "baton/o1/s1";
const operator = { by: "operator" };

function place() {
  const root = mkdtempSync(join(tmpdir(), "offer-reach-"));
  dirs.push(root);
  return { workspaceDir: join(root, "ws"), stateDir: join(root, "state") };
}

async function openAt(at: { workspaceDir: string; stateDir: string }, clock: () => number) {
  return OrgHost.open({ orgId: "o1", ...at, durable: false, clock });
}

/** An org with three people and a baton offered to all three (the spawner's start data). */
async function offered(host: OrgHost) {
  await host.start("org/o1", "org", { id: "o1", name: "Acme", slug: "acme", createdAt: 1 }, operator);
  for (const p of [ana, bo, cy]) {
    const { id, ...person } = p;
    await host.start(`person/o1/${id}`, "person", { orgId: "o1", id, person: { ...person, role: "R", decides: [], skills: [] }, changed: [], by: { kind: "operator" } }, operator);
  }
  await host.start(BATON, "baton", {
    orgId: "o1", projectId: "pr1", sessionId: "s1", publicTitle: "Logo", goal: "G", owner: { overseerOf: "pr1" },
    targets: ["p1", "p2", "p3"], targetPeople: [ana, bo, cy], names: { p1: "Ana", p2: "Bo", p3: "Cy" }, operatorName: "Omar",
  }, operator);
}

const reach = (host: OrgHost) => {
  const offers = (host.data(BATON)?.["offers"] as { reach?: Record<string, { state: string; at?: number; next?: number }> }[] | undefined) ?? [];
  return offers.at(-1)?.reach ?? {};
};

describe("r12 offer reach on the host", () => {
  test("setup: Ana and Cy reached at once, Bo waits for his window", async () => {
    const at = place();
    const host = await openAt(at, () => t0);
    await offered(host);
    const r = reach(host);
    assert.deepEqual(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.state])), { p1: "reached", p2: "waiting", p3: "reached" });
    assert.equal(r["p2"]?.next, wed03);
    await host.close();
  });

  test("9: closed across Bo's window, the reach timer fires at open and reaches him (he is in hours then); a link is minted for him alone", async () => {
    const at = place();
    let now = t0;
    const host = await openAt(at, () => now);
    await offered(host);
    await host.close();
    now = wed03 + hour; // 04:00: inside Bo's 03:00–11:00
    const again = await openAt(at, () => now);
    const minted: Effect[] = [];
    again.effects.register("mint-link", async (e) => {
      minted.push(e);
      return { minted: 1 };
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(reach(again)["p2"]?.state, "reached");
    assert.equal(reach(again)["p2"]?.at, now, "reached at open, not at the (missed) window start");
    const bos = minted.filter((e) => e["personId"] === "p2");
    assert.equal(bos.length, 1);
    assert.equal(bos[0]!["chartKey"], "reach/off_s1_1/p2");
    assert.equal(bos[0]!["via"], "reach");
    await again.close();
  });

  test("9: closed past Bo's whole window, he is NOT reached at open (never outside his hours): the timer moves to his next window", async () => {
    const at = place();
    let now = t0;
    const host = await openAt(at, () => now);
    await offered(host);
    await host.close();
    now = wed03 + 10 * hour; // 13:00: Bo's window closed at 11:00
    const again = await openAt(at, () => now);
    assert.equal(reach(again)["p2"]?.state, "waiting");
    assert.equal(reach(again)["p2"]?.next, wed03 + 24 * hour, "Thursday 03:00");
    assert.equal(again.nextDueAt(), wed03 + 24 * hour);
    await again.close();
  });

  test("10: each invitee's link is its own keyed effect: pending at a crash, each re-runs once with its own key; answered, none again", async () => {
    const at = place();
    const host = await openAt(at, () => t0);
    await offered(host); // no mint-link handler yet: Ana's and Cy's effects stay pending (a crash before they ran)
    await host.close();
    const runs: Effect[] = [];
    const again = await openAt(at, () => t0 + 1000);
    again.effects.register("mint-link", async (e) => {
      runs.push(e);
      return { minted: 1 };
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(runs.map((e) => e["chartKey"]).sort(), ["reach/off_s1_1/p1", "reach/off_s1_1/p3"]);
    assert.equal(new Set(runs.map((e) => e.key)).size, 2, "two effects, two engine keys");
    await again.close();
    const third = await openAt(at, () => t0 + 2000);
    let more = 0;
    third.effects.register("mint-link", async () => {
      more++;
      return {};
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(more, 0, "answered: never again");
    await third.close();
  });

  test("11: a referral's contact on an invitee reaches no log row; the org's log replays to every snapshot", async () => {
    const at = place();
    let now = t0;
    const host = await openAt(at, () => now);
    const MARK = "invitee.marker@example.org";
    await host.start("org/o1", "org", { id: "o1", name: "Acme", slug: "acme", createdAt: 1 }, operator);
    for (const p of [ana, bo, cy]) {
      const { id, ...person } = p;
      await host.start(`person/o1/${id}`, "person", { orgId: "o1", id, person: { ...person, role: "R", decides: [], skills: [] }, changed: [], by: { kind: "operator" } }, operator);
    }
    const boWithReferral = { ...bo, referral: { by: "p1", contact: { email: MARK } } };
    await host.start(BATON, "baton", {
      orgId: "o1", projectId: "pr1", sessionId: "s1", publicTitle: "Logo", goal: "G", owner: { overseerOf: "pr1" },
      targets: ["p1", "p2", "p3"], targetPeople: [ana, boWithReferral, cy], names: { p1: "Ana", p2: "Bo", p3: "Cy" }, operatorName: "Omar",
    }, operator);
    host.effects.register("mint-link", async () => ({ minted: 1 }));
    now = wed03 + hour;
    host.fireDue();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(reach(host)["p2"]?.state, "reached");
    await host.close();
    const logText = [host.paths.portableLog, host.paths.localLog].flatMap((d) => {
      try {
        return readdirSync(d).map((f) => readFileSync(join(d, f), "utf8"));
      } catch {
        return [];
      }
    }).join("\n");
    assert.ok(logText.includes("offer/reach"), "the reach is logged");
    assert.ok(!logText.includes(MARK), "no contact value in the log");
    const v = verifyOrg({ orgId: "o1", ...at });
    assert.deepEqual(v.differing.map((d) => [d.session, d.differences.map((x) => x.what), d.divergence]), [], "rebuild --verify: 0 differences");
  });
});
