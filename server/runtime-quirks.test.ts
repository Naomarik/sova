// The runtime quirk workarounds' logic, in-process: messageBytes, and slicingFetch over a body made
// in-process. Real sockets (the caps, the handshake timeout, slicingFetch over HTTP) and the
// event-loop sampler's timing: runtime-quirks.integration.test.ts.
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { messageBytes, slicingFetch } from "./runtime-quirks";

describe("messageBytes", () => {
  test("counts every form a runtime hands a message over in", () => {
    assert.equal(messageBytes(Buffer.alloc(5)), 5);
    assert.equal(messageBytes(new ArrayBuffer(6)), 6);
    assert.equal(messageBytes(new Uint8Array(7)), 7);
    assert.equal(messageBytes([Buffer.alloc(2), Buffer.alloc(3)]), 5);
    assert.equal(messageBytes("é"), 2);
  });
});

describe("slicingFetch", () => {
  /** A fetch whose response body is `parts`, one per event-loop turn, then (unless `hold`) its end:
      what a server's chunks look like to the reader, with no socket. It honours the request's abort. */
  function sse(parts: Buffer[], hold = false): (input: unknown, init?: { signal?: AbortSignal }) => Promise<Response> {
    return async (_input, init) => {
      let i = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          await new Promise((r) => setImmediate(r));
          if (init?.signal?.aborted) return controller.error(init.signal.reason);
          if (i < parts.length) controller.enqueue(new Uint8Array(parts[i++]!));
          else if (!hold) controller.close();
          else await new Promise(() => {});
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
  }
  const URL_ = "http://sse.invalid/";
  const text = Array.from({ length: 200 }, (_, i) => `data: {"i":${i},"s":"é€😀 \\t "}\n\n`).join("");
  const bytes = Buffer.from(text, "utf8");

  test("passes every byte through, in reads of at most `max`, across UTF-8 sequences split at slice edges", async () => {
    // Chunks cut at odd offsets so multi-byte characters straddle both the writes and the slices.
    const parts: Buffer[] = [];
    for (let at = 0; at < bytes.length; at += 997) parts.push(bytes.subarray(at, at + 997));
    const res = await slicingFetch(sse(parts) as never, 7)(URL_);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    const reader = res.body!.getReader();
    const got: Uint8Array[] = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      assert.ok(value.length <= 7, `a read of ${value.length} bytes`);
      got.push(value);
    }
    assert.ok(Buffer.concat(got).equals(bytes), "byte for byte");
    assert.equal(new TextDecoder().decode(Buffer.concat(got)), text);
  });

  test("an abort mid-stream stops the next read", async () => {
    const ac = new AbortController();
    const res = await slicingFetch(sse([bytes.subarray(0, 4000), bytes.subarray(4000)], true) as never, 100)(URL_, { signal: ac.signal });
    const reader = res.body!.getReader();
    const first = await reader.read();
    assert.equal(first.value!.length, 100);
    ac.abort();
    await assert.rejects(reader.read(), (e: Error) => e.name === "AbortError");
  });
});
