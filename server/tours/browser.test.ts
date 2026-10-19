import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assertTourBrowserTempPath, discoverTourBrowser, TourBrowserSetupError } from "./browser";

test("longest Chromium socket path fits the worst-case supported parent temp root or refuses clearly", () => {
  const base = "/tmp/sova-test-home-XXXXXX/st-XXXXXX";
  const actualSocket = assertTourBrowserTempPath(base);
  assert.equal(Buffer.byteLength(actualSocket), 93);
  assert.ok(Buffer.byteLength(actualSocket) <= 100);
  // This is the nested layout that made the real installed browser SIGTRAP; it must be
  // distinguished from the supported parent-owned base, not merely match a prefix string.
  assert.throws(() => assertTourBrowserTempPath(`${base}/b-XXXXXX/t`), /too long.*shorter writable TMPDIR/);
  assert.throws(() => assertTourBrowserTempPath(`/tmp/${"long-parent-".repeat(20)}`), /sandbox is never disabled/);
});

test("browser discovery only returns an already installed executable, with a clear refusal", () => {
  const root = mkdtempSync(join(tmpdir(), "tour-browser-"));
  try {
    const browser = join(root, "chromium"); writeFileSync(browser, "fixture, never executed"); chmodSync(browser, 0o700);
    assert.equal(discoverTourBrowser({ PATH: root }, "linux"), browser);
    assert.equal(discoverTourBrowser({ SOVA_TOUR_BROWSER: browser, PATH: "" }, "linux"), browser);
    assert.throws(() => discoverTourBrowser({ PATH: "" }, "linux"), error => error instanceof TourBrowserSetupError && /not installed.*never downloads/.test(error.message));
    assert.throws(() => discoverTourBrowser({ SOVA_TOUR_BROWSER: join(root, "missing"), PATH: root }, "linux"), /Nothing was downloaded/);
    chmodSync(browser, 0o600);
    assert.throws(() => discoverTourBrowser({ PATH: root }, "linux"), /not installed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
