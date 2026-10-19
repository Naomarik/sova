import { lookup } from "node:dns/promises";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, isIP, type AddressInfo, type Socket } from "node:net";
import { isPublicRecordingAddress } from "./browser-addresses";

/**
 * A sandbox-off recording attempt's own proxy (§app.tours/sites): the recording browser's only way
 * out, loopback included, so a connection Chromium opens outside the page's request routing (a
 * speculative prefetch, a preconnect, a redirect hop) still meets the tour's rules. A connection is
 * admitted only when `admit` passes for one of its candidate origins now (the runner decides: this
 * tour's declared or page-requested origins, each through the per-contact consent and source-identity
 * check), before any name is looked up or any address dialled. A named host must then resolve to
 * public addresses only, and the address dialled is the one checked. Loopback, on 127.0.0.1 and a
 * random port.
 */
export interface RunnerProxyOptions {
  /** One connection's candidate origins (a CONNECT has no scheme: https, then http): resolves with the admitted one, rejects when none is. */
  admit(candidates: string[]): Promise<string>;
  /** Test seam: resolve a host name. Defaults to the system resolver. */
  resolve?: (host: string) => Promise<readonly { address: string }[]>;
  /** Every decision, for tests and diagnostics: never a path, header or body. */
  onDecision?: (d: { origin: string; method: string; allowed: boolean }) => void;
}
export interface RunnerProxy {
  /** `http://127.0.0.1:<port>`, for the recording browser's proxy setting. */
  readonly url: string;
  /** Resolves when the proxy stops for any reason; the attempt stops with it. */
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

/** The largest request body the proxy forwards (the recorder sends only reads). */
const PROXY_BODY_MAX = 1024 * 1024;
const hostOf = (host: string) => host.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
const originOf = (scheme: "http" | "https", host: string, port: number) => {
  const h = hostOf(host);
  return new URL(`${scheme}://${isIP(h) === 6 ? `[${h}]` : h}:${port}`).origin;
};

/** The origins a CONNECT to host:port may be for (it carries no scheme): https first, http for port 80 or a WebSocket. */
export function connectCandidates(host: string, port: number): string[] {
  return port === 80 ? [originOf("http", host, port), originOf("https", host, port)] : [originOf("https", host, port), originOf("http", host, port)];
}

export async function startRunnerProxy(opts: RunnerProxyOptions): Promise<RunnerProxy> {
  const resolveHost = opts.resolve ?? (host => lookup(host, { all: true, verbatim: true }));
  const open = new Set<Socket>();
  const track = (s: Socket) => { open.add(s); s.on("close", () => open.delete(s)); s.on("error", () => s.destroy()); };

  /** The first candidate origin admitted now, then the address to dial; else null. */
  const decide = async (candidates: string[], host: string, method: string): Promise<{ origin: string; address: string } | null> => {
    let admitted: string | undefined;
    try { const origin = await opts.admit(candidates); if (candidates.includes(origin)) admitted = origin; } catch { /* refused */ }
    let address: string | undefined;
    if (admitted) {
      const h = hostOf(host);
      if (isIP(h)) address = h;
      else if (h === "localhost") address = "127.0.0.1";
      else {
        try {
          const answers = await resolveHost(h);
          if (answers.length && answers.every(a => isPublicRecordingAddress(a.address))) address = answers[0]!.address;
        } catch { /* unresolvable: refused */ }
      }
    }
    const origin = admitted ?? candidates[0]!;
    try { opts.onDecision?.({ origin, method, allowed: address !== undefined }); } catch { /* diagnostics only */ }
    return admitted && address ? { origin: admitted, address } : null;
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const refuse = () => { if (res.headersSent) return void res.destroy(); res.writeHead(403, { "content-type": "text/plain", connection: "close" }); res.end("Refused by the recording's proxy.\n"); };
    let url: URL;
    try { url = new URL(req.url ?? ""); } catch { return refuse(); }
    if (url.protocol !== "http:" || url.username || url.password) return refuse();
    const port = url.port ? Number(url.port) : 80;
    // Read the request body now, while admission runs: a GET may have ended before an asynchronous
    // decision returns, and a pipe attached afterwards would never end the upstream request, so its
    // headers would never be sent (a server deferring accept until the first byte then never answers).
    const chunks: Buffer[] = [];
    let size = 0, ended = false, tooLarge = false;
    const body = new Promise<void>(done => {
      req.on("data", (c: Buffer) => { size += c.length; if (size > PROXY_BODY_MAX) { tooLarge = true; req.destroy(); done(); } else chunks.push(c); });
      req.on("end", () => { ended = true; done(); });
      req.on("close", () => done());
    });
    void Promise.all([decide([originOf("http", url.hostname, port)], url.hostname, req.method ?? "GET"), body]).then(([v]) => {
      if (!v || tooLarge || !ended) return refuse();
      const headers = { ...req.headers };
      for (const k of Object.keys(headers)) if (k.startsWith("proxy-")) delete headers[k];
      if (res.destroyed || req.socket.destroyed) return;
      const upstream = httpRequest({ host: v.address, port, method: req.method, path: url.pathname + url.search, headers, setHost: false, agent: false }, up => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
        up.on("error", () => res.destroy());
      });
      upstream.on("socket", s => track(s));
      upstream.on("error", () => { if (!res.headersSent) { res.writeHead(502, { connection: "close" }); res.end(); } else res.destroy(); });
      // The browser going away (a cancelled or killed attempt) ends the upstream request with it.
      res.on("close", () => { if (!res.writableFinished) upstream.destroy(); });
      upstream.end(Buffer.concat(chunks));
    });
  });
  // CONNECT carries no scheme: an https origin (TLS) or, for a WebSocket on plain http, the http one.
  server.on("connect", (req: IncomingMessage, client: Socket, head: Buffer) => {
    const refuse = () => client.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
    const m = /^\[([^\]]+)\]:(\d+)$/.exec(req.url ?? "") ?? /^([^:\s]+):(\d+)$/.exec(req.url ?? "");
    const port = Number(m?.[2]);
    if (!m || !(port > 0 && port < 65536)) return refuse();
    let candidates: string[];
    try { candidates = connectCandidates(m[1]!, port); } catch { return refuse(); }
    void decide(candidates, m[1]!, "CONNECT").then(v => {
      if (!v || client.destroyed) return refuse();
      const upstream = connect({ host: v.address, port });
      track(upstream);
      upstream.on("connect", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        upstream.pipe(client); client.pipe(upstream);
      });
      upstream.on("error", () => { if (!client.destroyed) client.end("HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"); });
      client.on("close", () => upstream.destroy());
      upstream.on("close", () => client.destroy());
    });
  });
  server.on("clientError", (_err, socket) => socket.destroy());
  // Every connection, including one the browser opened and never used, so close() never waits on it.
  server.on("connection", (s: Socket) => track(s));
  await new Promise<void>((ok, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", () => { server.off("error", fail); ok(); }); });
  const closed = new Promise<void>(done => server.once("close", () => done()));
  server.on("error", () => { server.close(); });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    closed,
    close: async () => {
      for (const s of open) s.destroy();
      server.closeAllConnections();
      if (server.listening) await new Promise<void>(done => server.close(() => done()));
    },
  };
}
