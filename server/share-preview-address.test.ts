// Run: pnpm exec tsx --test server/share-preview-address.test.ts. The preview address
// (§mesh.public/preview-address): its setting and pin, the Host match, the front guide's wildcard
// steps and notes, and Verify's preview check. Throwaway PI_CODING_AGENT_DIR; ~/.pi untouched.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-preview-address-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent"), { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));

const { parsePreviewUrl, parsePublicLinks, patchPublicLinks, pinnedByEnv, previewPin } = await import("./public-links");
const { previewAddress, previewLabelOfHost, previewOrigin } = await import("./share/preview-address");
const { frontGuide, verifyPreviewUrl } = await import("./share/front");
const { newPreviewLabel } = await import("./preview-links");

const G = { publicUrl: "https://share.example.com", front: "vhost" as const, sharePort: 4802, acceptFrom: "all" as const };

test("a preview address is exactly https://*.<host of two labels or more>; a pin may be http", () => {
  for (const ok of ["https://*.example.com", "https://*.a.example.com", "https://*.example.com:8443"]) assert.equal(parsePreviewUrl(ok, false), ok);
  for (const bad of ["https://example.com", "https://*.com", "https://*.*.example.com", "https://a.*.example.com", "https://*.example.com/", "https://*.Example.com", "http://*.example.com", "https://*.example.com:443", "https://*.example.com/x"])
    assert.equal(parsePreviewUrl(bad, false), null, bad);
  assert.equal(parsePreviewUrl("http://*.preview.test", true), "http://*.preview.test");
  assert.equal(previewPin({ SOVA_SHARE_PREVIEW_URL: " HTTP://*.Preview.Test/ " }), "http://*.preview.test");
  assert.equal(previewPin({ SOVA_SHARE_PREVIEW_URL: "https://preview.test" }), null);
  assert.ok(pinnedByEnv({ SOVA_SHARE_PREVIEW_URL: "https://*.example.com" }).includes("SOVA_SHARE_PREVIEW_URL"));
});

test("the setting keeps previewUrl strictly; a PUT may send capitals, a trailing slash, or empty for none", () => {
  assert.equal(parsePublicLinks({ version: 1, route: "self", gateway: { ...G, previewUrl: "https://*.example.com" } }).gateway?.previewUrl, "https://*.example.com");
  assert.throws(() => parsePublicLinks({ version: 1, route: "self", gateway: { ...G, previewUrl: "https://*.example.com/" } }));
  const r = patchPublicLinks({ route: "self", gateway: { ...G, previewUrl: "HTTPS://*.Example.com/" } });
  assert.ok("file" in r && r.file.gateway?.previewUrl === "https://*.example.com");
  const none = patchPublicLinks({ gateway: { ...G, previewUrl: "" } });
  assert.ok("file" in none && none.file.gateway?.previewUrl === undefined);
  const bad = patchPublicLinks({ gateway: { ...G, previewUrl: "https://*.com" } });
  assert.ok("error" in bad);
  // This host is the gateway: previews point at its own address, once set.
  assert.equal(previewAddress({}, { version: 1, route: "self", gateway: G }).reason, "no-address");
  assert.deepEqual(previewAddress({}, { version: 1, route: "self", gateway: { ...G, previewUrl: "https://*.example.com" } }), { url: "https://*.example.com", source: "setting" });
  assert.equal(previewAddress({ SOVA_SHARE_PREVIEW_URL: "http://*.preview.test" }, { version: 1, route: "off" }).source, "env");
});

test("a Host names a preview only as exactly <label>.<zone>", () => {
  const l = newPreviewLabel();
  const url = "https://*.example.com";
  assert.equal(previewLabelOfHost(`${l}.example.com`, url), l);
  assert.equal(previewLabelOfHost(`${l.toUpperCase()}.EXAMPLE.COM:443`, url), l);
  for (const h of ["example.com", `x.${l}.example.com`, `${l}.example.com.evil.test`, `${l}x.example.com`, `${l}.example.com:8443`, "share.example.com", undefined])
    assert.equal(previewLabelOfHost(h, url), null, String(h));
  assert.equal(previewOrigin(url, l), `https://${l}.example.com`);
});

test("the front guide adds the wildcard name and the notes (one level, explicit records win, no per-name certificates, update first)", () => {
  const g = frontGuide({ ...G, previewUrl: "https://*.example.com" });
  assert.match(g.steps[0]!.text, /server_name share\.example\.com \*\.example\.com;/);
  const notes = (g.notes ?? []).join("\n");
  assert.match(notes, /catches every subdomain of example\.com that has no record of its own; explicit records, like the share host's, still win/);
  assert.match(notes, /one wildcard level/);
  assert.match(notes, /Certificate Transparency/);
  assert.match(notes, /Update Sova on this gateway before adding the wildcard DNS record/);
  assert.match(frontGuide({ ...G, front: "caddy", previewUrl: "https://*.example.com" }).steps[1]!.text, /\*\.example\.com \{/);
  assert.match(frontGuide({ ...G, front: "cloudflared", previewUrl: "https://*.example.com" }).steps[1]!.text, /hostname: "\*\.example\.com"/);
  assert.doesNotMatch(JSON.stringify(frontGuide(G)), /\*\./, "no preview address, no wildcard");
});

test("Verify's preview check passes only on the preview 404 of a random label", async () => {
  const hit: string[] = [];
  const fake = (status: number, body: unknown, nosniff = true) =>
    (async (url: string | URL | Request) => {
      hit.push(String(url));
      return new Response(JSON.stringify(body), { status, headers: nosniff ? { "x-content-type-options": "nosniff" } : {} });
    }) as typeof fetch;
  assert.deepEqual(await verifyPreviewUrl("https://*.example.com", { fetch: fake(404, { code: "preview-not-found" }) }), { ok: true, status: 404 });
  assert.match(hit[0]!, /^https:\/\/[a-z2-7]{52}\.example\.com\/$/);
  assert.equal((await verifyPreviewUrl("https://*.example.com", { fetch: fake(404, { code: "not-found" }) })).ok, false);
  assert.equal((await verifyPreviewUrl("https://*.example.com", { fetch: fake(404, { code: "preview-not-found" }, false) })).ok, false);
  assert.equal((await verifyPreviewUrl("https://*.example.com", { fetch: fake(301, {}) })).ok, false);
  assert.equal((await verifyPreviewUrl("http://*.example.com", { fetch: fake(404, { code: "preview-not-found" }) })).ok, false);
});
