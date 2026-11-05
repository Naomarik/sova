// The saved samples (§mesh.compatibility/declare-a-change): what a host of the current version sends
// in each area, run through the page's own readers. A format change declared compatible that a
// reader can't read fails here. Raising an area's number replaces its sample: one sample per area,
// named for the version it records, so a raised number without a new sample fails too.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createStore } from "solid-js/store";
import type { HelloLive, SessionSummary, TranscriptItem, V2EventFrame } from "../../shared/protocol";
import { AREA_IDS, readAreas, WIRE_AREAS, type AreaId } from "../../shared/wire-areas";
import { contextFromItems } from "./context";
import { upgradeLegacyRows } from "./legacy-rows";
import { applyEvent, emptyLive, liveEventsOf, runDetail, seedLive, type LiveState } from "./live";
import { hostReading } from "./mesh-compat";
import { activityLine, cpuLine, machineLine, type HostDetails } from "./mesh-details";
import { peerRows } from "./mesh";
import { sendFrame } from "./send-frame";
import { byActivity, rowKey } from "./summary-diff";
import { summaryLineOf, summaryTitleOf } from "./summary-row";

const HERE = join(dirname(fileURLToPath(import.meta.url)), "wire-samples");
const sampleFile = (area: AreaId) => join(HERE, `${area}.v${WIRE_AREAS[area]}.json`);
const sample = <T>(area: AreaId): T => JSON.parse(readFileSync(sampleFile(area), "utf8")) as T;

test("each area has a sample of the version this build runs", () => {
  for (const area of AREA_IDS) assert.ok(existsSync(sampleFile(area)), `${area} is at ${WIRE_AREAS[area]}: replace its sample with one of that version`);
});

test("sessions: a host's rows read as the list reads them", () => {
  const rows = peerRows(sample<SessionSummary[]>("sessions"));
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.groupId, undefined, "a peer's group is dropped");
  assert.equal(summaryLineOf(rows[0]!), "Login redirect loses the return address");
  assert.equal(summaryTitleOf(rows[0]!), "Login redirect loses the return address\nNow: Running the auth tests");
  assert.equal(summaryLineOf(rows[1]!), "");
  assert.deepEqual([...rows].sort(byActivity).map((r) => r.title), ["Tidy the release notes", "Fix the login redirect"]);
  assert.equal(typeof rowKey(rows[0]!), "string");
  assert.notEqual(rowKey(rows[0]!), rowKey(rows[1]!));
});

test("transcript: rows, a hello's reply so far and the live frames after it", () => {
  const s = sample<{ rows: TranscriptItem[]; hello: HelloLive; frames: V2EventFrame[] }>("transcript");
  const rows = upgradeLegacyRows(s.rows);
  assert.equal(rows, s.rows, "current rows, not an older host's");
  assert.deepEqual(rows.map((r) => r.kind), ["user", "assistant-text", "tool-call", "tool-result"]);
  assert.equal(contextFromItems(rows, 1000), null, "no usage in the sample, so no fill");

  const [live, set] = createStore<LiveState>(emptyLive());
  seedLive(set, s.hello);
  for (const frame of s.frames) for (const e of liveEventsOf(frame)) applyEvent(set, e);
  assert.equal(live.entries.length, 1, "one reply: the frames continue the hello's");
  const reply = live.entries[0]!;
  assert.equal(reply.kind, "assistant");
  if (reply.kind !== "assistant") return;
  assert.equal(reply.model, "zai/glm-5.3");
  assert.deepEqual({ ...reply.blocks[1] }, { type: "text", text: "The bug is in auth.ts" });
  assert.equal(reply.blocks[2]?.type, "toolCall");
  assert.deepEqual(runDetail(live), { step: "tool", text: "running read" });
  assert.equal(live.tools.t2?.output, "14 passed");
});

test("composer: what this page writes is what a host of this version reads", () => {
  const s = sample<Record<string, unknown>>("composer");
  assert.deepEqual(sendFrame("Keep the query string", "c1", { typed: true }), s.steer);
  assert.deepEqual(sendFrame("Now the tests", "c2", { typed: false, confirm: "c3" }), s.prompt);
});

test("peer: a hello's areas and a host's details read as the page reads them", () => {
  const s = sample<{ hello: { areas: unknown }; details: HostDetails }>("peer");
  const areas = readAreas(s.hello.areas);
  assert.deepEqual(areas, WIRE_AREAS, "the sample lists this version's numbers");
  assert.equal(hostReading({ state: "up", areas }), "works");
  assert.equal(machineLine(s.details), "Server · Linux 6.9.0 (x64)");
  assert.equal(activityLine(s.details.activity), "3 sessions · 1 turn running · 2 workers");
  assert.equal(cpuLine(s.details.resources), "8 cores · load 0.50");
});
