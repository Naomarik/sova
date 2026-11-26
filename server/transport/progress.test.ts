// The destination's progress reaches the device the chat comes from (§app.transport/dialog): each poll keeps the
// destination's own steps on the source's record as that device says them now, and a reading of the bytes it holds
// with when it was read, so the dialog's steps stay current and its Sending speed has times to go by.
import "../testing/scratch-agent-dir";
import assert from "node:assert/strict";
import { test } from "node:test";
import { drive, setSourceDeps, type SourceDeps } from "./source";
import { SENT_SAMPLES, type SentSample, therePatch } from "./progress";
import { createTransport, onTransportChange, readTransport, type TransportRecord, updateTransport } from "./store";
import type { StatusBody } from "./wire";

const at = "2026-11-26T10:00:00.000Z";
const rec = (p: Partial<TransportRecord> = {}): TransportRecord => ({ v: 1, tid: "tr_prog0001", side: "source", mode: "move", chatId: "c", sourceChatId: "c", title: "t", peer: "laptop", peerLabel: "Laptop", path: "/x.jsonl", folder: "/x", state: "sending", steps: { offered: at, stopped: at, packed: at }, attempt: 1, createdAt: at, updatedAt: at, ...p });
const status = (p: Partial<StatusBody>): StatusBody => ({ tid: "tr_prog0001", state: "sending", steps: {}, ...p });

test("the source follows the destination's steps and the bytes it holds, with when it read them", async () => {
  const MB = 1024 * 1024;
  let n = 0;
  setSourceDeps({
    peerFetch: async () => {
      n += 1;
      return new Response(JSON.stringify(status({ steps: { prepared: at }, received: n * MB })));
    },
  } as unknown as SourceDeps);
  const r = createTransport({ tid: "tr_prog0002", side: "source", mode: "move", chatId: "c2", sourceChatId: "c2", title: "t", peer: "laptop", peerLabel: "Laptop", path: "/x.jsonl", folder: "/x", state: "sending", steps: { offered: at, stopped: at, packed: at }, pkg: { sha256: "x", size: 34 * MB } });
  // Bounded by the polls, not by what it waits for: on code that keeps nothing it fails, never hangs.
  const twoReadings = new Promise<TransportRecord>((ok) => {
    const off = onTransportChange((x) => {
      if (x.tid !== r.tid) return;
      if ((((x.ext ?? {}) as { sent?: SentSample[] }).sent?.length ?? 0) >= 2 || n >= 4) {
        off();
        ok(x);
      }
    });
  });
  drive(r.tid);
  const got = await twoReadings;
  updateTransport(r.tid, { state: "cancelled" });
  assert.equal(got.steps.prepared, at, "the destination's step is on the source's record");
  assert.equal(got.steps.packed, at, "its own steps stay");
  const sent = ((got.ext ?? {}) as { sent: SentSample[] }).sent;
  assert.deepEqual(sent.map((s) => s.n), [MB, 2 * MB]);
  assert.ok(sent[1]!.at - sent[0]!.at >= 1000, "each reading has when it was read");
  assert.equal(got.received, 2 * MB);
  assert.equal(readTransport(r.tid)?.state, "cancelled");
});

test("its steps are the destination's as it says them now, its readings the newest few, and a pull begun again starts them again", () => {
  const r = rec({ steps: { offered: at, packed: at, pulled: at, verified: at } });
  const p = therePatch(r, status({ steps: { prepared: at } }), 1)!;
  assert.deepEqual(p.steps, { offered: at, packed: at, prepared: at }, "a step it no longer holds goes; the source's own stay");
  let cur = rec();
  // As updateTransport applies a patch: its ext merged into the record's.
  const apply = (x: TransportRecord, q: Partial<TransportRecord>): TransportRecord => ({ ...x, ...q, ext: { ...x.ext, ...q.ext } });
  for (let i = 0; i < SENT_SAMPLES + 4; i++) cur = apply(cur, therePatch(cur, status({ steps: { prepared: at }, received: i * 100 }), i * 1500)!);
  const sent = ((cur.ext ?? {}) as { sent: SentSample[] }).sent;
  assert.equal(sent.length, SENT_SAMPLES);
  assert.equal(sent[sent.length - 1]!.n, (SENT_SAMPLES + 3) * 100);
  const again = therePatch(cur, status({ steps: { prepared: at }, received: 50 }), 99_000)!;
  assert.deepEqual((again.ext as { sent: SentSample[] }).sent, [{ at: 99_000, n: 50 }]);
  assert.equal(therePatch({ ...rec({ steps: { offered: at, stopped: at, packed: at, prepared: at } }), received: 50 }, status({ steps: { prepared: at } }), 5), null, "nothing new: no write");
});
