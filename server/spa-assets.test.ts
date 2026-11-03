// Run: node scripts/run-tests.mjs server/spa-assets.test.ts
// The built frontend's files, in process (server/app.ts, built without a listener, over a scratch
// build in SOVA_DIST; the share listener over one in SOVA_SHARE_DIST): a code file a rebuild removed
// answers 404, never the app's page, so a tab of the older build fails to load it as a missing file
// and its card says Sova was updated; every app route still answers the app's page. Uses a throwaway
// PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

const root = mkdtempSync(join(tmpdir(), "sova-spa-assets-test-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent"); // before the modules below compute their paths
mkdirSync(join(root, "agent", "sessions", "live"), { recursive: true });
const INDEX = '<!doctype html><title>Sova</title><script type="module" src="/assets/index-new.js"></script>';
for (const [dir, key] of [["dist", "SOVA_DIST"], ["dist-share", "SOVA_SHARE_DIST"]] as const) {
  mkdirSync(join(root, dir, "assets"), { recursive: true });
  writeFileSync(join(root, dir, "index.html"), INDEX);
  writeFileSync(join(root, dir, "assets", "index-new.js"), "export {};\n");
  process.env[key] = join(root, dir);
}

const { buildApp } = await import("./app");
const { app } = buildApp({ extensionEntriesOf: async () => [] });
const { createShareApp } = await import("./share/routes");
const share = createShareApp();

after(() => rmSync(root, { recursive: true, force: true }));

describe("the app's built files", () => {
  test("a code file of the build is served", async () => {
    const r = await app.request("/assets/index-new.js");
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /javascript/);
  });
  test("a code file the build doesn't have answers 404, never the app's page", async () => {
    for (const p of ["/assets/TranscriptCard-OLDHASH.js", "/assets/index-old.css", "/assets/nested/gone.js", "/assets/"]) {
      const r = await app.request(p);
      const body = await r.text();
      assert.equal(r.status, 404, `${p}: ${r.status} ${r.headers.get("content-type")}`);
      assert.doesNotMatch(body, /<!doctype html>/i, p);
    }
  });
  test("every app route still answers the app's page", async () => {
    for (const p of ["/", "/s/abc", "/projects/p1/merge", "/assets-guide", "/deep/route/assets/x.js"]) {
      const r = await app.request(p);
      assert.equal(r.status, 200, p);
      assert.equal(await r.text(), INDEX, p);
    }
  });
});

describe("the share page's built files", () => {
  test("a code file the share build doesn't have answers 404", async () => {
    assert.equal((await share.request("/h/assets/index-new.js")).status, 200);
    const r = await share.request("/h/assets/TranscriptCard-OLDHASH.js");
    assert.equal(r.status, 404);
    assert.doesNotMatch(await r.text(), /<!doctype html>/i);
  });
});
