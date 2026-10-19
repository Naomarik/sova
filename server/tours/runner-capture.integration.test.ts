import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { inflateSync } from "node:zlib";
import { normalizeTourScript, type TourScript, type TourTarget } from "../../shared/tour";
import { runTourAttempt, type TourAttemptResult } from "./runner";
import { TourCaptureFailure, TOUR_TARGET_MOVING, TOUR_TARGET_OUTSIDE } from "./targets";
import type { TourRecordingContext } from "./sandbox";

// When a view's page is captured: once it has settled where the view's actions left it. A scrolled page
// captures (before, the page check refused any body above the screen's top, so every scrolled view failed);
// a dashboard bar that grows for ~2 s under a sticky header is marked at its final size; a target that
// never stops moving, and a mark or mask below the fold, fail with their own messages.
const PAGE = `<!doctype html><html><head><style>
  html { scroll-behavior: auto } html.smooth { scroll-behavior: smooth }
  body { margin: 0; font: 18px sans-serif; height: 2400px; position: relative }
  header { position: sticky; top: 0; height: 60px; background: #ddd; z-index: 2 }
  #label { position: absolute; left: 100px; top: 360px; height: 24px; margin: 0 }
  #bar { position: absolute; left: 100px; top: 400px; height: 30px; width: 10px; background: #36c }
  #low { position: absolute; left: 100px; top: 1500px; height: 30px; margin: 0 }
  #band { position: fixed; left: 0; top: 900px; width: 100%; height: 40px; background: #ff0000 }
</style></head><body><header>Made-up dashboard</header>
<h2 id="label">Made-up revenue</h2><div id="bar" data-testid="kpi-bar"></div><p id="low" data-testid="low">Made-up footnote</p><div id="band"></div>
<script>
  const q = new URLSearchParams(location.search);
  if (q.has("smooth")) document.documentElement.classList.add("smooth");
  const bar = document.getElementById("bar");
  // Grows from 10 to 210 px over about 2.2 s after load (a count-up), or forever when "spin".
  addEventListener("load", () => {
    const t0 = performance.now();
    const step = now => {
      const t = now - t0;
      // Constant speed, wrapping: never the same size two frames running (a sine would pause at its turns).
      if (q.has("spin")) { bar.style.width = (10 + (t / 4) % 200) + "px"; requestAnimationFrame(step); return; }
      bar.style.width = (10 + 200 * Math.min(1, t / 2200)) + "px";
      if (t < 2200) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  // A fixed band turns green only once the page rests exactly at the scroll the view asked for.
  const want = Number(q.get("want") ?? -1);
  // "glide": the page scrolls itself to "want" over 1.5 s, starting just after load (scroll restoration, say).
  if (q.has("glide")) addEventListener("load", () => setTimeout(() => {
    const t0 = performance.now();
    const step = now => { const t = Math.min(1, (now - t0) / 1500); scrollTo(0, Math.round(want * t)); if (t < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }, 300));
  addEventListener("scroll", () => { document.getElementById("band").style.background = scrollY === want ? "#00aa00" : "#ff0000"; });
</script></body></html>`;

async function site() {
  const server = createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end(PAGE); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return { origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => { server.closeAllConnections(); server.close(); } };
}
const bar: TourTarget = { kind: "testId", testId: "kpi-bar" };
function script(origin: string, route: string, opts: { scroll?: number; marks?: TourTarget[]; masks?: TourTarget[] }): TourScript {
  const actions = opts.scroll ? [{ op: "scroll" as const, x: 0, y: opts.scroll }] : [];
  const s: TourScript = {
    v: 1, title: "Made-up dashboard", summary: "A dashboard view.", audience: "A reviewer", outcome: "See the dashboard.",
    source: { kind: "site", origin }, chapters: [{ id: "page", title: "Page" }],
    steps: [{ id: "page", chapter: "page", title: "Page", summary: "The page.", views: [{
      id: "view", title: "View", kind: "page", note: "A made-up view.", route, sizes: ["desktop", "phone"],
      actions: { desktop: actions, phone: actions },
      marks: (opts.marks ?? []).map(target => ({ target, label: "Made-up mark.", side: "right" as const })), masks: opts.masks ?? [],
    }] }],
  };
  assert.ok(normalizeTourScript(s), "fixture invalid");
  return s;
}
async function record(s: TourScript, dryRun = true) {
  const root = mkdtempSync(join(tmpdir(), "tour-capture-"));
  const context: TourRecordingContext = { sessionId: "capture", sessionFile: join(root, "chat.jsonl"), cwd: root, agentDir: join(root, "agent"), sandbox: { on: false } };
  try {
    return await runTourAttempt({ context, script: s, tourId: "capture", editionId: "capture-edition", dryRun, beforeContact: async () => {} })
      .then(r => r, (e: unknown) => e instanceof Error ? e : new Error(String(e)));
  } finally { rmSync(root, { recursive: true, force: true }); }
}
// A dry run reports its target problems together (§app.tours/recording): the one problem here is its first.
const outcome = (r: TourAttemptResult | Error) => r instanceof TourCaptureFailure && r.failure.problems ? r.failure.problems[0]!.message : r instanceof Error ? r.message : "recorded";
function pngPixel(png: Uint8Array, x: number, y: number): number[] {
  const buf = Buffer.from(png); const width = buf.readUInt32BE(16); const channels = buf[25] === 6 ? 4 : 3;
  const chunks: Buffer[] = [];
  for (let i = 8; i < buf.length;) { const length = buf.readUInt32BE(i); if (buf.toString("ascii", i + 4, i + 8) === "IDAT") chunks.push(buf.subarray(i + 8, i + 8 + length)); i += length + 12; }
  const raw = inflateSync(Buffer.concat(chunks)); const stride = width * channels;
  let previous = Buffer.alloc(stride);
  for (let row = 0; row <= y; row++) {
    const offset = row * (stride + 1); const filter = raw[offset]!; const current = Buffer.from(raw.subarray(offset + 1, offset + 1 + stride));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? current[i - channels]! : 0; const b = previous[i]!; const c = i >= channels ? previous[i - channels]! : 0;
      const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
      current[i] = (current[i]! + (filter === 1 ? a : filter === 2 ? b : filter === 3 ? Math.floor((a + b) / 2) : filter === 4 ? pa <= pb && pa <= pc ? a : pb <= pc ? b : c : 0)) & 255;
    }
    previous = current;
  }
  return [...previous.subarray(x * channels, x * channels + 3)];
}

test("a scrolled view captures, and a bar still growing under a sticky header is marked at its final size", { timeout: 120_000 }, async () => {
  const s = await site();
  try {
    const result = await record(script(s.origin, "/", { scroll: 250, marks: [bar] }), false);
    assert.equal(outcome(result), "recorded");
    const mark = (result as TourAttemptResult).steps[0]!.views[0]!.captures.desktop!.marks[0]!;
    // 1440 × 960: the bar at x 100, 400 − 250 = 150 down the screen, 210 × 30 once grown.
    assert.ok(Math.abs(mark.x * 1440 - 100) < 1 && Math.abs(mark.y * 960 - 150) < 1, `mark at ${mark.x * 1440},${mark.y * 960}`);
    assert.ok(Math.abs(mark.w * 1440 - 210) < 1 && Math.abs(mark.h * 960 - 30) < 1, `mark sized ${mark.w * 1440}×${mark.h * 960}`);
  } finally { s.close(); }
});

test("a page still scrolling itself isn't captured: the picture is taken where the scroll comes to rest", { timeout: 120_000 }, async () => {
  const s = await site();
  try {
    const result = await record(script(s.origin, "/?glide&want=600", {}), false);
    assert.equal(outcome(result), "recorded");
    const png = (result as TourAttemptResult).assets.get("capture-1-1-desktop.png")!;
    assert.deepEqual(pngPixel(png, 700, 920), [0x00, 0xaa, 0x00], "the band says the page rested at scrollY 600 when pictured");
  } finally { s.close(); }
});

test("a target that never stops moving fails as moving, after the settle wait", { timeout: 120_000 }, async () => {
  const s = await site();
  try {
    assert.equal(outcome(await record(script(s.origin, "/?spin", { marks: [bar] }))), TOUR_TARGET_MOVING);
  } finally { s.close(); }
});

test("a mark or a mask below the fold fails as outside the screen, never scrolled into view", { timeout: 120_000 }, async () => {
  const s = await site();
  try {
    const low: TourTarget = { kind: "testId", testId: "low" };
    assert.equal(outcome(await record(script(s.origin, "/", { marks: [low] }))), TOUR_TARGET_OUTSIDE);
    assert.equal(outcome(await record(script(s.origin, "/", { masks: [low] }))), TOUR_TARGET_OUTSIDE);
    // Control: the same mark brought into view by the view's own scroll.
    assert.equal(outcome(await record(script(s.origin, "/", { scroll: 1300, marks: [low] }))), "recorded");
  } finally { s.close(); }
});
