// Run: pnpm test -- src/lib/networks.test.ts
// The Access page's Networks card and "QR points at" picker, pure: the rows, the confirmation's words,
// the retype rule, and which link the QR draws with its notes.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DetectedNetwork, TrustedNetwork } from "../../shared/networks";
import {
  confirmWords, countLabel, INSECURE_MISSES, linkOrigin, NOT_VPN_WARNING, needsRetype, networkRows, pickedLink,
  pickerLinks, pickNotes, RETYPE_ABOVE, retypeMatches, SAME_NETWORK, trustState, type PairLink,
} from "./networks";

const wg: DetectedNetwork = { id: "wg0", kind: "wireguard", iface: "wg0", address: "10.8.0.2", range: "10.8.0.0/24", vpn: true, trusted: false };
const wifi: DetectedNetwork = { id: "wlan0", kind: "wifi", iface: "wlan0", address: "192.168.1.20", range: "192.168.1.0/24", vpn: false, trusted: false };
const p2p: DetectedNetwork = { id: "tun0", kind: "vpn", iface: "tun0", address: "10.9.0.5", range: null, vpn: true, trusted: false };
const on = (range: string, more: Partial<TrustedNetwork> = {}): TrustedNetwork => ({ range, address: "10.8.0.2", port: 4800, listening: true, ...more });

test("rows: VPNs before Wi-Fi whatever the order given, each with its own trusted range", () => {
  const rows = networkRows([wifi, wg, p2p], [on("10.8.0.0/24")]);
  assert.deepEqual(rows.map((r) => r.title), ["WireGuard · wg0", "VPN · tun0", "Wi-Fi · wlan0"]);
  assert.equal(rows[0]!.trusted?.range, "10.8.0.0/24");
  assert.match(rows[0]!.meta, /accepts from: 10\.8\.0\.0\/24/);
  assert.equal(rows[1]!.range, null, "a point-to-point VPN with no route offers no Trust…");
  assert.match(rows[1]!.meta, /range unknown/);
  assert.match(rows[2]!.meta, /not a VPN/);
});

test("rows: a typed range no listed network carries gets a row of its own, once", () => {
  const rows = networkRows([wg], [on("10.8.0.0/24"), on("10.224.0.0/22", { address: null, listening: false })]);
  assert.equal(rows.length, 2);
  assert.equal(rows[1]!.title, "Range · 10.224.0.0/22");
  assert.equal(rows[1]!.range, "10.224.0.0/22");
  assert.match(rows[1]!.meta, /Not connected right now/);
  assert.equal(networkRows([wg], [on("10.224.0.0/22", { label: "Office VPN · tun3" })])[1]!.title, "Office VPN · tun3");
});

test("a trusted range matched to its interface counts as that network's, even when the ranges differ", () => {
  const rows = networkRows([p2p], [on("10.9.0.0/16", { iface: "tun0" })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.range, "10.9.0.0/16");
});

test("rows: Tailscale's plain address is left to its own row while its HTTPS address is ready, unless trusted", () => {
  const tsNet: DetectedNetwork = { id: "tailscale0", kind: "tailscale", iface: "tailscale0", address: "100.64.0.9", range: "100.64.0.0/10", vpn: true, trusted: false };
  assert.deepEqual(networkRows([tsNet, wg], [], { tailscaleReady: true }).map((r) => r.title), ["WireGuard · wg0"]);
  assert.deepEqual(networkRows([tsNet, wg], []).map((r) => r.title), ["Tailscale · tailscale0", "WireGuard · wg0"]);
  assert.equal(networkRows([tsNet], [on("100.64.0.0/10")], { tailscaleReady: true }).length, 1);
});

test("an interface's IPv6 network is told apart from its IPv4 one by its title", () => {
  const v6: DetectedNetwork = { ...wifi, id: "wlan0/6", address: "fd00:db8::20", range: "fd00:db8::/64" };
  assert.deepEqual(networkRows([wifi, v6], []).map((r) => r.title), ["Wi-Fi · wlan0", "Wi-Fi · wlan0 · IPv6"]);
});

test("trust state: untrusted, trusted and listening, trusted but waiting", () => {
  assert.deepEqual(trustState(undefined), { word: "Not trusted", tone: "" });
  assert.deepEqual(trustState(on("10.8.0.0/24")), { word: "Trusted", tone: "success" });
  assert.deepEqual(trustState(on("10.8.0.0/24", { listening: false })), { word: "Trusted · waiting", tone: "warn" });
});

test("retype is asked strictly above 65,536 addresses, and the check's own word wins", () => {
  assert.equal(needsRetype({ count: RETYPE_ABOVE }), false);
  assert.equal(needsRetype({ count: RETYPE_ABOVE + 1 }), true);
  assert.equal(needsRetype({ count: 4, needsRetype: true }), true);
  assert.equal(needsRetype({ count: 1 << 20, needsRetype: false }), false);
});

test("a retyped range matches only the same range, spaces and case aside", () => {
  assert.ok(retypeMatches("10.0.0.0/8", " 10.0.0.0/8 "));
  assert.ok(retypeMatches("fd00::/8", "FD00::/8"));
  assert.ok(!retypeMatches("10.0.0.0/8", "10.0.0.0/9"));
  assert.ok(!retypeMatches("10.0.0.0/8", ""));
});

test("confirmation: count and what it allows; the not-a-VPN warning only off a VPN; retype only when large", () => {
  const small = confirmWords({ ok: true, range: "10.224.0.0/22", count: 1024, vpn: true, address: "10.224.0.7", iface: "tun3", kind: "vpn" });
  assert.equal(small.title, "Trust 10.224.0.0/22?");
  assert.equal(small.body, "1,024 addresses. Devices there can open Sova's sign-in screen. Each one still needs a pairing code once.");
  assert.equal(small.where, "Sova will answer at 10.224.0.7, on VPN · tun3.");
  assert.equal(small.notVpn, undefined);
  assert.equal(small.retype, undefined);

  const lan = confirmWords({ ok: true, range: "192.168.1.0/24", count: 256, vpn: false });
  assert.equal(lan.notVpn, NOT_VPN_WARNING);

  const big = confirmWords({ ok: true, range: "10.0.0.0/8", count: 16_777_216, warning: "This range is wider than the network it sits on." });
  assert.match(big.body, /^16,777,216 addresses\./);
  assert.match(big.retype!, /Type 10\.0\.0\.0\/8 to trust it/);
  assert.equal(big.warning, "This range is wider than the network it sits on.");
});

test("counts: digits with commas, a label the server gives as is, and a power of 2 past what a number holds", () => {
  assert.equal(countLabel(1), "1");
  assert.equal(countLabel(65_536), "65,536");
  assert.equal(countLabel(2 ** 120), "2^120");
  assert.equal(countLabel(undefined, "2^120"), "2^120");
});

const ts: PairLink = { label: "Phone · Tailscale", url: "https://box.tail0.ts.net/#c=x", kind: "tailscale", secure: true };
const wgLink: PairLink = { label: "Phone · WireGuard · wg0", url: "http://10.8.0.2:4800/#c=x", kind: "trusted", secure: false };
const here: PairLink = { label: "This machine only", url: "http://127.0.0.1:4800/#c=x", kind: "here", secure: false };

test("picker: only links another device can open, in the server's order", () => {
  assert.deepEqual(pickerLinks([ts, wgLink, here]), [ts, wgLink]);
  assert.deepEqual(pickerLinks([here]), []);
});

test("picker: the remembered pick while it is still offered, else the first", () => {
  const choices = [ts, wgLink];
  assert.equal(pickedLink(choices, null), ts);
  assert.equal(pickedLink(choices, linkOrigin(wgLink.url)), wgLink);
  assert.equal(pickedLink(choices, "http://10.9.0.5:4800"), ts, "a pick no longer offered falls back to the first");
  assert.equal(pickedLink([], linkOrigin(wgLink.url)), undefined);
  // A new code changes the link, never its origin: the pick holds.
  assert.equal(linkOrigin("http://10.8.0.2:4800/#c=other"), linkOrigin(wgLink.url));
});

test("notes under the QR: none for Tailscale, both for a trusted network, what it misses for a plain address", () => {
  assert.deepEqual(pickNotes(ts), []);
  assert.deepEqual(pickNotes(wgLink), [INSECURE_MISSES, SAME_NETWORK]);
  assert.deepEqual(pickNotes({ label: "This address", url: "http://192.168.1.20:4800/#c=x", kind: "here" }), [INSECURE_MISSES]);
  assert.deepEqual(pickNotes({ label: "Proxy", url: "https://sova.example/#c=x" }), [], "an https link with no kind is a secure context");
  assert.deepEqual(pickNotes(undefined), []);
});
