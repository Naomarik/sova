// Run: node scripts/run-tests.mjs server/extensions.test.ts
// Extensions in process: the manifest, the static UI under /ext/<id>/ and /design, through the app
// built without a listener (server/app.ts). A throwaway PI_CODING_AGENT_DIR and SOVA_EXTENSIONS_FILE
// in the OS temp dir (~/.pi is never read or written). Health checks and the HTTP/WS proxies against
// a real backend are extensions.integration.test.ts.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, test } from "node:test";

const tmp = mkdtempSync(join(tmpdir(), "sova-ext-test-"));
process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
process.env.SOVA_EXTENSIONS_FILE = join(tmp, "extensions.json");
mkdirSync(join(tmp, "agent", "sessions", "live"), { recursive: true });

const dist = join(tmp, "dist");
mkdirSync(join(dist, "assets"), { recursive: true });
writeFileSync(join(dist, "index.html"), "<!doctype html><title>stub</title>");
writeFileSync(join(dist, "assets", "app.js"), "console.log('stub')");
writeFileSync(join(tmp, "secret.txt"), "outside dist");

const { buildApp } = await import("./app");
const { app } = buildApp({ extensionEntriesOf: async () => [] });
const { extensionsFile, readExtensions, validateExtension } = await import("./extensions");

/** The backend a manifest names: nothing listens there, and no case here dials it. */
const backendPort = 47_915;

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeManifest(extensions: unknown[], version: unknown = 1): void {
  writeFileSync(process.env.SOVA_EXTENSIONS_FILE!, JSON.stringify({ version, extensions }));
}

const stub = () => ({ id: "stub", title: "Stub", description: "A test double", icon: "branch", dist, api: `http://127.0.0.1:${backendPort}` });

describe("manifest", () => {
  test("the location is overridable, and defaults under the state root", () => {
    assert.equal(extensionsFile(), process.env.SOVA_EXTENSIONS_FILE);
    const saved = process.env.SOVA_EXTENSIONS_FILE;
    delete process.env.SOVA_EXTENSIONS_FILE;
    try {
      assert.equal(extensionsFile(), join(tmp, "agent", "sova", "extensions.json"));
    } finally {
      process.env.SOVA_EXTENSIONS_FILE = saved;
    }
  });

  test("a valid entry keeps its fields; unknown keys are ignored", () => {
    const v = validateExtension({ ...stub(), extra: 1 });
    assert.ok("entry" in v);
    assert.deepEqual(v.entry, { ...stub() });
    const prefixed = validateExtension({ ...stub(), api: "https://localhost:8443/pre/fix" });
    assert.ok("entry" in prefixed);
  });

  test("a bad id, a relative dist or a non-loopback api drops the entry", () => {
    const bad: Record<string, unknown>[] = [
      { id: "a/b" },
      { id: "" },
      { id: ".." },
      { id: 7 },
      { dist: "relative/dist" },
      { dist: undefined },
      { api: "http://example.com:80" },
      { api: "http://10.0.0.1:4840" },
      { api: "http://127.0.0.1.nip.io:4840" },
      { api: "http://127.0.0.1" }, // no port
      { api: "http://127.0.0.1:4840/" }, // trailing slash
      { api: "ftp://127.0.0.1:4840" },
      { api: "http://u:p@127.0.0.1:4840" },
      { api: "http://127.0.0.1:4840?x=1" },
      { api: 4840 },
    ];
    for (const patch of bad) {
      const v = validateExtension({ ...stub(), ...patch });
      assert.ok("error" in v, JSON.stringify(patch));
    }
    assert.ok("error" in validateExtension(null));
    assert.ok("error" in validateExtension([stub()]));
  });

  test("a missing title falls back to the id; an icon that isn't a plain name is dropped", () => {
    const v = validateExtension({ ...stub(), title: undefined, icon: "x);background:url(evil" });
    assert.ok("entry" in v);
    assert.equal(v.entry.title, "stub");
    assert.equal(v.entry.icon, undefined);
  });

  test("a missing, malformed or wrong-version file lists nothing; a later duplicate id is dropped", () => {
    rmSync(process.env.SOVA_EXTENSIONS_FILE!, { force: true });
    assert.deepEqual(readExtensions(), []);
    writeFileSync(process.env.SOVA_EXTENSIONS_FILE!, "{not json");
    assert.deepEqual(readExtensions(), []);
    writeManifest([stub()], 2);
    assert.deepEqual(readExtensions(), []);
    writeManifest([stub(), { ...stub(), title: "Second" }, { ...stub(), id: "bad id" }, { ...stub(), id: "other" }]);
    assert.deepEqual(
      readExtensions().map((e) => [e.id, e.title]),
      [
        ["stub", "Stub"],
        ["other", "Stub"],
      ],
    );
  });
});

describe("GET /api/extensions", () => {
  test("no manifest: an empty list", async () => {
    rmSync(process.env.SOVA_EXTENSIONS_FILE!, { force: true });
    assert.deepEqual(await (await app.request("/api/extensions")).json(), []);
  });
});

describe("static UI", () => {
  beforeEach(() => writeManifest([stub()]));

  test("index.html at /ext/<id>/, uncached; assets as files", async () => {
    const html = await app.request("/ext/stub/");
    assert.equal(html.status, 200);
    assert.match(html.headers.get("content-type") ?? "", /^text\/html/);
    assert.equal(html.headers.get("cache-control"), "no-cache");
    assert.match(await html.text(), /<title>stub<\/title>/);
    const js = await app.request("/ext/stub/assets/app.js");
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type") ?? "", /javascript/);
    assert.equal(await js.text(), "console.log('stub')");
  });

  test("a dotless path is a client route (index.html); a missing file is a 404, not the shell", async () => {
    const route = await app.request("/ext/stub/rows/42");
    assert.equal(route.status, 200);
    assert.match(await route.text(), /<title>stub<\/title>/);
    const missing = await app.request("/ext/stub/assets/missing.js");
    assert.equal(missing.status, 404);
    assert.doesNotMatch(await missing.text(), /<title>/);
  });

  test("nothing outside dist is reachable", async () => {
    for (const p of ["/ext/stub/..%2fsecret.txt", "/ext/stub/%2e%2e/secret.txt", "/ext/stub/assets/..%2f..%2fsecret.txt"]) {
      const res = await app.request(p);
      assert.equal(res.status, 404, p);
      assert.notEqual(await res.text(), "outside dist", p);
    }
  });

  test("/ext/<id> redirects to the slash form; an unknown id is a 404 on every surface", async () => {
    const res = await app.request("/ext/stub");
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/ext/stub/");
    const page = await app.request("/ext/nope/");
    assert.equal(page.status, 404);
    assert.equal(await page.text(), "Unknown extension");
    for (const p of ["/ext/nope/api/x", "/ext/nope/ws/x"]) {
      const r = await app.request(p);
      assert.equal(r.status, 404, p);
      assert.deepEqual(await r.json(), { error: "Unknown extension" });
    }
  });
});

describe("/design", () => {
  test("tokens.css and base.css are served as CSS, uncached; nothing else is", async () => {
    for (const name of ["tokens.css", "base.css"]) {
      const res = await app.request(`/design/${name}`);
      assert.equal(res.status, 200, name);
      assert.match(res.headers.get("content-type") ?? "", /^text\/css/);
      assert.equal(res.headers.get("cache-control"), "no-cache");
      assert.ok((await res.text()).length > 100);
    }
    // Paths that stay under /design after URL normalization (a literal "/design/../x" would be
    // resolved to "/x" before routing and never reach these handlers). None may fall through to
    // the SPA shell, which answers 200 whenever dist/ exists.
    for (const p of ["/design/align-viewer.css", "/design/package.json", "/design/..%2fpackage.json", "/design/"]) {
      assert.equal(new URL(p, "http://x").pathname.startsWith("/design/"), true, `${p} must reach /design`);
      const res = await app.request(p);
      assert.equal(res.status, 404, p);
      assert.doesNotMatch(await res.text(), /"name"|<!doctype/i, p);
    }
  });
});
