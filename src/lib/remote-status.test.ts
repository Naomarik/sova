// Run: npx tsx --test src/lib/remote-status.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { isRemoteNotice, parseRemoteStatus, remoteStatusAsker, REMOTE_SILENT_MS, REMOTE_STALE_MS, type RemoteEntry, remoteView } from "./remote-status";

const T0 = 1_800_000_000_000;
const entry = (status: object | null, over: Partial<RemoteEntry> = {}): RemoteEntry => ({
  target: "box",
  status: status ? parseRemoteStatus(JSON.stringify(status)) : null,
  since: T0,
  receivedAt: status ? T0 : null,
  ...over,
});

test("parseRemoteStatus reads the extension's JSON and refuses anything else", () => {
  const s = parseRemoteStatus(JSON.stringify({ state: "unreachable", pinned: false, lastOkAt: 5, error: "ssh: connect refused\nmore", channelState: "dead", at: 9 }));
  assert.deepEqual(s, {
    state: "unreachable",
    host: undefined,
    latencyMs: undefined,
    pinned: false,
    channelState: "dead",
    channelRetryAt: undefined,
    lastOkAt: 5,
    runningMs: undefined,
    error: "ssh: connect refused",
    at: 9,
  });
  assert.equal(parseRemoteStatus("⇄ box · unreachable"), null);
  assert.equal(parseRemoteStatus(JSON.stringify({ state: "green" })), null);
  assert.equal(parseRemoteStatus(undefined), null);
  assert.equal(parseRemoteStatus(JSON.stringify({ state: "online", channelState: "weird" }))?.channelState, undefined);
});

test("nothing reported says checking…, then admits there's no status; never green", () => {
  assert.equal(remoteView(entry(null), T0 + 1000).word, "checking…");
  assert.equal(remoteView(entry(null), T0 + 1000).tone, undefined);
  assert.equal(remoteView(entry(null), T0 + REMOTE_SILENT_MS).word, "no status");
  assert.equal(remoteView(entry({ state: "unknown", pinned: false, lastOkAt: 0 }), T0).word, "checking…");
  assert.equal(remoteView(entry({ state: "unknown", pinned: false, lastOkAt: 0 }), T0).tone, undefined);
});

test("online is green only while the last success is recent; an old one says its age", () => {
  const s = { state: "online", host: "u@h", pinned: true, channelState: "idle", latencyMs: 38.4, lastOkAt: T0 - 42_000, at: T0 };
  const v = remoteView(entry(s), T0);
  assert.equal(v.word, "connected");
  assert.equal(v.tone, "success");
  assert.equal(v.age, "42s ago");
  assert.match(v.title, /Latency 38 ms/);
  assert.match(v.title, /Fast channel pinned, idle/);
  const old = remoteView(entry(s), T0 + REMOTE_STALE_MS);
  assert.equal(old.word, "last ok");
  assert.equal(old.tone, undefined);
  assert.equal(old.age, "2m ago");
});

test("ages use the reporter's clock, so a skewed browser clock can't freshen them", () => {
  // The report was made at T0 (server clock) and landed at T0 + 1h on a browser an hour ahead.
  const e = entry({ state: "online", pinned: false, lastOkAt: T0 - 10_000, at: T0 }, { receivedAt: T0 + 3_600_000 });
  assert.equal(remoteView(e, T0 + 3_600_000 + 5_000).age, "15s ago");
});

test("unreachable carries the error's first line; running time ticks on between reports", () => {
  const v = remoteView(entry({ state: "unreachable", pinned: false, lastOkAt: 0, error: "Connection timed out" }), T0);
  assert.equal(v.word, "unreachable");
  assert.equal(v.tone, "error");
  assert.equal(v.error, "Connection timed out");
  assert.equal(v.age, "never");
  assert.match(v.title, /^Connection timed out/);
  const r = remoteView(entry({ state: "online", pinned: true, channelState: "busy", lastOkAt: T0, runningMs: 7_000, at: T0 }), T0 + 5_000);
  assert.equal(r.running, "running 12s");
  assert.doesNotMatch(r.title, /hung|stuck/i);
});

test("remote notices are recognised by their prefix", () => {
  assert.ok(isRemoteNotice("remote: box unreachable: timed out"));
  assert.ok(!isRemoteNotice("Copied path."));
  assert.ok(!isRemoteNotice("remotely"));
});

test("/remote status is asked at most once per hello, and only when the runtime offers it", () => {
  const remote = [{ name: "compact" }, { name: "remote" }];
  const a = remoteStatusAsker(true);
  assert.equal(a.commands(remote), false, "no hello yet (a runtime reload's commands): nothing");
  a.hello();
  assert.equal(a.commands([{ name: "compact" }]), false, "the extension isn't loaded: nothing");
  assert.equal(a.commands(remote), true);
  assert.equal(a.commands(remote), false, "a second commands message on the same socket: nothing");
  a.hello(); // a reconnect
  assert.equal(a.commands(remote), true);
  const local = remoteStatusAsker(false);
  local.hello();
  assert.equal(local.commands(remote), false, "a local session never asks");
});

test("a rate-limited channel is its own line, never the chip's word or a red dot", () => {
  const s = { state: "online", host: "u@h", pinned: false, channelState: "rate-limited", channelRetryAt: T0 + 20_000, lastOkAt: T0 - 5_000, at: T0 };
  assert.equal(parseRemoteStatus(JSON.stringify(s))?.channelRetryAt, T0 + 20_000);
  const v = remoteView(entry(s), T0 + 8_000);
  assert.equal(v.word, "connected");
  assert.equal(v.tone, "success");
  assert.equal(v.channel, "rate-limited (ssh refused) · retry in 12s");
  assert.match(v.title, /Fast channel rate-limited \(ssh refused\) · retry in 12s; calls use per-call ssh/);
  assert.equal(remoteView(entry(s), T0 + 25_000).channel, "rate-limited (ssh refused) · retry on next call");
  assert.equal(remoteView(entry({ ...s, channelRetryAt: undefined }), T0).channel, "rate-limited (ssh refused) · retry on next call");
  // Stale is still stale: the word follows lastOkAt, not the channel.
  assert.equal(remoteView(entry(s), T0 + REMOTE_STALE_MS).word, "last ok");
  assert.equal(remoteView(entry({ ...s, channelState: "idle", pinned: true }), T0).channel, undefined);
  // ops sends ssh's refusal line as `error` while still online: state decides, not `error`.
  const refused = remoteView(entry({ ...s, error: "ssh: connect to host h port 22: Connection refused" }), T0 + 8_000);
  assert.equal(refused.word, "connected");
  assert.equal(refused.tone, "success");
  assert.equal(refused.error, undefined);
});
