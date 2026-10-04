// fetch() over a dial-out pairing's channel (§mesh.lan/reverse-channel): the same Request in and
// Response out as fetch, so every caller that dials a tailnet peer by URL dials a dial-out peer
// the same way (server/mesh/dial.ts). Each call is one HTTP/1.1 request on a new CONNECT stream.
//
// The response body streams with backpressure, an abort (or AbortSignal.timeout) rejects with the
// signal's reason exactly as fetch does, and the request carries a fixed Host: nothing names this
// machine or the address the channel runs over.

import http, { type Agent, type IncomingMessage } from "node:http";

export const LAN_HOST = "lan-peer";
const NULL_BODY = new Set([101, 103, 204, 205, 304]);
const HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "host"]);

/** fetch(`http://lan-peer${path}`, init), with every byte going over `agent`'s streams. */
export async function agentFetch(agent: Agent, input: Request | string, init?: RequestInit): Promise<Response> {
  const req = typeof input === "string" ? new Request(new URL(input, `http://${LAN_HOST}`), init) : input;
  const url = new URL(req.url);
  const signal = init?.signal ?? req.signal;
  if (signal?.aborted) throw signal.reason;
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    if (!HOP.has(k)) headers[k] = v;
  });
  headers.host = LAN_HOST;
  const hasBody = req.body !== null && req.method !== "GET" && req.method !== "HEAD";
  if (!hasBody) delete headers["content-length"];
  else if (!headers["content-length"]) headers["transfer-encoding"] = "chunked";

  return await new Promise<Response>((resolve, reject) => {
    let settled = false;
    const out = http.request({ agent, method: req.method, path: `${url.pathname}${url.search}`, headers });
    const onAbort = () => {
      const reason = signal?.reason ?? new DOMException("This operation was aborted", "AbortError");
      out.destroy(reason instanceof Error ? reason : undefined);
      if (!settled) {
        settled = true;
        reject(reason);
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    out.on("error", (err) => {
      signal?.removeEventListener("abort", onAbort);
      if (!settled) {
        settled = true;
        reject(signal?.aborted ? signal.reason : new TypeError("fetch failed", { cause: err }));
      }
    });
    out.on("response", (res: IncomingMessage) => {
      settled = true;
      const h = new Headers();
      for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
        const k = res.rawHeaders[i]!;
        if (!HOP.has(k.toLowerCase())) h.append(k, res.rawHeaders[i + 1]!);
      }
      const status = res.statusCode ?? 502;
      const nullBody = NULL_BODY.has(status) || req.method === "HEAD";
      if (nullBody) res.resume();
      const body = nullBody
        ? null
        : new ReadableStream<Uint8Array>({
            start(controller) {
              let finished = false;
              const fail = (e: unknown) => {
                if (finished) return;
                finished = true;
                controller.error(signal?.aborted ? signal.reason : e);
              };
              res.on("data", (c: Buffer) => {
                if (finished) return;
                controller.enqueue(new Uint8Array(c.buffer, c.byteOffset, c.byteLength));
                if ((controller.desiredSize ?? 1) <= 0) res.pause();
              });
              res.on("end", () => {
                signal?.removeEventListener("abort", onAbort);
                if (finished) return;
                finished = true;
                controller.close();
              });
              res.on("error", fail);
              res.on("close", () => {
                if (!res.complete) fail(new TypeError("terminated"));
              });
            },
            pull() {
              res.resume();
            },
            cancel() {
              res.destroy();
            },
          });
      try {
        resolve(new Response(body, { status: status < 200 || status > 599 ? 502 : status, statusText: res.statusMessage ?? "", headers: h }));
      } catch (err) {
        res.destroy();
        reject(err);
      }
    });
    if (!hasBody) {
      out.end();
      return;
    }
    void (async () => {
      try {
        const reader = req.body!.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!out.write(value)) await new Promise<void>((r) => out.once("drain", () => r()));
        }
        out.end();
      } catch (err) {
        out.destroy(err as Error);
      }
    })();
  });
}
