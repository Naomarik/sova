// Run: node scripts/run-tests.mjs server/share-listener.test.ts. The share edge's allowlist, its
// limiters and client address, and the frame host's answers, in process with a throwaway
// PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi untouched. The share server on a real loopback port
// is share-listener.integration.test.ts.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, after } from "node:test";


const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-share-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sessions"), { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));

const { clientAddress, RateLimiter, shareMayReach } = await import("./share/listener");
const { tokenLimited, MESSAGES_PER_MINUTE } = await import("./share/routes");

const TOKEN = "A".repeat(43);

test("the allowlist: exact shapes on the raw path, nothing else", () => {
  const yes: [string, string][] = [
    ["GET", `/h/${TOKEN}`],
    ["HEAD", `/h/${TOKEN}`],
    ["GET", "/h/assets/index-abc.js"],
    ["GET", `/api/h/${TOKEN}`],
    ["POST", `/api/h/${TOKEN}/message`],
  ];
  const no: [string, string][] = [
    ["GET", "/"],
    ["GET", "/index.html"],
    ["GET", "/api/sessions"],
    ["GET", "/api/orgs"],
    ["POST", "/api/sessions/prompt"],
    ["GET", "/ws/chat"],
    ["GET", "/ws/watch"],
    ["GET", "/peer/x/api/sessions"],
    ["GET", "/ext/x/"],
    ["GET", "/explain/x"],
    ["GET", "/h/assets/.hidden"],
    ["GET", "/h/assets/a/b.js"],
    ["GET", `/h/${TOKEN}x`],
    ["GET", `/api/h/${TOKEN}/message`],
    ["POST", `/api/h/${TOKEN}`],
    ["GET", `/api/%68/${TOKEN}`],
    ["GET", `/h/${TOKEN.slice(0, 40)}%41%41%41`],
    ["DELETE", `/api/h/${TOKEN}`],
  ];
  for (const [m, p] of yes) assert.equal(shareMayReach(m, p), true, `${m} ${p}`);
  for (const [m, p] of no) assert.equal(shareMayReach(m, p), false, `${m} ${p}`);
});

test("limits: 10 messages a minute per token; the per-address limiter; the proxy's client address", () => {
  const t0 = 1_000_000;
  for (let i = 0; i < MESSAGES_PER_MINUTE; i++) assert.equal(tokenLimited("tok-a", t0 + i), false);
  assert.equal(tokenLimited("tok-a", t0 + 100), true);
  assert.equal(tokenLimited("tok-b", t0 + 100), false, "per token");
  assert.equal(tokenLimited("tok-a", t0 + 60_001), false, "a sliding minute");
  const r = new RateLimiter(2);
  assert.deepEqual([r.limited("x", 1), r.limited("x", 2), r.limited("x", 3), r.limited("y", 3)], [false, false, true, false]);
  const req = (peer: string, xff?: string) => ({ socket: { remoteAddress: peer }, headers: xff ? { "x-forwarded-for": xff } : {} });
  assert.equal(clientAddress(req("127.0.0.1", "203.0.113.9")), "203.0.113.9", "behind the local proxy");
  assert.equal(clientAddress(req("100.101.1.2", "198.51.100.1, 203.0.113.9")), "203.0.113.9", "behind a tailnet proxy: the hop it appended");
  assert.equal(clientAddress(req("203.0.113.50", "1.2.3.4")), "203.0.113.50", "a direct client can't choose its address");
});

// The frame host of interactive drawings (§app.baton/share-listener, §chat.markdown/visuals).
test("the frame host is the one HTML asset: its own sandbox CSP and SAMEORIGIN; every other answer stays DENY", async () => {
  const { createShareApp, PAGE_CSP } = await import("./share/routes");
  const host = await import("../shared/vis-frame-host");
  const { FRAME_MESSAGE } = await import("../src/vis/kinds/frame/srcdoc");
  const dist = join(root, "dist-frame");
  mkdirSync(join(dist, "assets"), { recursive: true });
  appendFileSync(join(dist, "index.html"), "<!doctype html><p>page</p>");
  appendFileSync(join(dist, "assets", host.FRAME_HOST_NAME), host.FRAME_HOST_HTML);
  appendFileSync(join(dist, "assets", "page.html"), "<script>1</script>");
  appendFileSync(join(dist, "assets", "a.js"), "1");
  const was = process.env.SOVA_SHARE_DIST;
  process.env.SOVA_SHARE_DIST = dist;
  try {
    const app = createShareApp();
    assert.equal(shareMayReach("GET", host.FRAME_HOST_PATH), true, "the edge's asset shape already admits it");
    const frame = await app.request(host.FRAME_HOST_PATH);
    assert.equal(frame.status, 200);
    assert.equal(frame.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(frame.headers.get("content-security-policy"), host.FRAME_HOST_CSP);
    assert.equal(frame.headers.get("x-frame-options"), "SAMEORIGIN");
    assert.equal(frame.headers.get("cache-control"), "no-store");
    assert.equal(frame.headers.get("x-content-type-options"), "nosniff");
    assert.equal(await frame.text(), host.FRAME_HOST_HTML);
    for (const directive of ["sandbox allow-scripts", "default-src 'none'", "form-action 'none'", "base-uri 'none'", "frame-ancestors 'self'"]) assert.ok(host.FRAME_HOST_CSP.split("; ").includes(directive), directive);
    assert.doesNotMatch(host.FRAME_HOST_CSP, /allow-same-origin|connect-src|https?:/);
    // Any other .html asset is no HTML here, and nothing else may be framed.
    const other = await app.request("/h/assets/page.html");
    assert.equal(other.headers.get("content-type"), "application/octet-stream");
    assert.equal(other.headers.get("x-frame-options"), "DENY");
    assert.equal((await app.request("/h/assets/a.js")).headers.get("x-frame-options"), "DENY");
    const page = await app.request(`/h/${TOKEN}`);
    assert.equal(page.headers.get("x-frame-options"), "DENY");
    assert.equal(page.headers.get("content-security-policy"), PAGE_CSP);
    // The page frames only its own host, and still runs no inline script and no blob:/data: frame.
    const csp = Object.fromEntries(PAGE_CSP.split("; ").map((d) => [d.split(" ")[0], d.split(" ").slice(1)]));
    assert.deepEqual(csp["frame-src"], ["'self'"]);
    assert.deepEqual(csp["script-src"], ["'self'"]);
    assert.deepEqual(csp["frame-ancestors"], ["'none'"]);
    assert.equal(host.FRAME_HOST_MESSAGE, FRAME_MESSAGE, "the page posts what the host takes");
    assert.equal((host.FRAME_HOST_HTML.match(/<script>/g) ?? []).length, 1);
    assert.match(host.FRAME_HOST_HTML, /delete window\.RTCPeerConnection;delete window\.webkitRTCPeerConnection/);
  } finally {
    if (was === undefined) delete process.env.SOVA_SHARE_DIST;
    else process.env.SOVA_SHARE_DIST = was;
  }
});
