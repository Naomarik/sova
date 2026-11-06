// §chat.timeline/inputs-only for a background job's end card: an `input` row with the filter off,
// titled "Background job j1" (never its command or its first line), with its density line; Inputs
// Only leaves it out, and the composer's count doesn't count it. The card's text is the one the chat
// sends (job-store.ts `jobCardText`), read as the server reads it (shared/wake.ts `parseWakeNudge`).
import assert from "node:assert/strict";
import { test } from "node:test";
import { jobCardText, type JobRecord } from "../../pi-config/extensions/subagents/job-store.ts";
import type { TranscriptItem } from "../../shared/protocol";
import { parseWakeNudge } from "../../shared/wake";
import { inputCount } from "./input-count";
import { inputRows, typedByUser } from "./inputs";
import { GAP_MS, timelineRows } from "./timeline";

const at = (min: number) => new Date(Date.UTC(2026, 10, 4, 10, min)).toISOString();
const job = (id: string): JobRecord => ({ v: 1, id, sessionId: "S", path: "/s.jsonl", kind: "kept", command: `make lab-${id} > lab.log &`, cwd: "/w", unit: "u.scope", driver: "systemd", startedAt: 0, bootId: "b", output: "/w/lab.log", ended: { at: 600_000, how: "exited", card: "wake" } });
/** The card as the server's transcript builds it (server/transcript.ts userRow). */
const cardItem = (id: string, min: number, jobs: JobRecord[]): TranscriptItem => {
  const text = jobCardText(jobs, {});
  const wake = parseWakeNudge(text);
  assert.ok(wake, "a card reads as a wake");
  return { id, kind: "wake", text, wake, at: at(min), meta: { type: "message", role: "user" } };
};
const user = (id: string, min: number, text: string): TranscriptItem => ({ id, kind: "user", text, at: at(min), meta: { type: "message", role: "user" } });
const reply = (id: string, min: number): TranscriptItem => ({ id, kind: "assistant-text", text: "ok", at: at(min), meta: { type: "message", role: "assistant" } });

test("a job card's row is titled \"Background job j1\", never its command or first line, and is not typed input", () => {
  const [row] = inputRows([cardItem("c1", 1, [job("j1")])]);
  assert.equal(row!.preview, "Background job j1");
  assert.equal(row!.wake, true);
  assert.equal(typedByUser(row!), false);
  // A machine restart's card names all its jobs.
  assert.equal(inputRows([cardItem("c2", 1, [job("j1"), job("j2")])])[0]!.preview, "Background job j1,j2");
});

test("the filter off shows the card as an input row with its density line; Inputs Only and the composer's count leave it out", () => {
  const items = [user("u1", 0, "start the lab"), reply("a1", 1), cardItem("c1", 30, [job("j1")]), reply("a2", 31), user("u2", 60, "and now?"), reply("a3", 61)];
  const all = timelineRows(items, null, [], GAP_MS);
  const card = all.find((r) => r.key === "input:c1");
  assert.ok(card, "an input row with the filter off");
  assert.equal(card!.title, "Background job j1");
  assert.equal(card!.wake, true);
  assert.ok(all.some((r) => r.key === "density:input:c1"), "with its density line");
  const mine = timelineRows(items, null, [], GAP_MS, { inputsOnly: true });
  assert.deepEqual(mine.filter((r) => r.kind === "input").map((r) => r.entryId), ["u1", "u2"]);
  assert.ok(!mine.some((r) => r.key.includes("c1")), "neither the card nor its density line");
  assert.equal(inputCount(items), 2);
});
