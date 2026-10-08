// Run: pnpm test -- server/mesh/proxy-pairing.test.ts
// A peer's answers (a tailnet peer's or a dial-out pairing's) as this host's browser may see them
// (§mesh.remote-sessions/proxy): a type allowlist, and no 401/407 that would lock the page out.
import assert from "node:assert/strict";
import { test } from "node:test";
import { hardenPeerResponse } from "./proxy";

const answer = (status: number, type: string | null, extra: Record<string, string> = {}) =>
  // Bytes, not a string: a string body would get a text/plain type from Response itself on Node.
  hardenPeerResponse(new Response(status === 204 ? null : new Uint8Array([120]), { status, headers: { ...(type ? { "content-type": type } : {}), ...extra } }));

test("only JSON, plain text and raster images keep their type; anything else is a download", () => {
  for (const type of ["application/json", "application/json; charset=utf-8", "text/plain;charset=utf-8", "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "IMAGE/PNG"]) {
    const res = answer(200, type);
    assert.equal(res.headers.get("content-type"), type, type);
    assert.equal(res.headers.get("content-disposition"), null, type);
  }
  for (const type of [null, "text/html", "image/svg+xml", "application/xml", "text/xsl", "text/javascript", "application/pdf", "multipart/x-mixed-replace; boundary=x", "text/css", "application/x-unknown", "application/octet-stream", "text/plain-ish"]) {
    const res = answer(200, type, { "content-disposition": "inline" });
    assert.equal(res.headers.get("content-type"), "application/octet-stream", String(type));
    assert.equal(res.headers.get("content-disposition"), "attachment", String(type));
  }
});

test("a 401 or 407 from a pairing is 502, so the page never reads it as its own lock-out", () => {
  assert.equal(answer(401, "application/json").status, 502);
  assert.equal(answer(407, "application/json").status, 502);
  for (const s of [200, 204, 302, 403, 404, 500]) assert.equal(answer(s, "application/json").status, s);
});

test("every answer carries the sandbox CSP and nosniff, and no header outside the list", () => {
  const res = answer(200, "application/json", { "set-cookie": "a=1", location: "https://evil.example/", "x-other": "1" });
  assert.equal(res.headers.get("content-security-policy"), "sandbox; default-src 'none'");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  for (const h of ["set-cookie", "location", "x-other"]) assert.equal(res.headers.get(h), null, h);
});

test("a download keeps the peer's own attachment file name; any other disposition is a bare attachment", () => {
  assert.equal(answer(200, "application/zip", { "content-disposition": 'attachment; filename="a b.zip"' }).headers.get("content-disposition"), 'attachment; filename="a b.zip"');
  assert.equal(answer(200, "application/zip", { "content-disposition": "ATTACHMENT; filename*=UTF-8''x.zip" }).headers.get("content-disposition"), "ATTACHMENT; filename*=UTF-8''x.zip");
  assert.equal(answer(200, "text/html", { "content-disposition": 'inline; filename="x.html"' }).headers.get("content-disposition"), "attachment");
  assert.equal(answer(200, "image/png", { "content-disposition": 'inline; filename="x.png"' }).headers.get("content-disposition"), 'inline; filename="x.png"', "a passive type keeps its own");
});
