// fetch's shape over a fresh connection per request, never pooled: the lab's laptop-side client.
//
// Why: the harnesses block their event loop for seconds (spawnSync around docker exec, lab chaos). A
// pooled keep-alive socket the server closed meanwhile (Sova and the mock close idle ones after 5 s) is
// still handed out when the loop resumes, before its FIN is read, and the next request fails with
// "other side closed". A socket per request can't be stale. No retry: a failure is a real failure.
//
// What it keeps of fetch, for the callers the lab has:
//   - redirects followed as fetch follows them (301/302/303 → GET with no body; 307/308 keep both), at most 20;
//   - accept-encoding gzip, deflate, br sent and the answer decoded, unless the caller sets accept-encoding;
//   - request bodies: string, Buffer/Uint8Array/ArrayBuffer, URLSearchParams (content-type set when absent);
//   - the answer buffered into a standard Response (no caller streams one: grep res.body/getReader);
//   - errors: a network failure rejects TypeError("fetch failed", { cause }), an abort rejects signal.reason.
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

const NO_BODY = new Set([101, 204, 205, 304]);
const REDIRECT = new Set([301, 302, 303, 307, 308]);

function bodyOf(body, headers) {
  if (body === undefined || body === null) return null;
  if (typeof body === "string") {
    if (!headers.has("content-type")) headers.set("content-type", "text/plain;charset=UTF-8");
    return Buffer.from(body);
  }
  if (body instanceof URLSearchParams) {
    if (!headers.has("content-type")) headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
    return Buffer.from(body.toString());
  }
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  throw new TypeError(`fresh-fetch: unsupported body type ${Object.prototype.toString.call(body)}`);
}

function decode(buf, encoding) {
  const e = (encoding ?? "").trim().toLowerCase();
  if (!e || e === "identity") return buf;
  if (e === "gzip" || e === "x-gzip") return gunzipSync(buf);
  if (e === "deflate") return inflateSync(buf);
  if (e === "br") return brotliDecompressSync(buf);
  throw new TypeError(`fresh-fetch: unsupported content-encoding ${e}`);
}

/** One request over one new socket; resolves { status, statusText, rawHeaders, body: Buffer }. */
function once(url, { method, headers, body, signal }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const h = Object.fromEntries(headers.entries());
    if (body) h["content-length"] = String(body.length);
    const req = send(url, { method, headers: h, agent: false });
    const onAbort = () => {
      req.destroy();
      reject(signal.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const done = () => signal?.removeEventListener("abort", onAbort);
    req.on("error", (err) => {
      done();
      if (signal?.aborted) return reject(signal.reason);
      reject(new TypeError("fetch failed", { cause: err }));
    });
    req.on("response", (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("error", (err) => {
        done();
        reject(signal?.aborted ? signal.reason : new TypeError("fetch failed", { cause: err }));
      });
      res.on("end", () => {
        done();
        resolve({ status: res.statusCode, statusText: res.statusMessage ?? "", rawHeaders: res.rawHeaders, encoding: res.headers["content-encoding"], location: res.headers.location, body: Buffer.concat(chunks) });
      });
    });
    req.end(body ?? undefined);
  });
}

/** fetch(input, init) over a fresh socket per request (see the top of this file). */
export async function freshFetch(input, init = {}) {
  let url = new URL(String(input));
  let method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers ?? {});
  let body = bodyOf(init.body, headers);
  const decodeIt = !headers.has("accept-encoding");
  if (decodeIt) headers.set("accept-encoding", "gzip, deflate, br");
  for (let hops = 0; ; hops++) {
    const r = await once(url, { method, headers, body, signal: init.signal });
    if (REDIRECT.has(r.status) && r.location && (init.redirect ?? "follow") === "follow") {
      if (hops >= 20) throw new TypeError("fetch failed", { cause: new Error("redirect count exceeded") });
      url = new URL(r.location, url);
      if (r.status === 303 || ((r.status === 301 || r.status === 302) && method === "POST")) {
        method = "GET";
        body = null;
        for (const k of ["content-type", "content-length", "content-encoding", "content-language", "content-location"]) headers.delete(k);
      }
      continue;
    }
    const out = new Headers();
    for (let i = 0; i < r.rawHeaders.length; i += 2) out.append(r.rawHeaders[i], r.rawHeaders[i + 1]);
    const empty = NO_BODY.has(r.status) || method === "HEAD";
    let data = empty ? null : r.body;
    if (data && decodeIt && r.encoding) {
      data = decode(data, r.encoding);
      out.delete("content-encoding");
      out.delete("content-length");
    }
    return new Response(data, { status: r.status, statusText: r.statusText, headers: out });
  }
}
