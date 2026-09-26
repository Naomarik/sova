import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostDetails, MeshHostDetails } from "../../shared/mesh-details";
import {
  activityLine,
  batteryLine,
  browserAccessRefusal,
  bytes,
  claudeCodeLine,
  connectedCount,
  cpuLine,
  detailRows,
  frontDoorLine,
  joinedLine,
  labelProblem,
  loginsLine,
  machineLine,
  memoryLine,
  protocolLine,
  renameRefusal,
  sinceLine,
  unavailableText,
} from "./mesh-details";

const details = (over: Partial<HostDetails["identity"]> = {}): HostDetails => ({
  details: 1,
  id: "laptop",
  label: "Laptop",
  now: 0,
  identity: { hostname: "h", addresses: [], platform: "linux", osRelease: "6.9.1-arch1", arch: "x64", device: "laptop", ...over },
  versions: { sova: "0.1.0", pi: "0.87.1", node: "v22", protocol: "aaaa" },
  uptime: { process: 1, machine: 2 },
  resources: { cores: 8, memory: { total: 16 * 1024 ** 3, available: 12 * 1024 ** 3 } },
  activity: { sessions: 1, turnsRunning: 0, workers: 0 },
  sync: { categories: [] },
});

test("connected: this host always counts, and each peer that is up", () => {
  assert.deepEqual(connectedCount([]), { up: 1, total: 1 });
  assert.deepEqual(connectedCount([{ state: "up" }, { state: "down" }]), { up: 2, total: 3 });
  assert.deepEqual(connectedCount([{ state: "skewed" }, { state: "refused" }]), { up: 1, total: 3 }, "only up is connected");
});

test("figures read as a person says them", () => {
  assert.equal(bytes(512), "512 B");
  assert.equal(bytes(1536), "1.5 KB");
  assert.equal(bytes(16 * 1024 ** 3), "16 GB");
  assert.equal(memoryLine({ total: 16 * 1024 ** 3, available: 12 * 1024 ** 3 }), "4 GB of 16 GB used");
  assert.equal(cpuLine({ cores: 1, memory: { total: 1, available: 1 } }), "1 core");
  assert.equal(cpuLine({ cores: 8, load: [0.5, 0.2, 0.1], memory: { total: 1, available: 1 } }), "8 cores · load 0.50");
  assert.equal(activityLine({ sessions: 1, turnsRunning: 0, workers: 0 }), "1 session");
  assert.equal(activityLine({ sessions: 12, turnsRunning: 2, workers: 1 }), "12 sessions · 2 turns running · 1 worker");
});

test("machine: a desktop OS says its release, a phone doesn't (its kernel isn't its Android version)", () => {
  assert.equal(machineLine(details()), "Laptop · Linux 6.9.1 (x64)");
  assert.equal(machineLine(details({ platform: "android", device: "phone", osRelease: "5.10.1-android", arch: "arm64" })), "Phone · Android (arm64)");
});

test("battery: a reading, or how to get one on a phone", () => {
  const r = details().resources;
  assert.equal(batteryLine({ ...r, battery: { percent: 81, charging: true } }), "81%, charging");
  assert.equal(batteryLine({ ...r, battery: { percent: 40, charging: false } }), "40%");
  assert.match(batteryLine({ ...r, batteryHint: "termux-api" })!, /Termux:API/);
  assert.equal(batteryLine(r), null);
});

test("an older build is told apart from a down host", () => {
  assert.equal(unavailableText({ unavailable: "update", label: "Phone", state: "up" }), "Update this host to see its details.");
  assert.match(unavailableText({ unavailable: "down", label: "Phone", state: "down" })!, /isn't answering/);
  assert.equal(unavailableText({ label: "Phone", state: "up" }), null);
});

test("a host that says hello but answers its details late is slow, not gone", () => {
  const slow = unavailableText({ unavailable: "down", label: "VPS", state: "up" })!;
  const gone = unavailableText({ unavailable: "down", label: "VPS", state: "down" })!;
  assert.notEqual(slow, gone);
  assert.doesNotMatch(slow, /isn't answering/);
  assert.match(slow, /in time/);
});

test("the Sync row names each category as #/mesh does, and keeps an unknown one as it came", () => {
  const d = { ...details(), sync: { categories: [{ category: "themes", state: "ok", lastAt: 1 }, { category: "later", state: "off" }] } };
  const host = { id: "vps", label: "VPS", self: false, state: "up", details: d, latencyMs: 1, lastSeen: 1, stateSince: null, pairedAt: null,
    frontDoor: { position: 1, excluded: false }, open: { kind: "through" } } as unknown as MeshHostDetails;
  const sync = detailRows(host, "aaaa", 10_000).find(([k]) => k === "Sync")![1] as string;
  assert.match(sync, /^Themes /);
  assert.match(sync, /· later off$/);
});

test("rename: always for this host; a peer must answer and run a build that has it", () => {
  const h = (o: Partial<MeshHostDetails>) => ({ self: false, state: "up" as const, label: "VPS", ...o });
  assert.equal(renameRefusal(h({ self: true, state: "self" })), null);
  assert.equal(renameRefusal(h({})), null);
  assert.match(renameRefusal(h({ unavailable: "update" }))!, /Update VPS/);
  assert.match(renameRefusal(h({ state: "down", unavailable: "down" }))!, /isn't answering/);
  assert.equal(labelProblem("  "), "Give it a name.");
  assert.equal(labelProblem("x".repeat(81)), "Keep it to 80 characters.");
  assert.equal(labelProblem(` ${"x".repeat(80)} `), null, "trimmed like the server trims");
});

test("joined, front door, protocol, logins, since", () => {
  const now = Date.UTC(2026, 8, 25);
  assert.equal(joinedLine({ self: false, pairedAt: null }, now), "Paired before dates were recorded");
  assert.equal(joinedLine({ self: false, pairedAt: Date.UTC(2026, 2, 4, 12) }, now), "Paired Mar 4");
  assert.equal(joinedLine({ self: true, pairedAt: undefined }, now), null);
  assert.equal(frontDoorLine({ position: 1, excluded: false }), "1st in the front door");
  assert.equal(frontDoorLine({ position: 12, excluded: false }), "12th in the front door");
  assert.equal(frontDoorLine({ position: 22, excluded: false }), "22nd in the front door");
  assert.equal(frontDoorLine({ position: null, excluded: true }), "Left out of the front door");
  assert.equal(protocolLine(details(), "aaaa"), "Same as this host");
  assert.equal(protocolLine(details(), "bbbb"), "Differs from this host");
  assert.equal(loginsLine({ categories: [] }), null, "no block: logins don't sync there");
  assert.equal(loginsLine({ categories: [], logins: { count: 4, conflicts: 1 } }), "4 logins · 1 conflict");
  assert.equal(sinceLine({ state: "up", stateSince: now - 90_000 }, now), "up for 1m");
  assert.equal(sinceLine({ state: "down", stateSince: now - 40_000 }, now), "not answering for 40s");
  assert.equal(sinceLine({ state: "up", stateSince: null }, now), "");
});

test("a later build's answer with fields missing or reshaped loses those rows, never the section", () => {
  const host = (d: unknown): MeshHostDetails => ({
    id: "vps", label: "VPS", self: false, state: "up", details: d as HostDetails, latencyMs: 12, lastSeen: 1, stateSince: null,
    pairedAt: null, frontDoor: { position: 2, excluded: false }, open: { kind: "through" }, browserAccess: false,
  });
  const full = detailRows(host(details()), "aaaa", Date.UTC(2026, 8, 25)).map(([k]) => k);
  assert.ok(full.includes("Memory") && full.includes("Uptime") && full.includes("Activity"));
  const broken = { ...details(), resources: { cores: 4 }, uptime: undefined, activity: "busy", sync: {} };
  const rows = detailRows(host(broken), "aaaa", Date.UTC(2026, 8, 25));
  const labels = rows.map(([k]) => k);
  assert.ok(!labels.includes("Memory") && !labels.includes("Uptime") && !labels.includes("Sync"));
  assert.ok(labels.includes("Machine") && labels.includes("CPU") && labels.includes("Front door") && labels.includes("Joined"));
});

test("the browser address is a link where there is one, and says so where there isn't, details or not", () => {
  const host = (o: Partial<MeshHostDetails>): MeshHostDetails => ({
    id: "vps", label: "VPS", self: false, state: "up", details: details({ dnsName: "vps.example" }), latencyMs: 12, lastSeen: 1, stateSince: null,
    pairedAt: null, frontDoor: { position: 2, excluded: false }, open: { kind: "through" }, browserAccess: false, ...o,
  });
  const value = (h: MeshHostDetails) => detailRows(h, "aaaa", 1).find(([k]) => k === "Browser address")?.[1];
  assert.deepEqual(value(host({ open: { kind: "direct", url: "https://vps.example:8443" }, browserAccess: true })), { link: "https://vps.example:8443" });
  assert.equal(value(host({})), "No browser address");
  assert.equal(value(host({ state: "down", details: undefined, unavailable: "down" })), "No browser address");
  const labels = detailRows(host({}), "aaaa", 1).map(([k]) => k);
  assert.equal(labels.indexOf("Browser address"), labels.indexOf("Address") + 1, "right under the tailnet address");
});

test("Claude Code: found, not found on Sova's PATH, or no row before the host has looked", () => {
  assert.equal(claudeCodeLine({ ...details(), claudeCode: "found" }), "Found");
  assert.equal(claudeCodeLine({ ...details(), claudeCode: "not-found" }), "Not found on Sova's PATH");
  assert.equal(claudeCodeLine(details()), null);
});

test("Browser access: always for this host; a peer must answer on a build that reports it", () => {
  const h = (o: Partial<MeshHostDetails>) => ({ self: false, state: "up" as const, label: "Phone", details: { ...details(), browserAccess: false }, ...o });
  assert.equal(browserAccessRefusal(h({ self: true, state: "self" })), null);
  assert.equal(browserAccessRefusal(h({})), null);
  assert.match(browserAccessRefusal(h({ details: details() }))!, /Update Phone/, "an older build doesn't report it");
  assert.match(browserAccessRefusal(h({ unavailable: "update", details: undefined }))!, /Update Phone/);
  assert.match(browserAccessRefusal(h({ state: "down", unavailable: "down", details: undefined }))!, /isn't answering/);
});
