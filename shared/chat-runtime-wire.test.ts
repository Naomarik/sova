// Run: pnpm test -- shared/chat-runtime-wire.test.ts. The chat process wire's codec: frames survive
// any chunking, and a broken stream (oversize, empty, not UTF-8, not JSON, no type) is refused.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SpecialSpec } from "./chat-runtime";
import {
  ASK_POLICY,
  CHAT_WIRE_MIN_PROTO,
  CHAT_WIRE_PROTO,
  encodeFrame,
  FrameDecoder,
  FrameError,
  protoCompatible,
  SERVER_ACTIONS,
  type ChatWireFrame,
} from "./chat-runtime-wire";
import type { HEntry } from "./harness-history";

const frames: ChatWireFrame[] = [
  { t: "ping", n: 1 },
  { t: "client.send", clientId: "c1", json: JSON.stringify({ type: "append", text: "héllo ✓ 𝄞" }) },
  { t: "touched" },
  { t: "drain", id: "d1", reason: "idle", force: false },
  // The start-up trail's step (§app.chat-processes/boot-log): additive, not a kernel frame.
  { t: "boot", phase: "starting", step: "extensions start", stepMs: 12_000, totalMs: 13_500 },
];
const bytes = () => {
  const parts = frames.map((f) => encodeFrame(f));
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  return all;
};
const raw = (body: Uint8Array) => {
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, body.length, false);
  out.set(body, 4);
  return out;
};

describe("chat-runtime wire codec", () => {
  test("frames joined in one chunk come out in order", () => {
    assert.deepEqual(new FrameDecoder().push(bytes()), frames);
  });

  test("every split point, and one byte at a time", () => {
    const all = bytes();
    for (let cut = 0; cut <= all.length; cut++) {
      const d = new FrameDecoder();
      const out = [...d.push(all.subarray(0, cut)), ...d.push(all.subarray(cut))];
      assert.deepEqual(out, frames, `cut at ${cut}`);
      assert.equal(d.pending, 0);
    }
    const d = new FrameDecoder();
    const out = [];
    for (let i = 0; i < all.length; i++) out.push(...d.push(all.subarray(i, i + 1)));
    assert.deepEqual(out, frames);
  });

  test("a multi-byte character split across chunks decodes whole", () => {
    const one = encodeFrame({ t: "client.send", clientId: "c", json: "𝄞𝄞𝄞" });
    const d = new FrameDecoder();
    // cut inside the 4-byte character's encoding
    const mid = one.length - 5;
    assert.deepEqual([...d.push(one.subarray(0, mid)), ...d.push(one.subarray(mid))], [{ t: "client.send", clientId: "c", json: "𝄞𝄞𝄞" }]);
  });

  test("an incomplete frame waits for the rest", () => {
    const one = encodeFrame({ t: "ping", n: 7 });
    const d = new FrameDecoder();
    assert.deepEqual(d.push(one.subarray(0, 3)), []);
    assert.deepEqual(d.push(one.subarray(3, 6)), []);
    assert.equal(d.pending, 2); // the length was read: two bytes of the body wait
    assert.deepEqual(d.push(one.subarray(6)), [{ t: "ping", n: 7 }]);
  });

  test("a frame above the limit is refused on both ends", () => {
    assert.throws(() => encodeFrame({ t: "client.send", clientId: "c", json: "x".repeat(100) }, 64), FrameError);
    const big = encodeFrame({ t: "client.send", clientId: "c", json: "x".repeat(100) });
    const d = new FrameDecoder({ max: 64 });
    assert.throws(() => d.push(big.subarray(0, 4)), /above the 64-byte limit/);
    // spent: everything after is refused too
    assert.throws(() => d.push(encodeFrame({ t: "ping", n: 1 })), FrameError);
  });

  test("a large frame is reported, and still read", () => {
    const seen: number[] = [];
    const one = encodeFrame({ t: "client.send", clientId: "c", json: "x".repeat(200) });
    const d = new FrameDecoder({ warnAt: 100, onLarge: (n) => seen.push(n) });
    assert.equal(d.push(one).length, 1);
    assert.equal(seen.length, 1);
    assert.ok(seen[0]! > 200);
  });

  test("a zero-length frame breaks the stream", () => {
    assert.throws(() => new FrameDecoder().push(raw(new Uint8Array(0))), /zero-length/);
  });

  test("bytes that aren't UTF-8 break the stream", () => {
    assert.throws(() => new FrameDecoder().push(raw(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]))), /UTF-8/);
  });

  test("text that isn't JSON, or JSON without a type, breaks the stream", () => {
    const enc = (s: string) => raw(new TextEncoder().encode(s));
    assert.throws(() => new FrameDecoder().push(enc("{nope")), /JSON/);
    for (const s of ["[1,2]", "null", '"t"', '{"t":1}', "{}"]) assert.throws(() => new FrameDecoder().push(enc(s)), /object with a type/, s);
  });

  test("frames before a broken one are lost with it (the link closes)", () => {
    const good = encodeFrame({ t: "ping", n: 1 });
    const bad = raw(new TextEncoder().encode("{nope"));
    const both = new Uint8Array(good.length + bad.length);
    both.set(good);
    both.set(bad, good.length);
    assert.throws(() => new FrameDecoder().push(both), FrameError);
  });
});

describe("protocol versions", () => {
  const own = { proto: 5, minProto: 4 };
  test("N meets N and N-1, both ways", () => {
    assert.equal(protoCompatible(5, 4, own), true);
    assert.equal(protoCompatible(4, 3, own), true);
    assert.equal(protoCompatible(6, 5, own), true); // a newer peer that still speaks to 5
  });
  test("N-2, or a peer that no longer accepts N, is refused", () => {
    assert.equal(protoCompatible(3, 2, own), false);
    assert.equal(protoCompatible(7, 6, own), false);
    assert.equal(protoCompatible(Number.NaN, 0, own), false);
  });
  test("this build speaks to itself, and to a stage-2 (proto 1) and stage-3 (proto 2) peer either way", () => {
    assert.equal(CHAT_WIRE_PROTO, 3);
    // a stage-3 runtime or server: it reads this build's frames, and this build reads its own
    assert.equal(protoCompatible(2, 1), true);
    assert.equal(protoCompatible(CHAT_WIRE_PROTO, CHAT_WIRE_MIN_PROTO, { proto: 2, minProto: 1 }), true);
    assert.equal(protoCompatible(CHAT_WIRE_PROTO, CHAT_WIRE_MIN_PROTO), true);
    // a proto-1 runtime's hello, read by this server; a proto-1 server's control, read by this runtime
    assert.equal(protoCompatible(1, 1), true);
    assert.equal(protoCompatible(1, 0), true);
    // what a proto-1 side computes for this build's frames
    assert.equal(protoCompatible(CHAT_WIRE_PROTO, CHAT_WIRE_MIN_PROTO, { proto: 1, minProto: 1 }), true);
  });
});

describe("stage-3 frames (proto 2)", () => {
  const spec: SpecialSpec = {
    kind: "baton",
    extension: "sova-baton",
    cwd: "/w/b",
    tools: [{ name: "record_decision", label: "Record decision", description: "d", parameters: { type: "object" }, prepares: "owner-area" }],
    customTools: [],
    allow: ["record_decision"],
    loader: { noExtensions: true, append: "none" },
    model: null,
    thinking: null,
    replyText: true,
    hooks: {},
    context: "baton",
    refuses: { mode: "no modes here" },
    clientSend: true,
    composerClosed: null,
    start: { prompt: { customPrompt: "p", appendSystemPrompt: "", contextFiles: [], skills: [], cwd: "(none)" }, baton: { names: { u1: "Ann" }, holder: "u1", holderTexts: [], vocabulary: [] } },
  };
  const entry = { kind: "custom", id: "e2", parentId: "e1", timestamp: "2026-10-12T00:00:00.000Z", customType: "x", data: { a: 1 } } as unknown as HEntry;
  const s3: ChatWireFrame[] = [
    { t: "open", id: "o1", path: "/s.jsonl", force: false, link: null, served: [], special: spec },
    { t: "run", n: 1, event: { type: "run.start", tag: "look:1" } },
    { t: "run", n: 2, event: { type: "user.end", card: "c1" } },
    { t: "run.ack", n: 2 },
    { t: "ask", id: "a1", method: "special.runStart", args: { leafId: null, images: true } },
    { t: "answer", id: "a1", ok: true, result: spec.start },
    { t: "tool.call", call: { effectId: "e#1", chatId: "/s.jsonl", toolCallId: "@clientSend", name: "@clientSend", params: { images: 0, text: "hi" }, attended: true, card: null }, ctx: { sessionId: "s", cwd: "/w", leafId: null, title: null } },
    { t: "tool.back", effectId: "e#1", id: "b1", op: "append", kind: "baton-x", data: { a: 1 }, announce: true },
    { t: "tool.back", effectId: "e#1", id: "b2", op: "tool", name: "agent_spawn", toolCallId: "tc", params: { task: "t" } },
    { t: "tool.backResult", id: "b1", ok: true, result: { entryId: "e2", entry } },
    { t: "tool.backResult", id: "b2", ok: false, error: { message: "That tool call is no longer running." } },
    { t: "push", kind: "special", composerClosed: "This project is archived." },
  ];
  test("round-trip through the codec", () => {
    const d = new FrameDecoder();
    assert.deepEqual(
      s3.flatMap((f) => d.push(encodeFrame(f))),
      s3,
    );
  });
  test("every ask has a policy; the stage-2 asks read as nothing, the new ones wait", () => {
    for (const m of ["project.note", "playbook.bundleFor", "playbook.reprime", "links", "singleton"] as const) assert.equal(ASK_POLICY[m], "nothing", m);
    for (const [m, p] of Object.entries(ASK_POLICY)) if (m.startsWith("special.") || m.startsWith("powers.")) assert.equal(p, "wait", m);
  });
  test("server actions are reserved names no tool can take", () => {
    for (const a of SERVER_ACTIONS) assert.match(a, /^@/);
  });
});
