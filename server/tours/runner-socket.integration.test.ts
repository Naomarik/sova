import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WebSocketServer } from "ws";
import { normalizeTourScript, type TourScript } from "../../shared/tour";
import { TourJobBlocked } from "./queue";
import { runTourAttempt, type TourAttemptResult } from "./runner";
import type { TourRecordingContext } from "./sandbox";

// A made-up development server's live-reload socket against the real recorder (sandbox off, its own
// proxy). On a site that isn't a managed Sova copy, the page's socket is admitted like a request: it
// opens and receives; every frame the page sends (text, binary, its close code and reason) is dropped
// and counted, never sent. An unapproved origin, a private name, a socket after an opening action and
// a /ws/chat path are refused before any upgrade. (Sova-copy socket rules: runner-sova, sova-copy.)
const SECRET_QUERY = "made-up-query-token";
const FRAME = "made-up-frame-content";
const page = (socket: string, opts: { onToggle?: boolean; afterFetch?: string } = {}) => `<!doctype html><html><head><style>body{margin:0;font:18px sans-serif}h1{margin:0 0 12px}</style></head><body><main id="app"><p>Waiting</p><details><summary>More</summary><p>Made-up details.</p></details></main><script>
  const open = () => {
    const s = new WebSocket(${JSON.stringify(socket)});
    let pushed = false, done = false;
    const show = () => { if (pushed && done) document.getElementById("app").insertAdjacentHTML("afterbegin", "<h1>Pushed hello</h1>"); };
    s.onopen = () => {
      s.send(${JSON.stringify(FRAME)}); s.send(new Uint8Array([1, 2, 3]));
      setTimeout(() => { s.send(${JSON.stringify(FRAME)}); s.send(new Uint8Array([4, 5, 6])); s.close(4000, "made-up-close-reason"); done = true; show(); }, 100);
    };
    s.onmessage = e => { if (e.data === "hello") { pushed = true; show(); } };
  };
  ${opts.onToggle ? `document.querySelector("details").addEventListener("toggle", open, { once: true });` : opts.afterFetch ? `fetch(${JSON.stringify(opts.afterFetch)}).then(open);` : "open();"}
</script></body></html>`;

async function site(body?: (self: string) => string, opts: { sova?: boolean } = {}) {
  let upgrades = 0, frames = 0;
  const reasons: string[] = [];
  const headers: IncomingHttpHeaders[] = [];
  const server = createServer((req, res) => { if (opts.sova && req.url === "/api") res.setHeader("x-sova-server", "sova"); res.setHeader("content-type", "text/html"); res.end(body ? body(origin) : "<!doctype html><p>made-up</p>"); });
  const wss = new WebSocketServer({ server });
  wss.on("headers", (_h, req) => { upgrades++; headers.push(req.headers); });
  wss.on("connection", ws => { ws.send("hello"); ws.on("message", () => { frames++; }); ws.on("close", (_code, reason) => { if (reason.length) reasons.push(reason.toString()); }); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;
  return { origin, port, upgrades: () => upgrades, frames: () => frames, reasons, headers, close: () => { for (const c of wss.clients) c.terminate(); wss.close(); server.closeAllConnections(); server.close(); } };
}

function script(origin: string, views: number, opts: { sites?: string[]; open?: boolean } = {}): TourScript {
  const s: TourScript = {
    v: 1, title: "Made-up dev site", summary: "A page with a live-reload socket.", audience: "A reviewer", outcome: "See the page.",
    source: { kind: "site", origin }, ...(opts.sites ? { sites: opts.sites } : {}), chapters: [{ id: "page", title: "Page" }],
    steps: [{ id: "page", chapter: "page", title: "Page", summary: "The page.", views: Array.from({ length: views }, (_, i) => ({
      id: `view-${i + 1}`, title: `View ${i + 1}`, kind: "page" as const, note: "A made-up view.", route: `/?v=${i + 1}`, sizes: ["desktop", "phone"] as ("desktop" | "phone")[],
      actions: opts.open ? { desktop: [{ op: "open" as const, target: { kind: "text" as const, text: "More" } }], phone: [{ op: "open" as const, target: { kind: "text" as const, text: "More" } }] } : {},
      marks: opts.open ? [] : [{ target: { kind: "role" as const, role: "heading" as const, name: "Pushed hello" }, label: "The server's push arrived.", side: "right" as const }], masks: [],
    })) }],
  };
  assert.ok(normalizeTourScript(s), "fixture invalid");
  return s;
}
async function record(s: TourScript, consent: (origin: string) => Promise<void> = async () => {}) {
  const root = mkdtempSync(join(tmpdir(), "tour-ws-"));
  const context: TourRecordingContext = { sessionId: "ws", sessionFile: join(root, "chat.jsonl"), cwd: root, agentDir: join(root, "agent"), sandbox: { on: false } };
  try {
    return await runTourAttempt({ context, script: s, tourId: "ws", editionId: "ws-edition", dryRun: true, beforeContact: consent })
      .then(r => r, (e: unknown) => e instanceof Error ? e : new Error(String(e)));
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const outcome = (r: TourAttemptResult | Error) => r instanceof Error ? `${r.message} ${JSON.stringify((r as { failure?: unknown }).failure ?? "")}` : "recorded";

test("a dev server's socket opens and receives on both sizes; every frame the page sends, and its close reason, is dropped and counted", { timeout: 120_000 }, async () => {
  const s = await site(self => page(`${self.replace("http:", "ws:")}/hmr?token=${SECRET_QUERY}`));
  try {
    const result = await record(script(s.origin, 1));
    assert.equal(outcome(result), "recorded", "the push reached the page (its heading is the view's mark)");
    assert.equal(s.upgrades(), 2, "one socket per size");
    assert.equal(s.frames(), 0, "no page frame reached the server");
    assert.deepEqual(s.reasons, [], "nor the page's close reason");
    // A browser socket handshake carries no added header (setExtraHTTPHeaders doesn't reach it), so the
    // recorder header is absent here; a Sova's /ws/chat is refused by path instead (last test).
    assert.ok(s.headers.every(h => h["x-sova-tour-recorder"] === undefined), "the handshake carries no added header");
    const r = result as TourAttemptResult;
    assert.equal(r.quietAborts, 8, "4 frames per size, counted");
    assert.ok(!JSON.stringify(r).includes(FRAME) && !JSON.stringify(r).includes(SECRET_QUERY), "the report carries a count only");
  } finally { s.close(); }
});

test("a socket to an unapproved origin is refused before any upgrade; once approved it opens", { timeout: 120_000 }, async () => {
  const other = await site();
  const s = await site(() => page(`ws://127.0.0.1:${other.port}/live`));
  try {
    const refused = await record(script(s.origin, 1, { sites: [other.origin] }), async origin => { if (origin === other.origin) throw new TourJobBlocked({ origins: [origin] }); });
    assert.notEqual(outcome(refused), "recorded");
    assert.equal(other.upgrades(), 0);
    // Control: the same declared origin, approved.
    assert.equal(outcome(await record(script(s.origin, 1, { sites: [other.origin] }))), "recorded");
    assert.equal(other.upgrades(), 2);
    assert.equal(other.frames(), 0);
  } finally { s.close(); other.close(); }
});

test("approval revoked mid-attempt: the next socket to that origin is refused", { timeout: 120_000 }, async () => {
  const other = await site();
  const s = await site(() => page(`ws://127.0.0.1:${other.port}/live`));
  try {
    const result = await record(script(s.origin, 2, { sites: [other.origin] }), async origin => { if (origin === other.origin && other.upgrades() >= 1) throw new TourJobBlocked({ origins: [origin] }); });
    assert.notEqual(outcome(result), "recorded");
    assert.equal(other.upgrades(), 1, "only the socket before the revoke opened");
  } finally { s.close(); other.close(); }
});

test("a socket to a name that points at this computer is refused before any upgrade", { timeout: 120_000 }, async () => {
  // Exact "localhost" is policy-controlled like a literal address; an alias of it is a name, checked by DNS.
  const s = await site(self => page(`ws://localhost.:${new URL(self).port}/hmr`));
  try {
    assert.match(outcome(await record(script(s.origin, 1))), /points at this computer or a private network/);
    assert.equal(s.upgrades(), 0);
  } finally { s.close(); }
});

test("a socket opened by the recorder's own opening action fails the attempt with no upgrade", { timeout: 120_000 }, async () => {
  const s = await site(self => page(`${self.replace("http:", "ws:")}/hmr`, { onToggle: true }));
  try {
    assert.match(outcome(await record(script(s.origin, 1, { open: true }))), /An opening or draft action opened a live connection \(\/hmr\)/);
    assert.equal(s.upgrades(), 0);
  } finally { s.close(); }
});

test("a page's /ws/chat socket is refused on an ordinary site too, before any upgrade", { timeout: 120_000 }, async () => {
  const s = await site(self => page(`${self.replace("http:", "ws:")}/ws/chat`));
  try {
    assert.match(outcome(await record(script(s.origin, 1))), /Blocked a live chat connection \(\/ws\/chat\)/);
    assert.equal(s.upgrades(), 0);
  } finally { s.close(); }
});

test("a site that answers as a Sova gets no socket of any path, its live feed included", { timeout: 120_000 }, async () => {
  // The page itself is plain; its first fetch answers as a Sova, and only then does it open the feed.
  const s = await site(self => page(`${self.replace("http:", "ws:")}/ws/watch`, { afterFetch: "/api" }), { sova: true });
  try {
    assert.notEqual(outcome(await record(script(s.origin, 1))), "recorded");
    assert.equal(s.upgrades(), 0);
  } finally { s.close(); }
});
