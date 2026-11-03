import assert from "node:assert/strict";
import { test } from "node:test";
import { COMPOSER_HEADER, COMPOSER_PARAM, WIRE_AREAS } from "../../shared/wire-areas";
import { COMPOSER_QUERY, stampInit, stampsRequest } from "./wire-stamp";

const origin = "https://sova.test";

test("every /api request of this origin is stamped, its own or through to a peer; nothing else", () => {
  for (const url of ["/api/chat/frames?path=x", "/api/sessions", "/peer/vps/api/chat/action", `${origin}/api/x`, new URL(`${origin}/peer/a-b/api/x`)]) {
    assert.equal(stampsRequest(url, origin), true, String(url));
  }
  for (const url of ["/ext/a/api/commands/b", "/assets/x.js", "/peer/vps/ws/chat", "https://other.test/api/x", "/apiary"]) {
    assert.equal(stampsRequest(url, origin), false, String(url));
  }
});

test("the number is the page's bundled one, every header it had stays", () => {
  const init = stampInit("/api/x", { method: "POST", body: "{}", keepalive: true, headers: { "content-type": "application/json" } });
  const headers = new Headers(init.headers);
  assert.equal(headers.get(COMPOSER_HEADER), String(WIRE_AREAS.composer));
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(init.keepalive, true);
  assert.equal(init.body, "{}");
  assert.equal(new Headers(stampInit("/api/x", undefined).headers).get(COMPOSER_HEADER), String(WIRE_AREAS.composer));
});

test("a chat socket's query states the same number", () => {
  assert.equal(COMPOSER_QUERY, `${COMPOSER_PARAM}=${WIRE_AREAS.composer}`);
});
