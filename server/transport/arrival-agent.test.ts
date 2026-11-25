// After arrival (§app.transport/agent, §app.transport/arrival): the Transport agent is asked for the same project as
// before it (its root commit included, so the repository the arrival made reads as this project's with no remote),
// under the arrived chat's own title; its card goes into the arrived chat once, before Move Back's fingerprint; and
// what it sets up reaches the source, so the Move's done line says the setup is under way.
import { dropScratchAgentDir } from "../testing/scratch-agent-dir";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { TRANSPORT_AGENT_NOTE } from "../../shared/transport-agent-card";
import { setAfterArrival, type PrepareRequest } from "./hooks";
import { createTransport, updateTransport } from "./store";

after(dropScratchAgentDir);

const ROOT = "a".repeat(40);

test("after arrival: the agent gets the project's root commit and the arrived chat's title, its card goes into the chat once, and the source hears what it sets up", async () => {
  const { ensureChatHome } = await import("../chat-homes/root");
  const dest = await import("./destination");
  const id = "0199aaaa-0000-7000-8000-0000000000a1";
  const tid = "tr_after001";
  const home = ensureChatHome(id);
  mkdirSync(join(home, "sessions"), { recursive: true });
  const file = join(home, "sessions", `2026-01-01T00-00-00-000Z_${id}.jsonl`);
  writeFileSync(file, `${JSON.stringify({ type: "session", id })}\n`);
  createTransport({
    tid, side: "destination", mode: "move", chatId: id, sourceChatId: id, title: "fix the motors please, they stall at", peer: "desk", peerLabel: "Desk", path: "", folder: "/x", state: "switching", arrivedId: id,
    steps: { offered: "t", prepared: "t", pulled: "t", staged: "t", verified: "t", decided: "t", published: "t" },
    // No remote recorded: only the root commit knows the repository the arrival made as this project's.
    ext: { fromSource: true, offer: { trees: [], repoRel: null, project: { remotes: [], roots: [ROOT] } } },
  });
  const asked: PrepareRequest[] = [];
  setAfterArrival((req) => {
    asked.push(req);
    // The agent starts and is kept on the record (routes.ts's onAgent does this live).
    updateTransport(tid, { ext: { agent: { sessionId: "ag-1", path: "/agent.jsonl", title: `Transport: ${req.title}`, device: "Air", state: "working", checks: [{ id: "tool:mise", ok: false, detail: "mise isn't installed for this user" }] } } });
    return ["mise", "node_modules"];
  });
  const cards: { path: string; card: unknown }[] = [];
  dest.setDestinationDeps({
    peerFetch: async () => new Response("{}"),
    clickProven: async () => true,
    adopt: () => {},
    cameBack: () => {},
    openWithNote: async (p, text) => appendFileSync(p, `${JSON.stringify({ type: "custom_message", customType: "sova-transport-arrival", content: text })}\n`),
    tellHelper: async () => {},
    helperNote: () => "",
    importUsage: () => ({}),
    titleOf: async () => "Motors stall fix",
    noteAgentCard: async (p, text, card) => {
      cards.push({ path: p, card });
      appendFileSync(p, `${JSON.stringify({ type: "custom_message", customType: TRANSPORT_AGENT_NOTE, content: text, details: card })}\n`);
      return true;
    },
  });
  const res = await dest.commit({ id: "desk" }, tid, {});
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(asked.length, 1);
  assert.equal(asked[0]!.project.firstCommit, ROOT, "the same project as the prepare: its root commit");
  assert.equal(asked[0]!.fromSource, true);
  assert.equal(asked[0]!.title, "Motors stall fix", "the arrived chat's own title, not its first line");
  assert.deepEqual(cards, [{ path: file, card: { tid, title: "Transport: Motors stall fix", device: "Air" } }]);
  assert.deepEqual((res.body as { settingUp?: string[] }).settingUp, ["mise", "node_modules"]);
  const s = await dest.statusOf({ id: "desk" }, tid);
  assert.deepEqual(s.settingUp, ["mise", "node_modules"], "the source reads it with the opened step");
  assert.equal(s.agent?.state, "working");
  assert.equal(s.turned, false, "the card is in before Move Back's fingerprint: no turn here");
  assert.ok(dest.hasAgentCard(readFileSync(file, "utf8"), tid));
  assert.ok(!dest.hasAgentCard(readFileSync(file, "utf8"), "tr_other01"));
  setAfterArrival(null);
});

test("the card's note is an info row carrying its card; details that don't read fall back to the plain row", async () => {
  const { rowsOfEntry } = await import("../transcript");
  const base = { id: "n1", parentId: null, kind: "note" as const, noteType: TRANSPORT_AGENT_NOTE, content: "The Transport agent …", display: true, inMessage: false };
  const card = { tid: "tr_after001", title: "Transport: Motors stall fix", device: "Air" };
  const [row] = rowsOfEntry({ ...base, details: card } as never);
  assert.equal(row?.kind, "info");
  assert.deepEqual(row?.transportAgent, card);
  const [plain] = rowsOfEntry({ ...base, details: { tid: "nope" } } as never);
  assert.equal(plain?.transportAgent, undefined);
  assert.equal(plain?.text, "The Transport agent …");
});
