// A card applied over the per-message limits (§app.overseer/card-partial-apply, §app.overseer/caps):
// 14 Go rows, promptsPerTurn 10 and concurrentSessions 10. The tools refuse past the limit and,
// in a turn a card's click opened, say to record the rows done; the card stays partly applied,
// and a second Apply sends exactly the rest.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { SessionSummary, SovaConfirmItem } from "../shared/protocol";
import type { OverseerToolHost } from "./overseer-tools";

const agentDir = mkdtempSync(join(tmpdir(), "sova-overseer-card-apply-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => rmSync(agentDir, { recursive: true, force: true }));

const { overseerTools, TurnLimits, CARD_REST_REFUSAL } = await import("./overseer-tools");
const { countRunning } = await import("./overseer");
const { DEFAULT_CAPS } = await import("./overseer-store");
const card = await import("../shared/overseer-card");

const NOW = "2026-10-27T10:00:00.000Z";
const ids = Array.from({ length: 14 }, (_, i) => `s${i + 1}`);
const rows = (): (SovaConfirmItem & { default?: string; choices?: unknown })[] =>
  ids.map((id, i) => ({
    kind: "session",
    id,
    title: `Session ${id}`,
    note: `Waiting on your go-ahead to build ${id}.`,
    section: i < 7 ? "Waiting on you" : "Finished plan",
    sends: `Go ahead and build the plan for ${id}.`,
    default: "a",
  }));

/** sova_send over a fake server, in a turn opened by a click on the card (`confirmed`), or not. */
function harness(cardTurn: boolean) {
  const running = new Set<string>();
  const started = new Set<string>();
  const promptedAt = new Map<string, number>();
  const sent: { path: string; text: string }[] = [];
  const host = {
    request: async (_path: string, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true, queued: false, kind: "prompt" });
    },
    overseerId: () => "ov",
    confirmed: () => (cardTurn ? rows().map(({ default: _d, choices: _c, ...it }) => it as SovaConfirmItem) : null),
    caps: () => ({ ...DEFAULT_CAPS, promptsPerTurn: 10, concurrentSessions: 10 }),
    session: async (ref: string) => (ids.includes(ref) ? ({ id: ref, path: `/s/${ref}.jsonl`, title: `Session ${ref}` } as SessionSummary) : null),
    started: (p: string, prompted?: boolean) => {
      started.add(p);
      if (prompted) promptedAt.set(p, Date.now());
    },
    runningStarted: () => countRunning(started, (p: string) => running.has(p), promptedAt),
    counted: (p: string) => countRunning(started.has(p) ? [p] : [], (q: string) => running.has(q), promptedAt) > 0,
    attended: () => true,
  } as unknown as OverseerToolHost;
  const send = overseerTools(host, new TurnLimits()).find((t) => t.name === "sova_send")!;
  const call = (params: Record<string, unknown>) =>
    send.execute("tc", params, undefined, undefined, undefined as never).then(
      (r) => (r.content[0] as { text: string }).text,
      (e: Error) => `ERROR: ${e.message}`,
    );
  return { call, sent };
}

describe("a card applied past the limits: 14 Go rows, promptsPerTurn 10", () => {
  test("in the turn the click opened, the first 10 send and the rest refuse, saying to record the rows done and that Apply sends the rest", async () => {
    const h = harness(true);
    const results: string[] = [];
    for (const id of ids) results.push(await h.call({ session: id, text: `Go ahead and build the plan for ${id}.` }));
    assert.equal(h.sent.length, 10);
    assert.deepEqual(h.sent.map((s) => s.text), ids.slice(0, 10).map((id) => `Go ahead and build the plan for ${id}.`), "each send is the row's Go-sends text");
    for (const r of results.slice(10)) {
      assert.match(r, /^ERROR: Limit reached/);
      assert.ok(r.endsWith(CARD_REST_REFUSAL), r);
    }
  });

  test("outside a card's turn the refusal is the plain one", async () => {
    const h = harness(false);
    let last = "";
    for (const id of ids) last = await h.call({ session: id, text: "go" });
    assert.match(last, /^ERROR: Limit reached/);
    assert.ok(!last.includes(CARD_REST_REFUSAL));
  });

  test("the card records the 10 done and stays open; the rest keep their applied picks, and a second Apply names exactly them", () => {
    const create = card.applyCardCall(
      [],
      { ops: [{ op: "create", title: "Get things moving", choices: ["Go", "Not Yet"] }] },
      { now: NOW, prepared: { items: rows(), hrefs: [] } },
    );
    let c = create.details.card!;
    assert.equal(c.items.length, 14);
    // The user picked Not Yet on row 12 and applied everything.
    const picks = Object.fromEntries(c.items.map((it) => [it.n, it.n === 12 ? "b" : "a"])) as Record<number, string>;
    const first = card.itemsClick(c, picks)!;
    assert.deepEqual(card.matchCardClick(c, first), { card: c.id, items: picks });
    // The Overseer acted on rows 1..10 and recorded only those.
    const done = Object.fromEntries(ids.slice(0, 10).map((_, i) => [String(i + 1), "a"]));
    c = card.applyCardCall([c], { card: c.id, ops: [{ op: "answer", text: first, items: done }] }, { now: NOW }).details.card!;
    assert.equal(c.phase, "open", "partly applied");
    assert.match(card.phaseText(c), /10 of 14 items decided/);
    // The rows not yet done start on what they were applied with (12 stays Not Yet), from the click itself.
    const applied = card.appliedPicks(c, ["Get things moving", first]);
    const kept = card.keptPicks(c, {}, Object.fromEntries(c.items.filter((it) => !it.decided).map((it) => [it.n, applied[it.n] ?? it.default!])));
    assert.deepEqual(kept, { 11: "a", 12: "b", 13: "a", 14: "a" });
    // A row now done keeps no pick, even one the client still held.
    assert.deepEqual(card.keptPicks(c, picks, {}), { 11: "a", 12: "b", 13: "a", 14: "a" });
    const second = card.itemsClick(c, kept)!;
    assert.equal(second, `${c.id}: 11a Go, 12b Not Yet, 13a Go, 14a Go`);
    const click = card.matchCardClick(c, second)!;
    assert.deepEqual(card.clickItems(c, click).map((it) => it.id), ["s11", "s12", "s13", "s14"], "the second Apply approves only the rest");
    // Recording them answers the card.
    c = card.applyCardCall([c], { card: c.id, ops: [{ op: "answer", text: second, items: { 11: "a", 12: "b", 13: "a", 14: "a" } }] }, { now: NOW }).details.card!;
    assert.equal(c.phase, "answered");
  });
});
