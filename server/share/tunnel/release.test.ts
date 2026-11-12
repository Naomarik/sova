// Run: pnpm test server/share/tunnel/release.test.ts. The pinned cloudflared table: data only.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { assetFor, assetUrl, CLOUDFLARED_ASSETS, CLOUDFLARED_MAX_BYTES, CLOUDFLARED_VERSION, DOWNLOAD_PLATFORMS, installCommand } from "./release";

describe("the pinned cloudflared release", () => {
  test("a year.month.patch version", () => assert.match(CLOUDFLARED_VERSION, /^\d{4}\.\d{1,2}\.\d+$/));

  test("every platform Sova offers has an asset, and every asset is offered", () => {
    for (const p of DOWNLOAD_PLATFORMS) assert.ok(CLOUDFLARED_ASSETS[p], p);
    assert.deepEqual(Object.keys(CLOUDFLARED_ASSETS).sort(), [...DOWNLOAD_PLATFORMS].sort());
  });

  test("every sum is 64 lowercase hex, every size under the cap, a .tgz names its member", () => {
    for (const [p, a] of Object.entries(CLOUDFLARED_ASSETS)) {
      assert.match(a.sha256, /^[0-9a-f]{64}$/, p);
      assert.ok(a.size > 1_000_000 && a.size <= CLOUDFLARED_MAX_BYTES, p);
      assert.equal(a.name.endsWith(".tgz"), !!a.member, p);
      if (a.member) {
        assert.equal(a.member.name, "cloudflared", p);
        assert.match(a.member.sha256, /^[0-9a-f]{64}$/, p);
        assert.notEqual(a.member.sha256, a.sha256, p);
      }
      assert.ok(a.name.startsWith("cloudflared-"), p);
    }
    const sums = Object.values(CLOUDFLARED_ASSETS).map((a) => a.sha256);
    assert.equal(new Set(sums).size, sums.length, "no sum is pasted twice");
  });

  test("by platform and arch; none for one not offered", () => {
    assert.equal(assetFor("linux", "x64")?.name, "cloudflared-linux-amd64");
    assert.equal(assetFor("darwin", "arm64")?.name, "cloudflared-darwin-arm64.tgz");
    assert.equal(assetFor("win32", "x64"), null);
    assert.equal(assetFor("linux", "ia32"), null);
  });

  test("the URL is the tag's own GitHub asset", () => {
    assert.equal(assetUrl(CLOUDFLARED_ASSETS["linux-x64"]!), `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-amd64`);
  });

  test("an install line for every platform", () => {
    assert.equal(installCommand("darwin"), "brew install cloudflared");
    for (const p of ["linux", "win32", "freebsd"]) assert.ok(installCommand(p).length > 10, p);
  });
});
