// The approvals for later and standing rules (§app.overseer/approvals): the click writes them, the
// acting tools check them in a run the user did not start, and a revoke ends them. Uses a throwaway
// PI_CODING_AGENT_DIR; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { SessionSummary, SovaConfirmItem } from "../shared/protocol";
import type { OverseerToolHost } from "./overseer-tools";

const agentDir = mkdtempSync(join(tmpdir(), "sova-overseer-approvals-"));
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = agentDir;

const { overseerTools, TurnLimits, UNATTENDED_REFUSAL } = await import("./overseer-tools");
const { clearOverseer, ensureOverseer, overseerAutonomy, permitOnClick, permitLabel } = await import("./overseer");
const { DEFAULT_CAPS } = await import("./overseer-store");
const { applyCardCall, optionClick } = await import("../shared/overseer-card");
const { coveringPermit, foldPermits, GRANT_ENTRY, REVOKE_ENTRY, RULE_ENTRY, USE_ENTRY } = await import("../shared/overseer-grants");
const { acquireChat, disposeAllChats } = await import("./chat-manager");
const { historyOf } = await import("./harness/pi/reader");

after(async () => {
  await disposeAllChats();
});

const NOW = new Date(Date.now() - 60_000).toISOString();
const inAnHour = new Date(Date.now() + 3600_000).toISOString();
const session = (id: string): SovaConfirmItem => ({ kind: "session", id, title: `Session ${id}` });
const card = applyCardCall(
  [],
  { ops: [{ op: "create", title: "Continue later?", options: [{ label: "No" }, { label: "Continue Later", reply: "Send continue to both", at: inAnHour }], items: { sessions: ["a", "b"] } }] },
  { now: NOW, grants: true, prepared: { items: [session("a"), session("b")], hrefs: [] } },
).details;
const result = { type: "message", id: "e1", message: { role: "toolResult", toolCallId: "k1", toolName: "sova_card", details: card } };
let n = 0;
const user = (text: string) => ({ type: "message", id: `u${++n}`, message: { role: "user", content: [{ type: "text", text }] } });
const click = optionClick(card.card!, "b")!;
/** permitOnClick over pi's entries as the reader gives them (the Overseer passes its live read). */
const onClick = (c: string | null, branch: readonly unknown[], all: readonly unknown[]) => permitOnClick(c, historyOf(branch), historyOf(all), NOW);

describe("the click writes the grant (permitOnClick)", () => {
  test("only an exact click on an open card, marked as a click, writes; and only once", () => {
    const clicked = [user("keep them going"), result, user(click)];
    const w = onClick("c_1", clicked, clicked);
    assert.equal(w?.type, GRANT_ENTRY);
    assert.deepEqual(w?.data.sessions.map((s) => s.id), ["a", "b"]);
    assert.equal(onClick(null, clicked, clicked), undefined, "the same text, not marked as a click (typed)");
    assert.equal(onClick("c_1", [result, user("yes, continue later")], []), undefined, "typed text");
    assert.equal(onClick("c_1", [result, user(`${click} please`)], []), undefined, "text that only looks like the click");
    const written = [...clicked, { type: "custom", customType: GRANT_ENTRY, data: w!.data }];
    assert.equal(onClick("c_1", clicked, written), undefined, "a click writes once");
    const dropped = applyCardCall([card.card!], { card: "c_1", ops: [{ op: "drop", reason: "done" }] }, { now: NOW }).details;
    const closed = [result, { type: "message", message: { role: "toolResult", toolCallId: "k2", toolName: "sova_card", details: dropped } }, user(click)];
    assert.equal(onClick("c_1", closed, closed), undefined, "a closed card");
  });
});

describe("unattended acts under a grant (the tools' check)", () => {
  /** sova_send and sova_create_session over a fake server, unattended; the host folds a real entry list. */
  function harness() {
    const clicked = [result, user(click)];
    const entries: unknown[] = [...clicked, { type: "custom", customType: GRANT_ENTRY, data: onClick("c_1", clicked, clicked)!.data }];
    const sent: unknown[] = [];
    const summary = (id: string) => ({ id, path: `/s/${id}.jsonl`, title: `Session ${id}` }) as SessionSummary;
    const host = {
      request: async (_path: string, init?: RequestInit) => {
        sent.push(JSON.parse(String(init?.body)));
        return Response.json({ ok: true, queued: false, kind: "prompt" });
      },
      overseerId: () => "ov",
      caps: () => DEFAULT_CAPS,
      session: async (ref: string) => (["a", "b", "c"].includes(ref) ? summary(ref) : null),
      aliases: () => ({ b: "the other one" }),
      started: () => {},
      runningStarted: () => 0,
      counted: () => false,
      attended: () => false,
      confirmed: () => null,
      permit: (tool: string, ids: string[]) => {
        const p = coveringPermit(foldPermits(historyOf(entries), historyOf(entries), Date.now()), tool, ids, Date.now());
        return p ? { id: p.id, label: permitLabel(p) } : null;
      },
      used: (id: string, tool: string, sessions: string[], toolCallId: string) => entries.push({ type: "custom", customType: USE_ENTRY, data: { v: 1, id, tool, sessions, toolCallId, at: new Date().toISOString() } }),
    } as unknown as OverseerToolHost;
    const tools = overseerTools(host, new TurnLimits());
    const call = (name: string, params: Record<string, unknown>, id = "tc") =>
      tools
        .find((t) => t.name === name)!
        .execute(id, params, undefined, undefined, undefined as never)
        .then(
          (r) => r.content.map((c) => (c as { text: string }).text).join("\n"),
          (e: Error) => `ERROR: ${e.message}`,
        );
    return { call, sent, entries };
  }

  test("a covered act runs, says what it ran under, and is logged as a use", async () => {
    const h = harness();
    const out = await h.call("sova_send", { session: "a", text: "continue" }, "tc-1");
    assert.match(out, /^Sent to \[Session a\]/);
    assert.match(out, /Done under g_1 \(c_1 b: any act on these 2 sessions until /);
    assert.equal(h.sent.length, 1);
    const uses = h.entries.filter((e) => (e as { customType?: string }).customType === USE_ENTRY);
    assert.deepEqual((uses[0] as { data: { id: string; sessions: string[]; toolCallId: string } }).data.sessions, ["a"]);
    const log = readFileSync(join(agentDir, "sova", "overseer-actions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(log.at(-1).under, "g_1");
    assert.equal(log.at(-1).outcome, "ok");
    // An alias names a session the grant covers too.
    assert.match(await h.call("sova_send", { session: "the other one", text: "continue" }), /Done under g_1/);
  });

  test("an act outside it refuses as before: another session, or an act that names none", async () => {
    const h = harness();
    assert.equal(await h.call("sova_send", { session: "c", text: "continue" }), `ERROR: ${UNATTENDED_REFUSAL}`);
    assert.equal(await h.call("sova_create_session", { cwd: "/tmp", prompt: "go" }), `ERROR: ${UNATTENDED_REFUSAL}`);
    assert.equal(await h.call("sova_archive", { sessions: ["a", "c"] }), `ERROR: ${UNATTENDED_REFUSAL}`, "every named session must be covered");
    assert.equal(h.sent.length, 0);
  });

  test("once revoked, the next act refuses", async () => {
    const h = harness();
    assert.match(await h.call("sova_send", { session: "a", text: "continue" }), /Done under g_1/);
    h.entries.push({ type: "custom", customType: REVOKE_ENTRY, data: { v: 1, id: "g_1", at: new Date().toISOString(), by: "user" } });
    assert.equal(await h.call("sova_send", { session: "a", text: "continue" }), `ERROR: ${UNATTENDED_REFUSAL}`);
    assert.equal(h.sent.length, 1);
  });
});

describe("/clear carries live rules; approvals lapse", () => {
  test("the new conversation holds each live rule, same id and origin, and nothing else", async () => {
    const old = await ensureOverseer();
    // Written as the server writes them: through the held runtime's session manager.
    const sm = (await acquireChat(old.path)).session.sessionManager;
    const add = (customType: string, data: unknown) => void sm.appendCustomEntry(customType, data);
    const base = { v: 1, card: "c_1", option: "b", label: "Always", createdAt: NOW };
    const sessions = [{ id: "a", title: "Session a" }];
    add(GRANT_ENTRY, { ...base, id: "g_1", message: "m1", sessions, at: NOW, until: inAnHour });
    add(RULE_ENTRY, { ...base, id: "r_1", message: "m2", text: "Send continue after a reset", acts: ["sova_send"], sessions });
    add(RULE_ENTRY, { ...base, id: "r_2", message: "m3", text: "Archive merged sessions", acts: ["sova_archive"], sessions: "any" });
    add(REVOKE_ENTRY, { v: 1, id: "r_2", at: NOW, by: "user" });
    add(USE_ENTRY, { v: 1, id: "r_1", tool: "sova_send", sessions: ["a"], toolCallId: "tc", at: NOW });
    assert.deepEqual((await overseerAutonomy()).permits.map((p) => [p.id, p.status]), [["g_1", "live"], ["r_1", "live"], ["r_2", "revoked"]]);

    const info = await clearOverseer();
    assert.notEqual(info.id, old.id);
    const permits = (await overseerAutonomy()).permits;
    assert.deepEqual(permits.map((p) => [p.id, p.kind, p.status, p.card, p.option, p.text, p.from, p.uses.length]), [
      ["r_1", "rule", "live", "c_1", "b", "Send continue after a reset", old.id, 0],
    ]);
    const written = readFileSync(info.path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(written.filter((e) => e.type === "custom").map((e) => e.customType), ["sova-overseer", RULE_ENTRY], "server-written custom entries, after the marker");
  });
});
