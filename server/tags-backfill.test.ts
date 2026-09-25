// Run: npx tsx --test server/tags-backfill.test.ts
// The tags backfill against a scripted FakeProvider: scope, resumability, the stop rules, the
// concurrency it asks for, cancel, the job file a restart resumes from, and the routes.
// Uses a throwaway PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { DecisionSettings, SessionSummary, TagsBackfillProgress } from "../shared/protocol";

const agentDir = mkdtempSync(join(tmpdir(), "sova-tags-backfill-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths
const sessionsDir = join(agentDir, "sessions", "--tmp-backfill--");
mkdirSync(sessionsDir, { recursive: true });

const { SessionTagger, tagRecord } = await import("./session-tags");
const bf = await import("./tags-backfill");
const { createFakeProvider } = await import("./decide-fake");

after(() => rmSync(agentDir, { recursive: true, force: true }));

const DAY = 86_400_000;
const NOW = Date.parse("2026-09-25T12:00:00.000Z");
const SETTINGS: DecisionSettings = {
  version: 1,
  jev: { enabled: true },
  fallback: null,
  features: { attention: false, tags: true },
  exclusions: [],
  neverSendTui: false,
};
const REPLY = {
  topic: { probabilities: { feature: 1 } },
  status: { probabilities: { done: 1 } },
  throwaway: { p: 0 },
};

let seq = 0;
function session(daysAgo: number, over: Partial<SessionSummary> = {}): SessionSummary {
  seq++;
  const id = `01234567-89ab-7cde-8f01-${String(seq).padStart(12, "0")}`;
  const path = join(sessionsDir, `x_${id}.jsonl`);
  const m = (eid: string, role: string, content: string) => JSON.stringify({ type: "message", id: eid, parentId: null, message: { role, content } });
  writeFileSync(path, `${[JSON.stringify({ type: "session", version: 3, id, cwd: "/w" }), m("u1", "user", "do it"), m("a1", "assistant", "done")].join("\n")}\n`);
  return {
    id,
    path,
    cwd: "/w",
    title: "do it",
    createdAt: new Date(NOW - daysAgo * DAY - 3600_000).toISOString(),
    lastActiveAt: new Date(NOW - daysAgo * DAY).toISOString(),
    model: null,
    live: null,
    busy: false,
    origin: "external",
    archived: false,
    ...over,
  };
}

function job(rows: SessionSummary[], reply: Parameters<typeof createFakeProvider>[0]["reply"], over: Partial<ConstructorParameters<typeof bf.TagsBackfill>[0]> & { settings?: () => DecisionSettings } = {}) {
  const fake = createFakeProvider({ reply, delayMs: 2 });
  const settings = over.settings ?? (() => SETTINGS);
  const tagger = new SessionTagger({ provider: () => fake, settings, redact: (v) => v, now: () => NOW });
  const published: TagsBackfillProgress[] = [];
  const b = new bf.TagsBackfill({
    list: async () => rows,
    tagger,
    settings,
    ready: () => ({ ready: true }),
    now: () => NOW,
    publish: (p) => published.push(p),
    file: join(agentDir, `job-${seq}-${Math.random()}.json`),
    ...over,
  });
  return { fake, b, published, tagger };
}

test("backfillRows: recent = last 30 days; ineligible rows never counted; a running one is", () => {
  const recent = session(3);
  const old = session(45);
  const worker = session(1, { workerSession: true });
  const running = session(0, { busy: true });
  const rows = [recent, old, worker, running];
  assert.deepEqual(bf.backfillRows(rows, "recent", SETTINGS, NOW).map((r) => r.id), [recent.id, running.id]);
  assert.deepEqual(bf.backfillRows(rows, "all", SETTINGS, NOW).map((r) => r.id), [recent.id, old.id, running.id]);
  assert.deepEqual(bf.backfillRows(rows, "all", { ...SETTINGS, exclusions: ["/w"] }, NOW), []);
});

test("a job classifies every row in scope, asks for at most 2 at once, and reports progress", async () => {
  const rows = Array.from({ length: 7 }, (_, i) => session(i));
  const { fake, b, published } = job(rows, REPLY);
  const started = b.start("recent");
  assert.ok("progress" in started && started.progress.running);
  const again = b.start("all");
  assert.ok("progress" in again && again.progress.scope === "recent", "a second start returns the running job");
  await b.settled();
  const p = b.status();
  assert.deepEqual({ running: p.running, done: p.done, total: p.total, failed: p.failed, stoppedReason: p.stoppedReason }, { running: false, done: 7, total: 7, failed: 0, stoppedReason: undefined });
  assert.equal(fake.calls.length, 7);
  assert.ok(fake.maxInFlight <= bf.BACKFILL_CONCURRENCY);
  assert.ok(rows.every((r) => tagRecord(r.id)?.basis?.turnId === "a1"));
  assert.equal(published.at(-1)?.running, false);
  assert.equal(published.at(-1)?.done, 7);
});

test("resumable: a second job over the same sessions pays for none of them", async () => {
  const rows = Array.from({ length: 3 }, (_, i) => session(i));
  const first = job(rows, REPLY);
  first.b.start("all");
  await first.b.settled();
  const second = job(rows, REPLY);
  second.b.start("all");
  await second.b.settled();
  assert.equal(second.fake.calls.length, 0);
  assert.equal(second.b.status().done, 3);
});

test("stops: after 5 failures in a row, and at once when the chain has nothing to try", async () => {
  const rows = Array.from({ length: 12 }, (_, i) => session(i));
  const { b } = job(rows, { fail: "malformed-answer" });
  b.start("all");
  await b.settled();
  const p = b.status();
  assert.equal(p.running, false);
  assert.ok(p.failed >= bf.BACKFILL_MAX_CONSECUTIVE_FAILURES && p.failed < 12, `failed ${p.failed}`);
  assert.match(p.stoppedReason ?? "", /in a row failed/);

  const rows2 = Array.from({ length: 6 }, (_, i) => session(i));
  const u = job(rows2, { fail: "unavailable", message: "no provider" });
  u.b.start("all");
  await u.b.settled();
  assert.match(u.b.status().stoppedReason ?? "", /No decision provider/);
  assert.ok(u.fake.calls.length <= bf.BACKFILL_CONCURRENCY);
  assert.equal(u.b.status().failed, 0, "unavailable is the chain's state, not a session's failure");
});

test("a failure followed by a success resets the streak", async () => {
  const rows = Array.from({ length: 10 }, (_, i) => session(i));
  const { b } = job(rows, (_req, call) => (call % 4 === 3 ? REPLY : { fail: "server" }));
  b.start("all");
  await b.settled();
  const p = b.status();
  assert.equal(p.stoppedReason, undefined);
  assert.equal(p.done, 10);
});

test("switching the feature off mid-job stops it; start refuses while off or unavailable", async () => {
  let on = true;
  const settings = () => ({ ...SETTINGS, features: { attention: false, tags: on } });
  const rows = Array.from({ length: 8 }, (_, i) => session(i));
  const { b, fake } = job(rows, (_req, call) => {
    if (call === 1) on = false;
    return REPLY;
  }, { settings });
  b.start("all");
  await b.settled();
  assert.match(b.status().stoppedReason ?? "", /switched off/);
  assert.ok(fake.calls.length < 8);
  assert.deepEqual(b.start("all"), { error: "Session tags are off." });
  on = true;
  const n = job(rows, REPLY, { ready: () => ({ ready: false, reason: "No provider is configured." }) });
  assert.deepEqual(n.b.start("all"), { error: "No provider is configured." });
});

test("cancel stops the job, keeps what it classified, and clears the resume mark", async () => {
  const rows = Array.from({ length: 20 }, (_, i) => session(i));
  const file = join(agentDir, "cancel-job.json");
  const { b } = job(rows, REPLY, { file });
  b.start("all");
  assert.equal(b.pendingScope(), "all", "a running job is in the job file");
  await new Promise((r) => setTimeout(r, 10));
  const p = b.cancel();
  assert.equal(p.running, false);
  assert.equal(p.stoppedReason, "Stopped.");
  await b.settled();
  assert.ok(b.status().done < 20);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).running, false);
  assert.equal(b.pendingScope(), null);
});

test("routes: manual tags, backfill refusals and progress", async () => {
  const { Hono } = await import("hono");
  const app = new Hono();
  app.route("/api/sessions/tags", bf.tagRoutes);
  const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const ok = await post("/api/sessions/tags", { id: "some-id", user: ["#Later", "later"] });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { tags: { user: ["later"] } });
  const cleared = await post("/api/sessions/tags", { id: "some-id", user: null });
  assert.deepEqual(await cleared.json(), { tags: null });
  assert.equal((await post("/api/sessions/tags", { id: "some-id", user: ["no spaces"] })).status, 400);
  assert.equal((await post("/api/sessions/tags", { user: [] })).status, 400);
  assert.equal((await post("/api/sessions/tags", [1])).status, 400);

  assert.equal((await post("/api/sessions/tags/backfill", { scope: "none" })).status, 400);
  // Not started on this server → 409, never a silent no-op that reads as success.
  assert.equal((await post("/api/sessions/tags/backfill", { scope: "recent" })).status, 409);
  const idle = await app.request("/api/sessions/tags/backfill");
  assert.deepEqual(await idle.json(), { running: false, done: 0, total: 0, failed: 0 });

  const rows = [session(1), session(2)];
  const fake = createFakeProvider({ reply: REPLY });
  const stop = bf.startSessionTags({ list: async () => rows, provider: () => fake, settings: () => SETTINGS, ready: () => ({ ready: true }), tickMs: 3_600_000 });
  try {
    const res = await post("/api/sessions/tags/backfill", { scope: "all" });
    assert.equal(res.status, 200);
    const started = (await res.json()) as TagsBackfillProgress;
    assert.equal(started.running, true);
    for (let i = 0; i < 100 && ((await (await app.request("/api/sessions/tags/backfill")).json()) as TagsBackfillProgress).running; i++) await new Promise((r) => setTimeout(r, 10));
    const done = (await (await app.request("/api/sessions/tags/backfill")).json()) as TagsBackfillProgress;
    assert.equal(done.running, false);
    assert.equal(done.total, 2);
  } finally {
    stop();
  }
});
