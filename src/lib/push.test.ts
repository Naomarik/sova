// Run: npx tsx --test src/lib/push.test.ts
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { actSessionCount, deviceIdOf, deviceLabel, isAppleMobile, keyBytes } from "./push";

const UA = {
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  ipadAsMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  android: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
  linuxChrome: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  winEdge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0",
  firefox: "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0",
};

test("device labels name the platform and the browser", () => {
  assert.equal(deviceLabel(UA.iphone), "iPhone · Safari");
  assert.equal(deviceLabel(UA.ipadAsMac, 5), "iPad · Safari");
  assert.equal(deviceLabel(UA.ipadAsMac, 0), "Mac · Safari");
  assert.equal(deviceLabel(UA.android), "Android · Chrome");
  assert.equal(deviceLabel(UA.linuxChrome), "Linux · Chrome");
  assert.equal(deviceLabel(UA.winEdge), "Windows · Edge");
  assert.equal(deviceLabel(UA.firefox), "Linux · Firefox");
});

test("an iPad reporting a Mac counts as Apple mobile only with touch", () => {
  assert.equal(isAppleMobile(UA.iphone, 0), true);
  assert.equal(isAppleMobile(UA.ipadAsMac, 5), true);
  assert.equal(isAppleMobile(UA.ipadAsMac, 0), false);
  assert.equal(isAppleMobile(UA.android, 5), false);
});

test("the badge counts sessions in the act tier, once each", () => {
  const it = (id: string, tier: string) => ({ id, tier }) as never;
  assert.equal(actSessionCount({ items: [it("a", "act"), it("a", "act"), it("b", "act"), it("c", "decide")] }), 2);
  assert.equal(actSessionCount(undefined), 0);
});

test("device id matches the server's (sha256 hex, 16 chars); keys decode from base64url", async () => {
  const endpoint = "https://push.example.test/send/abc";
  assert.equal(await deviceIdOf(endpoint), createHash("sha256").update(endpoint).digest("hex").slice(0, 16));
  const raw = Buffer.from([0x04, 0xfb, 0xff, 0x3e, 0x00]);
  assert.deepEqual([...keyBytes(raw.toString("base64url"))], [...raw]);
});
