// Run: pnpm test -- shared/chat-runtime-wire.test.ts. The chat process wire's codec: frames survive
// any chunking, and a broken stream (oversize, empty, not UTF-8, not JSON, no type) is refused.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { encodeFrame, FrameDecoder, FrameError, protoCompatible, type ChatWireFrame } from "./chat-runtime-wire";

const frames: ChatWireFrame[] = [
  { t: "ping", n: 1 },
  { t: "client.send", clientId: "c1", json: JSON.stringify({ type: "append", text: "héllo ✓ 𝄞" }) },
  { t: "touched" },
  { t: "drain", id: "d1", reason: "idle", force: false },
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
  test("this build speaks to itself", () => {
    assert.equal(protoCompatible(1, 1), true);
  });
});
