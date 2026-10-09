// Run: npx tsx --test server/push.test.ts
// Uses a throwaway PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi is never read or written. The
// push service is a stubbed fetch: no network.
import assert from "node:assert/strict";
import { createECDH } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "sova-push-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths
after(() => rmSync(agentDir, { recursive: true, force: true }));

const { pushDecision, pushPayload, deliver, sendTest, PUSH_MIN_GAP_MS } = await import("./push");
const store = await import("./push-store");
const { pushRoutes } = await import("./push-routes");
const { b64url } = await import("./web-push");
const { secretSources, Redactor } = await import("./overseer-redact");

const settings = (): import("../shared/protocol").PushSettings => ({ ...store.defaultPushSettings(), contact: "mailto:ops@example.test" });
const b = (id: string, kind: string, detail?: string) => ({ id, kind, title: `Session ${id}`, ...(detail ? { detail } : {}) }) as never;
const base: Omit<import("./push").PushDecisionInput, "current" | "announced"> = { settings: settings(), devices: 1, now: 1_000_000, lastSentAt: 0, quiet: false, viewing: () => false };
const keysOf = (d: { send: { id: string; kind: string }[] }) => d.send.map((x) => `${x.id}:${x.kind}`);

describe("pushDecision", () => {
  test("the first reading is the baseline: nothing already there is sent", () => {
    const d = pushDecision({ ...base, current: [b("a", "error")], announced: null });
    assert.deepEqual(d.send, []);
    assert.deepEqual([...d.announced], ["a:error"]);
  });

  test("blockers that are no notification kind (a stalled team, a reply that asks) are told, never sent", () => {
    const d = pushDecision({ ...base, current: [b("a", "team-stalled"), b("c", "asks-you"), b("d", "error")], announced: new Set() });
    assert.deepEqual(keysOf(d), ["d:error"]);
    assert.ok(d.announced.has("a:team-stalled") && d.announced.has("c:asks-you"));
  });

  test("a new blocker is sent once, until it clears; a recurrence is new", () => {
    let d = pushDecision({ ...base, current: [b("a", "error"), b("b", "needs-input")], announced: new Set(["a:error"]) });
    assert.deepEqual(keysOf(d), ["b:needs-input"]);
    d = pushDecision({ ...base, current: [b("a", "error"), b("b", "needs-input")], announced: d.announced, lastSentAt: 0 });
    assert.deepEqual(d.send, []);
    d = pushDecision({ ...base, current: [b("a", "error")], announced: d.announced });
    assert.deepEqual([...d.announced], ["a:error"]);
    d = pushDecision({ ...base, current: [b("a", "error"), b("b", "needs-input")], announced: d.announced });
    assert.deepEqual(keysOf(d), ["b:needs-input"]);
  });

  test("dropped for good (told, not held): off, no contact, no device, kind off, quiet, on screen", () => {
    const cases: [string, Partial<typeof base>][] = [
      ["off", { settings: { ...settings(), enabled: false } }],
      ["no contact", { settings: { ...settings(), contact: null } }],
      ["no device", { devices: 0 }],
      ["quiet", { quiet: true }],
      ["on screen", { viewing: (id: string) => id === "a" }],
    ];
    for (const [why, over] of cases) {
      const d = pushDecision({ ...base, ...over, current: [b("a", "error")], announced: new Set() });
      assert.deepEqual(d.send, [], why);
      assert.ok(d.announced.has("a:error"), why);
      // Turning it back on later does not send what was dropped.
      assert.deepEqual(pushDecision({ ...base, current: [b("a", "error")], announced: d.announced }).send, [], why);
    }
    // worker-error is off by default; a non-push act kind never sends.
    const d = pushDecision({ ...base, current: [b("a", "worker-error"), b("c", "finished"), b("d", "open-questions")], announced: new Set() });
    assert.deepEqual(keysOf(d), ["d:open-questions"]);
    assert.ok(d.announced.has("a:worker-error") && d.announced.has("c:finished"));
  });

  test("inside the gap, fresh blockers wait (not told) and go out together after it", () => {
    const now = base.now;
    let d = pushDecision({ ...base, current: [b("a", "error"), b("b", "open-questions")], announced: new Set(), lastSentAt: now - PUSH_MIN_GAP_MS + 1 });
    assert.deepEqual(d.send, []);
    assert.equal(d.announced.size, 0);
    // One cleared while waiting: never sent.
    d = pushDecision({ ...base, current: [b("b", "open-questions"), b("c", "needs-input")], announced: d.announced, lastSentAt: now - PUSH_MIN_GAP_MS });
    assert.deepEqual(keysOf(d), ["b:open-questions", "c:needs-input"]);
  });
});

describe("pushPayload", () => {
  const plain = () => ({ redact: (s: string) => s }) as never;
  test("one session: kind · title, details, its tag, opens the session", () => {
    const p = pushPayload([b("s/1", "needs-input", "Waiting on: Pick a file"), b("s/1", "error", "Boom.")], 2, 5, plain);
    assert.equal(p.title, "Needs input · Session s/1");
    assert.equal(p.body, "Waiting on: Pick a file Boom.");
    assert.equal(p.tag, "sova:s/1");
    assert.equal(p.hash, "#/sid/s%2F1");
    assert.equal(p.count, 2);
  });
  test("several sessions: a count, a line each, opens the Overseer", () => {
    const p = pushPayload([b("a", "error"), b("b", "worker-error"), b("a", "open-questions")], 3, 5, plain);
    assert.equal(p.title, "2 sessions need you");
    assert.equal(p.body, "Session a — Error\nSession b — Subagent error");
    assert.equal(p.tag, "sova:several");
    assert.equal(p.hash, "#/overseer");
  });
  test("WhatsApp down, of no session: its kind word as the title, its sentence, its own tag, opens Settings → Outreach", () => {
    const wa = { id: "whatsapp-sender", path: "", kind: "whatsapp-down", title: "WhatsApp sending", detail: "WhatsApp sending is down: x.", href: "#/settings/outreach" } as never;
    const p = pushPayload([wa], 1, 5, plain);
    assert.deepEqual([p.title, p.body, p.tag, p.hash], ["WhatsApp down", "WhatsApp sending is down: x.", "sova:whatsapp-sender", "#/settings/outreach"]);
    const d = pushDecision({ ...base, current: [wa], announced: new Set() });
    assert.deepEqual(keysOf(d), ["whatsapp-sender:whatsapp-down"], "on by default, sent once until it clears");
    const off = pushDecision({ ...base, settings: { ...settings(), kinds: { ...settings().kinds, "whatsapp-down": false } }, current: [wa], announced: new Set() });
    assert.deepEqual(off.send, [], "its own switch");
  });
  test("title and body go through the redactor, and are capped", () => {
    const secret = "sk-live-0123456789abcdefXYZ";
    const r = new Redactor([], {});
    const p = pushPayload([{ id: "a", kind: "error", title: `leak ${secret}`, detail: `${"x".repeat(400)} ${secret}` } as never], 1, 5, () => r);
    assert.ok(!p.title.includes(secret) && !p.body.includes(secret));
    assert.ok(p.body.length <= 300 && p.title.length <= 80);
    // The same redactor does hide it, so the check above can fail.
    assert.ok(!r.redact(secret).includes(secret));
  });
});

describe("stores", () => {
  test("the VAPID pair is made once, 0600 in a 0700 dir, and the redactor reads its private half", () => {
    const a = store.readOrCreateVapid();
    const again = store.readOrCreateVapid();
    assert.deepEqual(a, again);
    assert.equal(statSync(store.vapidFile()).mode & 0o777, 0o600);
    assert.equal(statSync(join(store.vapidFile(), "..")).mode & 0o777, 0o700);
    const src = secretSources(join(agentDir, "no-home"), agentDir).find((s) => s.path === store.vapidFile());
    assert.ok(src);
    assert.deepEqual(src.pick(JSON.parse(readFileSync(store.vapidFile(), "utf8"))), [a.privateKey]);
  });

  test("a vapid.json holding no valid pair is refused, never overwritten", () => {
    const f = join(agentDir, "bad-vapid.json");
    writeFileSync(f, '{"publicKey":"x","privateKey":"y"}');
    assert.throws(() => store.readOrCreateVapid(f), /no valid key pair/);
    assert.equal(readFileSync(f, "utf8"), '{"publicKey":"x","privateKey":"y"}');
  });

  test("settings: strict on a PUT, tolerant on read; the contact is validated, with no default", () => {
    assert.equal(store.defaultPushSettings().contact, null);
    const ok = store.parsePushSettings({ contact: "mailto:ops@example.test", kinds: { error: false }, quietHours: { enabled: true, start: "23:30", end: "06:00" } }, true);
    assert.ok(!("error" in ok));
    assert.equal(ok.kinds.error, false);
    assert.equal(ok.kinds["needs-input"], true);
    for (const bad of ["ops@example.test", "mailto:nobody", "mailto:a@b.test?subject=x", "http://example.test", "https://user:pw@example.test", "https://localhost", "mailto:a b@c.test"])
      assert.ok("error" in store.parsePushSettings({ contact: bad }, true), bad);
    assert.ok(!("error" in store.parsePushSettings({ contact: "https://example.test/contact" }, true)));
    assert.ok("error" in store.parsePushSettings({ kinds: { finished: true } }, true));
    assert.ok("error" in store.parsePushSettings({ quietHours: { enabled: true, start: "07:00", end: "07:00" } }, true));
    assert.ok("error" in store.parsePushSettings({ quietHours: { enabled: true, start: "24:00", end: "07:00" } }, true));
    const tolerant = store.parsePushSettings({ contact: "nope", enabled: "yes", kinds: { error: false, bogus: 1 } }, false);
    assert.ok(!("error" in tolerant));
    assert.equal(tolerant.contact, null);
    assert.equal(tolerant.enabled, true);
    assert.equal(tolerant.kinds.error, false);
  });

  test("asks-you became open-questions: a stored choice carries over, an explicit one wins, and the old key is never a 400", () => {
    const parsed = (raw: unknown, strict: boolean) => {
      const out = store.parsePushSettings(raw, strict);
      if ("error" in out) throw new Error(out.error);
      return out;
    };
    const off = parsed({ kinds: { "asks-you": false } }, false);
    assert.equal(off.kinds["open-questions"], false, "a user who turned asks-you off keeps open questions off");
    assert.ok(!("asks-you" in off.kinds), "the old key is not kept");
    assert.equal(parsed({ kinds: { "asks-you": false, "open-questions": true } }, false).kinds["open-questions"], true, "an explicit open-questions wins");
    assert.equal(parsed({ kinds: { "open-questions": true, "asks-you": false } }, false).kinds["open-questions"], true, "in either key order");
    const stale = parsed({ kinds: { "asks-you": true, error: false } }, true);
    assert.equal(stale.kinds["open-questions"], true, "a stale client's PUT with the old key is accepted");
    assert.equal(parsed({}, false).kinds["open-questions"], true, "no stored choice: the default");
  });

  test("looping (Subagent stuck) is retired: a stored choice is dropped, and a stale client's key is never a 400", () => {
    const out = store.parsePushSettings({ kinds: { looping: false, error: false } }, true);
    assert.ok(!("error" in out), "a PUT with the retired key is accepted");
    const kinds = (out as { kinds: Record<string, boolean> }).kinds;
    assert.ok(!("looping" in kinds));
    assert.equal(kinds.error, false);
    assert.ok(!("looping" in store.defaultPushSettings().kinds));
  });

  test("quiet hours wrap across midnight, in server-local time", () => {
    const q = { enabled: true, start: "22:00", end: "07:00" };
    const at = (h: number, m = 0) => new Date(2026, 0, 1, h, m);
    assert.equal(store.inQuietHours(q, at(23)), true);
    assert.equal(store.inQuietHours(q, at(3)), true);
    assert.equal(store.inQuietHours(q, at(7)), false);
    assert.equal(store.inQuietHours(q, at(12)), false);
    assert.equal(store.inQuietHours({ ...q, start: "09:00", end: "17:00" }, at(12)), true);
    assert.equal(store.inQuietHours({ ...q, enabled: false }, at(23)), false);
  });
});

/** A browser's subscription: a real P-256 point and auth secret, at a fake push service. */
function fakeSub(n: number) {
  const ua = createECDH("prime256v1");
  ua.generateKeys();
  return { endpoint: `https://push.example.test/send/${n}`, keys: { p256dh: b64url(ua.getPublicKey()), auth: b64url(Buffer.alloc(16, n)) } };
}

describe("devices and delivery", () => {
  test("a 404 or 410 removes the device; another failure is kept on it; a success clears it", async () => {
    const [s1, s2, s3] = [fakeSub(1), fakeSub(2), fakeSub(3)];
    for (const s of [s1, s2, s3]) assert.ok("device" in store.upsertDevice({ subscription: s, label: `Dev ${s.endpoint.slice(-1)}` }));
    const status: Record<string, number> = { [s1.endpoint]: 201, [s2.endpoint]: 410, [s3.endpoint]: 403 };
    const fetchImpl = (async (url: string | URL | Request) => new Response(null, { status: status[String(url)] })) as typeof fetch;
    const payload = { v: 1 as const, title: "t", body: "b", tag: "sova:x", hash: "#/", ts: 1 };
    const results = await deliver(store.readDevices(), payload, "mailto:ops@example.test", fetchImpl);
    assert.deepEqual(results.map((r) => [r.label, r.ok, r.removed ?? false]), [["Dev 1", true, false], ["Dev 2", false, true], ["Dev 3", false, false]]);
    const left = store.readDevices();
    assert.deepEqual(left.map((d) => d.endpoint), [s1.endpoint, s3.endpoint]);
    assert.ok(left[0]!.lastOkAt && !left[0]!.lastError);
    assert.match(left[1]!.lastError!, /^403/);
    // A 410 is not a removal on purpose: the browser's next re-sync may add it back.
    assert.ok("device" in store.upsertDevice({ subscription: s2, resync: true }));
    status[s3.endpoint] = 201;
    await deliver(store.readDevices().filter((d) => d.endpoint === s3.endpoint), payload, "mailto:ops@example.test", fetchImpl);
    const d3 = store.readDevices().find((d) => d.endpoint === s3.endpoint)!;
    assert.equal(d3.lastError, undefined);
    for (const s of [s1, s2, s3]) store.removeDevice({ endpoint: s.endpoint }, false);
  });

  test("a removal on purpose sticks against a re-sync, until an Enable; a renewal keeps label and age", () => {
    const s = fakeSub(4);
    const first = store.upsertDevice({ subscription: s, label: "Phone" }, 100);
    assert.ok("device" in first);
    assert.equal(store.removeDevice({ id: store.deviceId(s.endpoint) }, true), true);
    assert.deepEqual(store.upsertDevice({ subscription: s, resync: true }), { removed: true });
    // A renewal of a removed device (the service worker's pushsubscriptionchange) stays removed too.
    assert.deepEqual(store.upsertDevice({ subscription: fakeSub(9), resync: true, replaces: s.endpoint }), { removed: true });
    assert.equal(store.readDevices().length, 0);
    assert.ok("device" in store.upsertDevice({ subscription: s, label: "Phone" }, 200));
    const renewed = fakeSub(5);
    const r = store.upsertDevice({ subscription: renewed, replaces: s.endpoint }, 300);
    assert.ok("device" in r);
    assert.equal(r.device.label, "Phone");
    assert.equal(r.device.createdAt, 200);
    assert.deepEqual(store.readDevices().map((d) => d.endpoint), [renewed.endpoint]);
    store.removeDevice({ endpoint: renewed.endpoint }, false);
    assert.ok("error" in store.upsertDevice({ subscription: { endpoint: "http://x.test/1", keys: s.keys } }));
    assert.ok("error" in store.upsertDevice({ subscription: { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: "AAAA" } } }));
  });

  test("Send Test: refused without a contact, or with no device", async () => {
    writeFileSync(store.pushSettingsFile(), JSON.stringify({ ...store.defaultPushSettings(), contact: null }));
    assert.equal(((await sendTest()) as { status: number }).status, 409);
    writeFileSync(store.pushSettingsFile(), JSON.stringify(settings()));
    assert.equal(((await sendTest()) as { status: number }).status, 404);
  });
});

describe("/api/push", () => {
  const req = (method: string, path: string, body?: unknown) =>
    pushRoutes.request(path, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}) });

  test("GET never carries an endpoint or keys, and is no-store", async () => {
    const s = fakeSub(6);
    assert.equal((await req("POST", "/subscribe", { subscription: s, label: "Laptop · Chrome" })).status, 200);
    const res = await req("GET", "/");
    assert.equal(res.headers.get("cache-control"), "no-store");
    const text = await res.text();
    assert.ok(!text.includes(s.endpoint) && !text.includes(s.keys.p256dh) && !text.includes(s.keys.auth));
    assert.ok(!text.includes(store.readOrCreateVapid().privateKey));
    const info = JSON.parse(text);
    assert.equal(info.publicKey, store.readOrCreateVapid().publicKey);
    assert.deepEqual(info.devices.map((d: { label: string; service: string; id: string }) => [d.label, d.service, d.id]), [["Laptop · Chrome", "push.example.test", store.deviceId(s.endpoint)]]);
    // Remove on purpose, then the load-time re-sync is refused with 410.
    assert.deepEqual(await (await req("DELETE", "/subscribe", { id: store.deviceId(s.endpoint) })).json(), { removed: true });
    assert.equal((await req("POST", "/subscribe", { subscription: s, resync: true })).status, 410);
  });

  test("PUT /settings is strict", async () => {
    const bad = await req("PUT", "/settings", { contact: "ops@example.test" });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /mailto:/);
    const ok = await req("PUT", "/settings", { ...settings(), kinds: { ...store.DEFAULT_KINDS, "worker-error": true } });
    assert.equal(ok.status, 200);
    assert.equal(store.readPushSettings().kinds["worker-error"], true);
  });
});

test("a proposed playbook run is a push kind, on by default, worded \"Playbook needs you\" (§app.project-runtime/review)", async () => {
  const { defaultPushSettings } = await import("./push-store");
  const { PUSH_KIND_LABEL, pushDecision } = await import("./push");
  const settings = { ...defaultPushSettings(), contact: "mailto:a@b.c" };
  assert.equal(settings.kinds["playbook-review"], true);
  assert.equal(PUSH_KIND_LABEL["playbook-review"], "Playbook needs you");
  const b = { id: "s1", kind: "playbook-review" as const, title: "Project verbs: site", detail: "Project verbs: approve 0123456789ab and merge into main" };
  const out = pushDecision({ current: [b], announced: new Set(), settings, devices: 1, now: 100_000, lastSentAt: 0, quiet: false, viewing: () => false });
  assert.deepEqual(out.send.map((x) => x.kind), ["playbook-review"]);
});
