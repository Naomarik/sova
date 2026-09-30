// Run: npx tsx --test server/schedules.test.ts (or pnpm test)
// The schedules' keeper (§chat.schedules/*): approval pinned to when/tz/profile, what a fire does
// (One at a time wakes, anything else starts a session), skipping while the last run goes, the
// restart catch-up, the limit-reset continue, the automatic pause and the caps. Every session,
// profile, login and clock is a fake; the store lives in a throwaway directory.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "sova-schedules-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const { ScheduleKeeper, CHANGED, PAUSED_UNOPENED, MAX_APPROVED, UNOPENED_PAUSE } = await import("./schedules");
type Keeper = InstanceType<typeof ScheduleKeeper>;
import type { ListedProfile } from "../shared/profiles";
import type { PlaybookInfo, SessionSummary } from "../shared/protocol";
import type { LoginNow } from "./schedules";

after(() => rmSync(agentDir, { recursive: true, force: true }));

const ROOT = "/work/sova";
const MIN = 60_000;
let n = 0;

interface Harness {
  keeper: Keeper;
  now: { t: number };
  playbooks: Map<string, Record<string, string>>;
  profile: ListedProfile;
  sessions: SessionSummary[];
  busy: Set<string>;
  seen: Map<string, number>;
  created: { profile: string; text: string; title: string }[];
  woken: { path: string; text: string }[];
  logins: LoginNow[];
  turns: Map<string, { failed: boolean; at: number; login?: string }>;
  slots: { free: number };
  log(): { outcome: string; why?: string; trigger: string }[];
  /** A new keeper on the same store: a server restart. */
  restart(): Keeper;
  pin(id?: string): Promise<string>;
}

function harness(opts: { when?: string; singleton?: boolean; start?: string } = {}): Harness {
  const dir = mkdtempSync(join(agentDir, `h${n++}-`));
  const now = { t: Date.parse(opts.start ?? "2026-10-05T08:50:00Z") }; // Monday
  const playbooks = new Map<string, Record<string, string>>();
  playbooks.set("merge-round", { title: "Merge round", when: opts.when ?? "every 30m", profile: "merge-captain", tz: "UTC" });
  const profile: ListedProfile = {
    id: "merge-captain",
    label: "Merge captain",
    icon: "branch",
    description: "",
    remove: ["web"],
    grant: ["sessions.read"],
    singleton: opts.singleton ?? false,
    limits: {} as ListedProfile["limits"],
    overseerMayStart: false,
    source: "project",
    key: `project:${ROOT}#merge-captain`,
    project: ROOT,
    projectName: "sova",
    approval: "approved",
  };
  const sessions: SessionSummary[] = [];
  const busy = new Set<string>();
  const seen = new Map<string, number>();
  const created: Harness["created"] = [];
  const woken: Harness["woken"] = [];
  const logins: LoginNow[] = [];
  const turns = new Map<string, { failed: boolean; at: number; login?: string }>();
  const slots = { free: 5 };
  const file = join(dir, "schedules.json");
  const logFile = join(dir, "schedule-runs.jsonl");
  let made = 0;
  const make = () =>
    new ScheduleKeeper({
      file,
      logFile,
      now: () => now.t,
      realNow: () => now.t,
      lateAfterMs: MIN,
      async readPlaybook(root, id) {
        const fields = root === ROOT ? playbooks.get(id) : undefined;
        if (!fields) return null;
        const info: PlaybookInfo = { id, title: fields.title ?? id, description: "", source: "project", dir: `${ROOT}/.sova/playbooks/${id}`, body: fields.body ?? "Do the round." };
        return { info, fields };
      },
      findProfile: async (id) => (id === profile.id ? { ...profile } : null),
      sessions: async () => sessions,
      busy: (path) => busy.has(path),
      freeSlots: () => slots.free,
      started: () => {},
      async wake(path, text) {
        woken.push({ path, text });
        return { ok: true };
      },
      async create(_root, p, text, title) {
        const id = `sess-${++made}`;
        const path = `/sessions/${id}.jsonl`;
        created.push({ profile: p.id, text, title });
        sessions.push({
          id,
          path,
          cwd: ROOT,
          title,
          profile: { id: profile.id, label: profile.label, icon: profile.icon, source: "project", project: ROOT, ...(profile.singleton ? { singleton: true as const } : {}) },
        } as SessionSummary);
        return { ok: true, id, path };
      },
      seenAt: (id) => seen.get(id) ?? 0,
      logins: () => logins,
      lastTurn: async (path) => turns.get(path) ?? null,
    });
  const h: Harness = {
    keeper: make(),
    now,
    playbooks,
    profile,
    sessions,
    busy,
    seen,
    created,
    woken,
    logins,
    turns,
    slots,
    log: () =>
      readFileSync(logFile, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l)),
    restart() {
      h.keeper = make();
      return h.keeper;
    },
    async pin() {
      const s = (await h.keeper.list()).find((x) => x.playbook === "merge-round");
      if (s?.pin) return s.pin;
      // Not registered yet: the catalog registers it, as the Playbooks dialog does.
      const cat = await h.keeper.decorate(
        { playbooks: [{ id: "merge-round", title: "Merge round", description: "", source: "project", dir: "", body: "", schedule: { when: "x", state: "needs-approval" } }], project: { state: "ok" } },
        ROOT,
      );
      return cat.playbooks[0]!.schedule!.pin!;
    },
  };
  return h;
}

/** Approve with the pin the client would have been shown. */
async function approve(h: Harness) {
  const r = await h.keeper.approve(ROOT, "merge-round", await h.pin());
  assert.ok(r.ok, r.ok ? "" : r.error);
  return r.schedule;
}
/** Move the clock to the next fire and tick. */
async function tickAt(h: Harness, iso: string) {
  h.now.t = Date.parse(iso);
  await h.keeper.tick();
}

test("nothing fires before the user approves it, and an approve for a stale pin is refused", async () => {
  const h = harness();
  const pin = await h.pin();
  await tickAt(h, "2026-10-05T09:00:00Z");
  await tickAt(h, "2026-10-05T09:30:00Z");
  assert.equal(h.created.length, 0);
  const listed = (await h.keeper.list())[0]!;
  assert.equal(listed.state, "needs-approval");
  assert.equal(listed.text, "Every 30 min");
  const stale = await h.keeper.approve(ROOT, "merge-round", "0000000000000000");
  assert.ok(!stale.ok && stale.status === 409 && /changed since it was shown/.test(stale.error));
  const r = await h.keeper.approve(ROOT, "merge-round", pin);
  assert.ok(r.ok);
  assert.equal(r.schedule.state, "active");
  assert.equal(r.schedule.next, "2026-10-05T10:00:00.000Z");
});

test("a fire on a profile that isn't One at a time starts a new session each time, with the tagged playbook turn", async () => {
  const h = harness();
  await approve(h);
  await tickAt(h, "2026-10-05T08:59:30Z"); // approved at 08:50: the first is 09:00
  assert.equal(h.created.length, 0);
  await tickAt(h, "2026-10-05T09:00:10Z");
  await tickAt(h, "2026-10-05T09:30:05Z");
  assert.equal(h.created.length, 2);
  const [first] = h.created;
  assert.equal(first!.title, "Merge round (scheduled)");
  assert.match(first!.text, /^\[schedule s1\] Scheduled run fired \(every 30m, playbook merge-round\)\.\nReason: Run this playbook\n\nPlaybook: Merge round — \/work\/sova\/\.sova\/playbooks\/merge-round\n/);
  assert.doesNotMatch(first!.text, /Late by/, "an on-time fire has no late line");
  assert.equal(h.woken.length, 0);
});

test("One at a time: the first fire starts the session, later fires wake it, never a second one", async () => {
  const h = harness({ singleton: true });
  await approve(h);
  await tickAt(h, "2026-10-05T09:00:00Z");
  assert.equal(h.created.length, 1);
  await tickAt(h, "2026-10-05T09:30:00Z");
  await tickAt(h, "2026-10-05T10:00:00Z");
  assert.equal(h.created.length, 1, "no second One at a time session");
  assert.equal(h.woken.length, 2);
  assert.equal(h.woken[0]!.path, h.sessions[0]!.path);
  assert.match(h.woken[0]!.text, /^\[schedule s1\] Scheduled run fired \(every 30m, playbook merge-round\)\.\nReason: Run this playbook\nRun the playbook "Merge round" again: read \/work\/sova\/\.sova\/playbooks\/merge-round\/PLAYBOOK\.md first/);
  // Archived: the next fire starts a fresh one.
  h.sessions[0]!.archived = true;
  await tickAt(h, "2026-10-05T10:30:00Z");
  assert.equal(h.created.length, 2);
});

test("a fire is skipped while the last run is still going or queued", async () => {
  const h = harness({ singleton: true });
  await approve(h);
  await tickAt(h, "2026-10-05T09:00:00Z");
  h.busy.add(h.sessions[0]!.path);
  await tickAt(h, "2026-10-05T09:30:00Z");
  assert.equal(h.woken.length, 0);
  assert.equal(h.log().at(-1)!.why, "the last run is still going");
  h.busy.clear();
  await tickAt(h, "2026-10-05T10:00:00Z");
  assert.equal(h.woken.length, 1);
});

test("the running-at-once cap skips a fire", async () => {
  const h = harness();
  await approve(h);
  h.slots.free = 0;
  await tickAt(h, "2026-10-05T09:00:00Z");
  assert.equal(h.created.length, 0);
  assert.equal(h.log().at(-1)!.why, "the running-at-once limit was reached");
});

test("the approval is pinned to when, tz and the profile; instruction and task edits don't ask again", async () => {
  const h = harness();
  await approve(h);
  const pb = h.playbooks.get("merge-round")!;
  pb.body = "Do the round, differently.";
  pb.task = "Land what is ready.";
  await tickAt(h, "2026-10-05T09:00:00Z");
  assert.equal(h.created.length, 1, "an instructions edit still fires");
  assert.match(h.created[0]!.text, /Reason: Land what is ready\./);
  // when: changes → paused, nothing fires.
  pb.when = "every 1h";
  await tickAt(h, "2026-10-05T09:30:00Z");
  await tickAt(h, "2026-10-05T10:00:00Z");
  assert.equal(h.created.length, 1);
  let s = (await h.keeper.list())[0]!;
  assert.equal(s.state, "paused");
  assert.equal(s.reason, CHANGED);
  // Approving the new pin resumes it.
  await approve(h);
  await tickAt(h, "2026-10-05T11:00:00Z");
  assert.equal(h.created.length, 2);
  // The profile gains a power → paused again.
  h.profile.grant = ["sessions.read", "sessions.message"];
  s = (await h.keeper.list())[0]!;
  assert.equal(s.state, "paused");
  assert.equal(s.reason, CHANGED);
  // tz changes → paused too.
  h.profile.grant = ["sessions.read"];
  assert.equal((await h.keeper.list())[0]!.state, "active");
  pb.tz = "Asia/Dubai";
  assert.equal((await h.keeper.list())[0]!.reason, CHANGED);
});

test("revoke stops it at once; the schedule reads Needs approval again", async () => {
  const h = harness();
  const s = await approve(h);
  assert.deepEqual(await h.keeper.revoke(s.id), { ok: true });
  await tickAt(h, "2026-10-05T09:00:00Z");
  assert.equal(h.created.length, 0);
  assert.equal((await h.keeper.list())[0]!.state, "needs-approval");
  const again = await h.keeper.revoke(s.id);
  assert.ok(!again.ok && again.status === 409);
  const unknown = await h.keeper.revoke("s99");
  assert.ok(!unknown.ok && unknown.status === 404);
});

test("restart: a fire under an hour late goes out once with its late line; later than that it is skipped", async () => {
  const h = harness();
  await approve(h); // at 08:50, next 09:00
  // Down from 08:55 until 09:40: one fire, 40 min late, then the next is computed from now.
  h.restart();
  await tickAt(h, "2026-10-05T09:40:00Z");
  assert.equal(h.created.length, 1, "never caught up one by one");
  assert.match(h.created[0]!.text, /\nLate by 40m \(Sova was not running\)\.\n/);
  assert.equal((await h.keeper.list())[0]!.next, "2026-10-05T10:00:00.000Z");
  // Down from 09:45 until 11:20: the 10:00 fire is 1h20m late: skipped and logged.
  h.restart();
  await tickAt(h, "2026-10-05T11:20:00Z");
  assert.equal(h.created.length, 1);
  assert.match(h.log().at(-1)!.why!, /missed while Sova was not running \(late by 1h 20m\)/);
  await tickAt(h, "2026-10-05T11:30:00Z");
  assert.equal(h.created.length, 2);
});

test("limit reset: continues only this schedule's sessions that stopped at that login's limit, never starts one", async () => {
  const h = harness({ when: "claude-limit-reset", singleton: true });
  await approve(h);
  // The schedule's One at a time session, and three others.
  const mine = { id: "mine", path: "/s/mine.jsonl", cwd: ROOT, title: "Merge captain", profile: { id: "merge-captain", label: "Merge captain", icon: "branch", singleton: true, source: "project", project: ROOT } } as SessionSummary;
  const other = { id: "other", path: "/s/other.jsonl", cwd: ROOT, title: "Other" } as SessionSummary;
  h.sessions.push(mine, other);
  const since = Date.parse("2026-10-05T09:00:00Z");
  h.logins.push({ id: "A", name: "Work", state: "limited", since, until: Date.parse("2026-10-05T12:00:00Z") }, { id: "B", name: "Home", state: "ready" });
  await tickAt(h, "2026-10-05T09:05:00Z"); // the keeper sees A limited
  h.turns.set(mine.path, { failed: true, at: since + 2 * MIN, login: "A" });
  h.turns.set(other.path, { failed: true, at: since + 2 * MIN, login: "A" }); // not this schedule's
  h.logins[0] = { id: "A", name: "Work", state: "ready" };
  await tickAt(h, "2026-10-05T12:00:30Z");
  assert.equal(h.created.length, 0, "a reset never starts a session");
  assert.deepEqual(h.woken.map((w) => w.path), [mine.path]);
  assert.equal(
    h.woken[0]!.text,
    "[schedule s1] Scheduled run fired (claude-limit-reset, playbook merge-round).\nReason: Claude login Work is ready again.\nYour last turn stopped at that Claude login's usage limit, which has now reset. Continue where you left off.",
  );
  // Once per reset: the next tick sends nothing more.
  await tickAt(h, "2026-10-05T12:01:00Z");
  assert.equal(h.woken.length, 1);
  // Another login's reset doesn't touch a session that stopped on A; nor one that failed before the limit began.
  h.logins[1] = { id: "B", name: "Home", state: "limited", since: Date.parse("2026-10-05T12:05:00Z"), until: Date.parse("2026-10-05T13:00:00Z") };
  await tickAt(h, "2026-10-05T12:10:00Z");
  h.logins[1] = { id: "B", name: "Home", state: "ready" };
  await tickAt(h, "2026-10-05T13:00:10Z");
  assert.equal(h.woken.length, 1);
  h.logins[0] = { id: "A", name: "Work", state: "limited", since: Date.parse("2026-10-05T14:00:00Z"), until: Date.parse("2026-10-05T15:00:00Z") };
  await tickAt(h, "2026-10-05T14:01:00Z");
  h.logins[0] = { id: "A", name: "Work", state: "ready" };
  await tickAt(h, "2026-10-05T15:00:10Z");
  assert.equal(h.woken.length, 1, "mine failed at 09:02, before this limit began at 14:00");
});

test("limit reset: a standing cleared outright is a reset; one seen over an hour late is skipped", async () => {
  const h = harness({ when: "claude-limit-reset", singleton: true });
  await approve(h);
  const mine = { id: "mine", path: "/s/mine.jsonl", cwd: ROOT, title: "Merge captain", profile: { id: "merge-captain", label: "Merge captain", icon: "branch", singleton: true, source: "project", project: ROOT } } as SessionSummary;
  h.sessions.push(mine);
  const since = Date.parse("2026-10-05T09:00:00Z");
  h.logins.push({ id: "A", name: "Work", state: "limited", since, until: Date.parse("2026-10-05T10:00:00Z") });
  await tickAt(h, "2026-10-05T09:05:00Z");
  h.turns.set(mine.path, { failed: true, at: since + MIN, login: "A" });
  // Sova is down; the standing is cleared (the login no longer listed), and it comes back at 11:30,
  // 1h30 after the reset time: skipped.
  h.logins.length = 0;
  h.restart();
  await tickAt(h, "2026-10-05T11:30:00Z");
  assert.equal(h.woken.length, 0);
  assert.match(h.log().at(-1)!.why!, /the reset of Work was 1h 30m ago, while Sova was not running/);
});

test("ten runs nobody opened pause a schedule; waking a running One at a time session never counts", async () => {
  const h = harness();
  await approve(h);
  let t = Date.parse("2026-10-05T09:00:00Z");
  for (let i = 0; i < UNOPENED_PAUSE; i++, t += 30 * MIN) await tickAt(h, new Date(t).toISOString());
  assert.equal(h.created.length, UNOPENED_PAUSE);
  await tickAt(h, new Date(t).toISOString());
  assert.equal(h.created.length, UNOPENED_PAUSE, "the 11th pauses instead of firing");
  let s = (await h.keeper.list())[0]!;
  assert.equal(s.state, "paused");
  assert.equal(s.reason, PAUSED_UNOPENED);
  // Approving again resumes it and starts the count over.
  await approve(h);
  t += 30 * MIN;
  await tickAt(h, new Date(t).toISOString());
  assert.equal(h.created.length, UNOPENED_PAUSE + 1);
  s = (await h.keeper.list())[0]!;
  assert.equal(s.state, "active");

  // Opening one breaks the run.
  const g = harness();
  await approve(g);
  t = Date.parse("2026-10-05T09:00:00Z");
  for (let i = 0; i < 9; i++, t += 30 * MIN) await tickAt(g, new Date(t).toISOString());
  g.seen.set(g.sessions[8]!.id, t);
  for (let i = 0; i < 5; i++, t += 30 * MIN) await tickAt(g, new Date(t).toISOString());
  assert.equal(g.created.length, 14);
  assert.equal((await g.keeper.list())[0]!.state, "active");

  // One at a time: one new session, then wakes, never paused however many.
  const w = harness({ singleton: true });
  await approve(w);
  t = Date.parse("2026-10-05T09:00:00Z");
  for (let i = 0; i < 20; i++, t += 30 * MIN) await tickAt(w, new Date(t).toISOString());
  assert.equal(w.created.length, 1);
  assert.equal(w.woken.length, 19);
  assert.equal((await w.keeper.list())[0]!.state, "active");
});

test("at most 48 fires a day: every 30m fills it, so a limit reset that day is skipped", async () => {
  const h = harness({ when: "every 30m; claude-limit-reset", singleton: true, start: "2026-10-04T23:50:00Z" });
  await approve(h);
  let t = Date.parse("2026-10-05T00:00:00Z");
  for (let i = 0; i < 48; i++, t += 30 * MIN) await tickAt(h, new Date(t).toISOString());
  assert.equal(h.created.length + h.woken.length, 48);
  const holder = h.sessions[0]!;
  h.logins.push({ id: "A", name: "Work", state: "limited", since: Date.parse("2026-10-05T23:00:00Z"), until: Date.parse("2026-10-05T23:59:00Z") });
  await tickAt(h, "2026-10-05T23:40:00Z");
  h.turns.set(holder.path, { failed: true, at: Date.parse("2026-10-05T23:10:00Z"), login: "A" });
  h.logins[0] = { id: "A", name: "Work", state: "ready" };
  await tickAt(h, "2026-10-05T23:59:10Z");
  assert.equal(h.created.length + h.woken.length, 48);
  assert.match(h.log().at(-1)!.why!, /fired 48 times today/);
});

test(`at most ${MAX_APPROVED} approved schedules per host`, async () => {
  const h = harness();
  const pin = await h.pin();
  // Fill the store with 20 approved schedules of other playbooks.
  const file = (h.keeper.deps as { file: string }).file;
  const store = JSON.parse(readFileSync(file, "utf8"));
  for (let i = 0; i < MAX_APPROVED; i++) store.schedules.push({ id: `x${i}`, root: "/elsewhere", playbook: `p${i}`, approved: { pin: "p", at: 0 }, fires: [] });
  (await import("node:fs")).writeFileSync(file, JSON.stringify(store));
  const r = await h.keeper.approve(ROOT, "merge-round", pin);
  assert.ok(!r.ok && r.status === 409 && /at most 20 schedules/.test(r.error));
});

test("a profile that needs its own approval refuses the schedule's approve; a missing profile makes it invalid", async () => {
  const h = harness();
  const pin = await h.pin();
  h.profile.approval = "needed";
  const r = await h.keeper.approve(ROOT, "merge-round", pin);
  assert.ok(!r.ok && /needs your approval first/.test(r.error));
  h.profile.approval = "approved";
  h.playbooks.get("merge-round")!.profile = "nobody";
  const s = (await h.keeper.list())[0]!;
  assert.equal(s.state, "invalid");
  assert.match(s.reason!, /No profile "nobody"/);
});
