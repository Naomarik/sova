import assert from "node:assert/strict";
import { test } from "node:test";
import type { PublicLinksFile, PublicLinksInfo } from "../../shared/public-links";
import { currentLine, keyOf, opensAtLine, needsCloudflared, needsTurnOn, opensAtOptions, opensAtSections, patchFor, sharingIsOff, throughNote } from "./opens-at";

const info = (file: Partial<PublicLinksFile>, more: Partial<PublicLinksInfo> = {}): PublicLinksInfo => ({
  file: { version: 1, route: "quick", ...file },
  share: { state: "off", source: "bound", publicUrl: null },
  pinnedByEnv: [],
  ...more,
});
const gw = (front: "vhost" | "caddy" | "funnel" | "cloudflared") => ({ publicUrl: "https://share.example.com", front, sharePort: 4802, acceptFrom: "all" as const });
const states = (i: PublicLinksInfo, withOff = false) => Object.fromEntries(opensAtOptions(opensAtSections(i, { withOff })).map((o) => [o.key, o.state]));

test("Free picked by default carries the Default badge", () => {
  assert.equal(opensAtSections(info({}, { implicit: true }))[0]!.options[0]!.badge, "Default");
  assert.equal(opensAtSections(info({}))[0]!.options[0]!.badge, undefined);
});

test("the sections, in order: Cloudflare, Tailscale, Your own web server, and Off only where asked", () => {
  const i = info({});
  assert.deepEqual(opensAtSections(i).map((s) => s.title), ["Cloudflare", "Tailscale", "Your own web server"]);
  assert.deepEqual(opensAtSections(i, { withOff: true }).map((s) => s.title), ["Cloudflare", "Tailscale", "Your own web server", "Off"]);
  assert.deepEqual(opensAtSections(i)[0]!.options.map((o) => o.label), ["Free", "Account"]);
});

test("each setting selects its option", () => {
  assert.equal(keyOf({ route: "quick" }), "free");
  assert.equal(keyOf({ route: "account" }), "account");
  assert.equal(keyOf({ route: "off" }), "off");
  assert.equal(keyOf({ route: "self", gateway: gw("funnel") }), "funnel");
  assert.equal(keyOf({ route: "self", gateway: gw("caddy") }), "web-server");
  assert.equal(keyOf({ route: "self", gateway: gw("vhost") }), "web-server");
  assert.equal(keyOf({ route: "self", gateway: gw("cloudflared") }), "you-run-it");
  assert.equal(keyOf({ route: { via: { nodeId: "n1" } } }), "through:n1");
  assert.equal(keyOf({ route: "off" }, { broken: true }), null);
});

test("nothing set up: Free is on, Free and Off ready, the rest greyed", () => {
  assert.deepEqual(states(info({}), true), { free: "on", account: "needs-setup", funnel: "needs-setup", "through:": "needs-setup", "web-server": "needs-setup", off: "ready" });
});

test("Account is ready with an address and a stored token; a tunnel the user runs is its own option", () => {
  assert.equal(states(info({ account: { publicUrl: "https://s.example.com" } }))["account"], "needs-setup");
  assert.equal(states(info({ account: { publicUrl: "https://s.example.com" } }, { account: { hasToken: true } }))["account"], "ready");
  assert.equal(states(info({}))["you-run-it"], undefined, "shown only where one is saved");
  const own = info({ route: "self", gateway: gw("cloudflared") });
  assert.equal(states(own)["you-run-it"], "on");
  assert.equal(states(own)["account"], "needs-setup");
  assert.equal(currentLine(own), "your own Cloudflare tunnel");
  assert.deepEqual(patchFor(info({ route: "quick", gateway: gw("cloudflared") }), "you-run-it"), { route: "self" });
  assert.deepEqual(patchFor(info({ account: { publicUrl: "https://s.example.com" } }, { account: { hasToken: true } }), "account"), { route: "account" });
});

test("the saved gateway's front decides which of Funnel and Your own web server is ready", () => {
  const funnel = states(info({ route: "quick", gateway: gw("funnel") }));
  assert.equal(funnel["funnel"], "ready");
  assert.equal(funnel["web-server"], "needs-setup");
  const caddy = states(info({ route: "self", gateway: gw("caddy") }));
  assert.equal(caddy["web-server"], "on");
  assert.equal(caddy["funnel"], "needs-setup");
});

test("Through: one per advertising computer, with its note; a saved one no longer advertised stays", () => {
  const i = info({ route: { via: { nodeId: "n9" } } }, { gateways: [{ nodeId: "n1", peer: "vps", publicUrl: "https://p.example.com" }], share: { state: "configured", source: "gateway", publicUrl: null, via: "old" } });
  const t = opensAtSections(i)[1]!.options.filter((o) => o.key.startsWith("through:"));
  assert.deepEqual(t.map((o) => [o.key, o.label, o.state]), [["through:n1", "Through vps", "ready"], ["through:n9", "Through old", "on"]]);
  assert.equal(t[0]!.note, throughNote("vps"));
  assert.equal(t[0]!.note, "vps serves these with its own web server (Your own domain).");
  assert.equal(currentLine(i), "Through old");
  assert.deepEqual(patchFor(i, "through:n1"), { route: { via: { nodeId: "n1" } } });
});

test("a selected draft wins over the saved choice; picking a greyed option sends nothing", () => {
  assert.equal(states({ ...info({}) }, false)["free"], "on");
  const s = Object.fromEntries(opensAtOptions(opensAtSections(info({}), { selected: "off", withOff: true })).map((o) => [o.key, o.state]));
  assert.equal(s["off"], "on");
  assert.equal(s["free"], "ready");
  assert.equal(patchFor(info({}), "web-server"), null);
  assert.deepEqual(patchFor(info({ route: "self", gateway: gw("caddy") }), "free"), { route: "quick" });
  assert.deepEqual(patchFor(info({}), "off"), { route: "off" });
});

test("the current choice as one line", () => {
  assert.equal(currentLine(info({})), "Cloudflare Free");
  assert.equal(currentLine(info({ route: "self", gateway: gw("funnel") })), "Tailscale Funnel");
  assert.equal(currentLine(info({ route: "self", gateway: gw("vhost") })), "Your own web server");
  assert.equal(currentLine(info({ route: "off" }, { sharingOff: true })), "Off");
  assert.equal(currentLine(info({ route: "off" }, { broken: true })), "Can't read setting");
  assert.equal(opensAtLine(info({})), "Links open with Cloudflare Free.");
});

test("prompts: Turn On before consent, Download without cloudflared, Off hides sharing", () => {
  const cf = (found: boolean) => ({ share: { key: { kind: "share" as const }, mode: "quick" as const, state: "stopped" as const, origin: null, epoch: null }, previews: [], cloudflared: { found, source: null, version: null, canDownload: true, install: "brew install cloudflared" } });
  assert.equal(needsTurnOn(info({}, { consentAt: null })), true);
  assert.equal(needsTurnOn(info({}, { consentAt: 1 })), false);
  assert.equal(needsTurnOn(info({})), false, "an older server says nothing");
  assert.equal(needsTurnOn(info({ route: "self", gateway: gw("caddy") }, { consentAt: null })), false);
  assert.equal(needsCloudflared(info({}, { tunnel: cf(false) })), true);
  assert.equal(needsCloudflared(info({}, { tunnel: cf(true) })), false);
  assert.equal(needsCloudflared(info({ route: "self", gateway: gw("caddy") }, { tunnel: cf(false) })), false);
  assert.equal(sharingIsOff(info({ route: "off" }, { sharingOff: true })), true);
  assert.equal(sharingIsOff(info({ route: "off" }, { broken: true })), false);
  assert.equal(sharingIsOff(null), false);
});
