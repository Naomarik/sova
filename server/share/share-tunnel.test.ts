// Where links point under Cloudflare Free and Account, the share host's gate, and the broken-links rule
// (§mesh.public/setting, §mesh/tunnel, §mesh.public/broken-links): pure rules over their edges.
import { dropScratchAgentDir } from "../testing/scratch-agent-dir";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { PublicLinksFile, TunnelState, TunnelStatus } from "../../shared/public-links";

const { LINK_WARNINGS } = await import("../../shared/public-links");
const { accountState, quickState } = await import("./share-state");
const { shareHostAllowed } = await import("./listener");
const { brokenLinks, isBroken } = await import("./tunnel/handouts");
const { UNVERIFIED } = await import("./tunnel/manager");

after(dropScratchAgentDir);

const ORIGIN = "https://able-baker-charlie-delta.trycloudflare.com";
const status = (state: TunnelState, extra: Partial<TunnelStatus> = {}): TunnelStatus => ({ key: { kind: "share" }, mode: "quick", state, origin: state === "stopped" || state === "needs-cloudflared" ? null : ORIGIN, epoch: 1, ...extra });
const ON: { enabled: boolean; consentAt: number | null } = { enabled: true, consentAt: 1 };

test("Free: each tunnel state gives one address and one warning", () => {
  const rows: [string, TunnelStatus, typeof ON, { state: string; publicUrl: string | null; code: string }][] = [
    ["Free turned off (SOVA_QUICK_TUNNEL=off)", status("up"), { enabled: false, consentAt: 1 }, { state: "off", publicUrl: null, code: "off" }],
    ["before Turn On, whatever the tunnel", status("up"), { enabled: true, consentAt: null }, { state: "configured", publicUrl: null, code: "quick-turn-on" }],
    ["no cloudflared", status("needs-cloudflared"), ON, { state: "configured", publicUrl: null, code: "quick-setup" }],
    ["nothing shared yet", status("stopped"), ON, { state: "configured", publicUrl: null, code: "quick-starting" }],
    ["starting", status("starting", { origin: null }), ON, { state: "configured", publicUrl: null, code: "quick-starting" }],
    ["up and checked from outside", status("up"), ON, { state: "verified", publicUrl: ORIGIN, code: "quick" }],
    ["up, its outside check not passed", status("up", { reason: `${UNVERIFIED}.` }), ON, { state: "configured", publicUrl: ORIGIN, code: "unverified" }],
    ["cut off from Cloudflare", status("degraded"), ON, { state: "unreachable", publicUrl: ORIGIN, code: "tunnel-down" }],
    ["failed", status("failed"), ON, { state: "unreachable", publicUrl: null, code: "tunnel-down" }],
  ];
  for (const [name, t, opts, want] of rows) {
    const s = quickState(t, opts);
    assert.deepEqual({ state: s.state, publicUrl: s.publicUrl, code: s.warningCode }, want, name);
    assert.equal(s.source, "quick", name);
    assert.equal(s.warning, LINK_WARNINGS[want.code as keyof typeof LINK_WARNINGS], `${name}: the code's own text`);
  }
});

test("Account: its saved address always, judged by its tunnel", () => {
  const file: PublicLinksFile = { version: 1, route: "account", account: { publicUrl: "https://share.example.com" } };
  assert.equal(accountState({ version: 1, route: "account" }, status("up")).warningCode, "off", "no address saved");
  assert.deepEqual([accountState(file, status("needs-cloudflared")).publicUrl, accountState(file, status("needs-cloudflared")).warningCode], ["https://share.example.com", "quick-setup"]);
  for (const s of ["failed", "degraded"] as const) assert.equal(accountState(file, status(s)).warningCode, "tunnel-down", s);
  const up = accountState(file, status("up"));
  assert.deepEqual([up.source, up.publicUrl, up.warningCode], ["account", "https://share.example.com", "unverified"], "up, not verified yet");
  assert.equal(accountState({ ...file, verifiedAt: 5 }, status("up")).state, "verified");
});

test("the share host fails closed under Free and Account: only the tunnel's own host and loopback", () => {
  const quick: PublicLinksFile = { version: 1, route: "quick" };
  const account: PublicLinksFile = { version: 1, route: "account", account: { publicUrl: "https://share.example.com" } };
  const self: PublicLinksFile = { version: 1, route: "self", gateway: { publicUrl: "https://gw.example.com", front: "caddy", sharePort: 4802, acceptFrom: "all" } };
  const rows: [string, string | undefined, PublicLinksFile, TunnelStatus, boolean][] = [
    ["Free: the tunnel's host", "able-baker-charlie-delta.trycloudflare.com", quick, status("up"), true],
    ["Free: any case, with :443", "Able-Baker-Charlie-Delta.trycloudflare.com:443", quick, status("up"), true],
    ["Free: another tunnel's words", "other-words-here-now.trycloudflare.com", quick, status("up"), false],
    ["Free: while the address isn't known (adopt, a host change)", "able-baker-charlie-delta.trycloudflare.com", quick, status("starting"), false],
    ["Free: stopped", "able-baker-charlie-delta.trycloudflare.com", quick, status("stopped"), false],
    ["Free: no Host", undefined, quick, status("up"), false],
    ["Free: a Host that isn't one", "a b", quick, status("up"), false],
    ["Free: loopback, the operator's own check", "127.0.0.1:4802", quick, status("stopped"), true],
    ["Free: localhost", "localhost", quick, status("stopped"), true],
    ["Account: its address's host", "share.example.com", account, status("stopped"), true],
    ["Account: the trycloudflare host is not it", "able-baker-charlie-delta.trycloudflare.com", account, status("up"), false],
    ["a gateway judges no Host here", "anything.example.com", self, status("stopped"), true],
  ];
  for (const [name, host, file, t, want] of rows) assert.equal(shareHostAllowed(host, file, t, {}), want, name);
  assert.equal(shareHostAllowed("x.example.com", quick, status("up"), { SOVA_SHARE_PUBLIC_URL: "https://x.example.com" }), true, "an env pin judges no Host");
});

test("a link is broken only when it left before its address began", () => {
  assert.equal(isBroken(null, 10), false, "never left with a full URL");
  assert.equal(isBroken(5, null), false, "no address yet");
  assert.equal(isBroken(9, 10), true);
  assert.equal(isBroken(10, 10), false, "left at the new address");
  assert.equal(isBroken(11, 10), false);
  assert.equal(brokenLinks([], 10, () => null), undefined, "nothing live: no notice");
});
