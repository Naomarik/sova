// Run: node scripts/run-tests.mjs server/share-preview-proxy.test.ts. The preview proxy's header
// transforms toward the app and toward the visitor, in process. Throwaway PI_CODING_AGENT_DIR; ~/.pi
// untouched. Preview hosts through the real share edge are share-preview-proxy.integration.test.ts.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";


const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-preview-proxy-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent"), { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));
const { appRequestHeaders, hostOnlyCookie, privateCacheControl, visitorResponseHeaders } = await import("./share/preview-proxy");

// ---- the transforms --------------------------------------------------------------------------------

test("toward the app: Host and Origin are localhost's, the Referer's origin too, and nothing forwarded is sent", () => {
  const o = "https://abc.preview.example";
  const h = appRequestHeaders(
    {
      host: "abc.preview.example",
      origin: o,
      referer: `${o}/deep/route?x=1`,
      cookie: "sid=1; theme=dark",
      "x-forwarded-for": "1.2.3.4",
      "x-forwarded-host": "abc.preview.example",
      "x-forwarded-proto": "https",
      forwarded: "for=1.2.3.4",
      "x-real-ip": "1.2.3.4",
      "cf-connecting-ip": "1.2.3.4",
      "cf-ray": "x",
      "true-client-ip": "1.2.3.4",
      "tailscale-user-login": "me",
      "x-sova-preview": "abc",
      connection: "keep-alive, x-drop-me",
      "x-drop-me": "1",
      "keep-alive": "5",
      expect: "100-continue",
      accept: "text/html",
    },
    5173,
    o,
  );
  assert.deepEqual(h, { host: "localhost:5173", origin: "http://localhost:5173", referer: "http://localhost:5173/deep/route?x=1", cookie: "sid=1; theme=dark", accept: "text/html" });
  // Another site's Origin and Referer pass as they are.
  const other = appRequestHeaders({ origin: "https://evil.example", referer: `${o}.evil.example/x` }, 5173, o);
  assert.equal(other.origin, "https://evil.example");
  assert.equal(other.referer, `${o}.evil.example/x`);
});

test("toward the visitor: Location, ACAO, cookies' Domain, Cache-Control and Referrer-Policy; an x-sova-* answer is refused", () => {
  const o = "https://abc.preview.example";
  const out = visitorResponseHeaders(
    [
      "Location", "http://localhost:5173/after?x=1",
      "Access-Control-Allow-Origin", "http://127.0.0.1:5173",
      "Set-Cookie", "sid=1; Domain=localhost; Path=/; HttpOnly",
      "Set-Cookie", "theme=dark; path=/; domain=.localhost",
      "Cache-Control", "public, max-age=600, s-maxage=900",
      "Connection", "keep-alive",
      "Transfer-Encoding", "chunked",
      "Content-Type", "text/html",
    ],
    5173,
    o,
  )!;
  const pairs: [string, string][] = [];
  for (let i = 0; i < out.length; i += 2) pairs.push([out[i]!, out[i + 1]!]);
  assert.deepEqual(pairs, [
    ["Location", `${o}/after?x=1`],
    ["Access-Control-Allow-Origin", o],
    ["Set-Cookie", "sid=1; Path=/; HttpOnly"],
    ["Set-Cookie", "theme=dark; path=/"],
    ["Content-Type", "text/html"],
    ["Cache-Control", "private, max-age=600"],
    ["Referrer-Policy", "same-origin"],
  ]);
  assert.equal(visitorResponseHeaders(["Location", "http://[::1]:5173/"], 5173, o)![1], `${o}/`);
  // Another port, another host, a relative Location: untouched.
  assert.equal(visitorResponseHeaders(["Location", "http://localhost:3000/x"], 5173, o)![1], "http://localhost:3000/x");
  assert.equal(visitorResponseHeaders(["Location", "/login"], 5173, o)![1], "/login");
  assert.equal(visitorResponseHeaders(["Location", "http://localhost:51730/x"], 5173, o)![1], "http://localhost:51730/x");
  // The app's own Referrer-Policy stays.
  assert.deepEqual(visitorResponseHeaders(["Referrer-Policy", "no-referrer"], 5173, o), ["Referrer-Policy", "no-referrer", "Cache-Control", "private"]);
  assert.equal(visitorResponseHeaders(["X-Sova-Mesh", "refused"], 5173, o), null);
  assert.equal(privateCacheControl("no-store"), "no-store");
  assert.equal(privateCacheControl(undefined), "private");
  assert.equal(privateCacheControl("max-age=31536000,immutable"), "private, max-age=31536000, immutable");
  assert.equal(hostOnlyCookie("a=b"), "a=b");
});
