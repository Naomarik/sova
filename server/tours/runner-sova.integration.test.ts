import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WebSocketServer } from "ws";
import { tourScriptFixture } from "../../shared/tour-fixtures";
import { authCookieName, tourRecorderCookieName } from "../auth";
import { runTourAttempt } from "./runner";
import { TourCaptureFailure } from "./targets";
import type { TourRecordingContext } from "./sandbox";

// The recorder's live-connection rule against a stand-in "copy": a plain local http+ws server (not a
// Sova) handed to the real recorder as a verified managed copy through the injected target. Only the
// copy's own /ws/watch opens; any frame the page sends aborts; /ws/chat is refused; a site that is not
// a verified copy gets no socket at all. Every request says it is a recorder; the watch upgrade
// carries exactly the injected cookie.
const TOKEN = "fake-copy-token".padEnd(52, "x");
// The watch URL carries the viewport width in its (allowed) tail key, so the stand-in counts upgrades per captured size.
const page = (socket: string, send: boolean) => `<!doctype html><html><body><main><p>Made-up stand-in page.</p></main><script>
const ws = new WebSocket("ws://" + location.host + ${JSON.stringify(socket)} + (${JSON.stringify(socket)}.includes("?") ? "&" : "?") + "tail=" + innerWidth);
ws.onopen = () => { ${send ? 'ws.send(JSON.stringify({ type: "subscribe" }));' : ""} };
ws.onmessage = () => { const h = document.createElement("h1"); h.textContent = "Saved drafts"; document.querySelector("main").append(h); };
</script></body></html>`;

/** A Cookie header as name → value (a repeated name keeps every value, so a duplicate shows). */
function cookies(header: string | undefined): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const part of (header ?? "").split(";")) { const at = part.indexOf("="); if (at > 0) (out[part.slice(0, at).trim()] ??= []).push(part.slice(at + 1).trim()); }
  return out;
}

/** Marked: the recorder header; for a socket handshake (browsers add no headers there) also the copy-bound marker cookie, exactly. */
async function standIn(marker: string) {
  const counts = { requests: 0, unmarked: 0, frames: 0, upgrades: {} as Record<string, number>, perSize: {} as Record<string, number>, watchCookies: [] as Record<string, string[]>[], phase: "-", marked: [] as string[], unmarkedHits: [] as string[] };
  // Every request or upgrade without the recorder header, with what Chromium said it was.
  const hit = (kind: string, req: import("node:http").IncomingMessage) => `${counts.phase} ${kind} ${req.method} ${new URL(req.url ?? "/", "http://x").pathname} mode=${req.headers["sec-fetch-mode"] ?? "-"} dest=${req.headers["sec-fetch-dest"] ?? "-"} cookie=${req.headers.cookie ? "yes" : "no"}`;
  const server = createServer((req, res) => {
    counts.requests++;
    if (req.headers["x-sova-tour-recorder"] !== "1") { counts.unmarked++; counts.unmarkedHits.push(hit("http", req)); }
    else counts.marked.push(hit("http", req));
    const route = new URL(req.url ?? "/", "http://x").pathname;
    const html = route === "/quiet" ? page("/ws/watch?feed=sessions", false) : route === "/sends" ? page("/ws/watch?feed=sessions", true) : route === "/chat" ? page("/ws/chat?path=x", false) : null;
    if (!html) { res.statusCode = 404; res.end(); return; }
    // Case D: the stand-in, reached as a plain site, answers as the Sova it is.
    if (counts.phase === "D") res.setHeader("x-sova-server", "sova");
    res.setHeader("content-type", "text/html"); res.end(html);
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    counts.upgrades[path] = (counts.upgrades[path] ?? 0) + 1;
    const markedCookie = cookies(req.headers.cookie)[marker]?.length === 1 && cookies(req.headers.cookie)[marker]![0] === "1";
    if (req.headers["x-sova-tour-recorder"] !== "1" && !markedCookie) { counts.unmarked++; counts.unmarkedHits.push(hit("upgrade", req)); }
    if (path === "/ws/watch") { counts.watchCookies.push(cookies(req.headers.cookie)); const w = new URL(req.url ?? "/", "http://x").searchParams.get("tail") ?? "?"; counts.perSize[w] = (counts.perSize[w] ?? 0) + 1; }
    wss.handleUpgrade(req, socket, head, ws => {
      ws.on("message", () => { counts.frames++; });
      ws.send(JSON.stringify({ type: "sessions", rows: [] }));
    });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { origin, counts, close: async () => { for (const c of wss.clients) c.terminate(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); } };
}

test("live connection: only a verified copy's own /ws/watch opens, a page-sent frame aborts, /ws/chat and other sites get no socket", { timeout: 240_000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tour-sova-ws-")));
  const agentDir = join(root, "copy", ".agent");
  mkdirSync(join(agentDir, "sova"), { recursive: true });
  writeFileSync(join(agentDir, "sova", "auth-token"), `${TOKEN}\n`);
  // The marker cookie's name is bound to the copy's state directory, like its sign-in cookie.
  const marker = tourRecorderCookieName(agentDir);
  assert.notEqual(marker, authCookieName(agentDir), "the copy-bound recorder marker cookie has its own name");
  const f = await standIn(marker);
  const context: TourRecordingContext = { sessionId: "sova-ws", sessionFile: join(root, "chat.jsonl"), cwd: root, agentDir: join(root, "agent"), sandbox: { on: false } };
  const attempt = (route: string, managed: boolean) => {
    const script = tourScriptFixture();
    script.source = managed ? { kind: "project", projectId: "sova", instanceId: "copy-s", checkout: join(root, "copy"), serviceId: "server", endpoint: "http" } : { kind: "site", origin: f.origin };
    const view = script.steps[0]!.views[0]!;
    if (view.kind !== "page") throw new Error("fixture");
    view.route = route;
    return runTourAttempt({
      context, script, tourId: "sova-ws", editionId: "sova-ws-edition", dryRun: true, beforeContact: async () => {},
      ...(managed ? { target: async () => ({ origin: f.origin, generation: 1, sova: { agentDir }, assertCurrent: async () => {} }) } : {}),
    });
  };
  const blocked = (pattern: RegExp) => (error: unknown) => error instanceof TourCaptureFailure && pattern.test(error.failure.message);
  try {
    // A: the copy's quiet watch page opens its feed, gets the pushed answer (the heading it adds is
    // the step's target), sends nothing, and carries exactly the injected cookie.
    f.counts.phase = "A";
    await attempt("/quiet", true);
    // One load per captured size (desktop 1440, phone 390), one upgrade each: no reconnect loop.
    assert.deepEqual(f.counts.perSize, { "1440": 1, "390": 1 });
    assert.equal(f.counts.upgrades["/ws/watch"], 2);
    assert.equal(f.counts.frames, 0);
    const injected = { [authCookieName(agentDir)]: [TOKEN], [marker]: ["1"] };
    assert.deepEqual(f.counts.watchCookies, [injected, injected], "every watch upgrade carries exactly the copy's cookie and the recorder marker");
    // B: one frame from the page: the attempt fails and the copy received no frame.
    f.counts.phase = "B";
    await assert.rejects(attempt("/sends", true), blocked(/^Blocked a message the page tried to send on its live connection \(\/ws\/watch\)\.$/));
    assert.equal(f.counts.frames, 0, "the refused frame never reached the copy");
    // C: /ws/chat would start a chat process on a real copy: refused, never upgraded.
    f.counts.phase = "C";
    await assert.rejects(attempt("/chat", true), (error: unknown) => error instanceof TourCaptureFailure && error.failure.message === "Blocked a live chat connection (/ws/chat): this page opens a live chat; record it as reference text or choose an idle view." && error.failure.stepId === "find-draft" && error.failure.viewId === "overview" && !error.failure.message.includes("path=x"));
    assert.equal(f.counts.upgrades["/ws/chat"] ?? 0, 0);
    // D: the same quiet page on a site that is not a verified copy, answering as a Sova: no socket of any path.
    // (A plain site's socket opening is runner-socket.integration's positive case.)
    const watched = f.counts.upgrades["/ws/watch"];
    f.counts.phase = "D";
    await assert.rejects(attempt("/quiet", false), blocked(/^Tours of Sova use a test copy; start one for this branch\.$/));
    assert.equal(f.counts.upgrades["/ws/watch"], watched, "no upgrade for a site");
    assert.equal(f.counts.upgrades["/ws/chat"] ?? 0, 0);
    // Every request and upgrade said it came from a recorder.
    assert.ok(f.counts.requests > 0);
    // Control: the header is seen at all (each case's top-level navigation carries it).
    for (const c of ["A", "B", "C", "D"]) assert.ok(f.counts.marked.some(h => h.startsWith(`${c} http GET /`) && h.includes("mode=navigate")), `case ${c}'s navigation carries the header`);
    assert.deepEqual(f.counts.unmarkedHits, [], "every request carries the recorder header and every upgrade the header or the marker");
    assert.equal(f.counts.unmarked, 0);
    assert.equal(f.counts.watchCookies.length, 3, "A's two sizes and B's first: every watch upgrade was checked");
    // Control for the classification: a plain request with the marker cookie but no header is unmarked
    // (the marker stands in for the header only on a socket handshake).
    f.counts.phase = "E";
    await fetch(`${f.origin}/quiet`, { headers: { cookie: `${marker}=1` } }).then(r => r.text());
    assert.deepEqual((f.counts.unmarkedHits as string[]).map(h => h.split(" ").slice(0, 4).join(" ")), ["E http GET /quiet"]);
  } finally { await f.close(); rmSync(root, { recursive: true, force: true }); }
});
