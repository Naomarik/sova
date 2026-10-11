// Run: pnpm test -- server/schedules-carry.test.ts
// The store and the carry-over to an automation file (§chat.schedules/store), the automation's own
// session and settings (§chat.schedules/automation-file, /fire), and the playbook delivered inside
// every fire (§chat.schedules/delivery, /limit-reset). The files are real (a temp project with its
// playbook and automation file); sessions, profiles, logins and the clock are fakes, and a session's
// branch is the list of messages its fires sent.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "sova-schedules-carry-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const { ScheduleKeeper, CHANGED, OTHER_DEVICE, StoreRefused, backupFileOf, pinOf, readStore } = await import("./schedules");
const { readAutomations } = await import("./automation-files");
const { playbookPayload } = await import("./playbook-payload");
const { PlaybookVersions } = await import("./playbook-versions");
const { scheduleOf } = await import("../shared/schedules");
const { DEFAULT_LIMITS } = await import("../shared/profiles");
import type { HEntry } from "../shared/harness-history";
import type { ListedProfile } from "../shared/profiles";
import type { PlaybookInfo, SessionSummary } from "../shared/protocol";
import type { Automation } from "../shared/automations";
import type { LoginNow, ScheduleStore, StoredSchedule } from "./schedules";

after(() => rmSync(agentDir, { recursive: true, force: true }));

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.parse("2026-10-05T08:50:00Z");
const WHEN = "merge-ready; every 6h; claude-limit-reset";
const CAPTAIN_PATH = "/sessions/captain.jsonl";
let n = 0;

const ENTRY = `---\ntitle: Merge round\nprofile: merge-captain\nwhen: ${WHEN}\ntz: UTC\n---\n\n# Merge round\n\n${Array.from({ length: 30 }, (_, i) => `Rule ${i}: land one branch at a time, and read references/land.md before landing.`).join("\n")}\n`;
const AUTOMATION = {
  id: "merge-round",
  label: "Merge round",
  when: WHEN,
  tz: "UTC",
  playbook: "merge-round",
  session: "long-running",
  settings: { model: "zai/glm-5.3", thinking: "high" },
  permissions: { remove: ["web"], grant: ["sessions.read", "sessions.message"], oneAtATime: true, limits: { targetsPerRun: 10, perDay: 80 }, overseerMayStart: false },
};

/** The header's frontmatter as the playbook reader gives it. */
const fieldsOf = (text: string): Record<string, string> => {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  const out: Record<string, string> = {};
  for (const line of (m?.[1] ?? "").split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
};

function world(opts: { profile?: boolean; automation?: unknown; store?: (w: { root: string; pin: string }) => ScheduleStore | string | null } = {}) {
  const dir = mkdtempSync(join(agentDir, `w${n++}-`));
  const root = join(dir, "sova");
  const pbDir = join(root, ".sova", "playbooks", "merge-round");
  mkdirSync(join(pbDir, "references"), { recursive: true });
  writeFileSync(join(pbDir, "PLAYBOOK.md"), ENTRY);
  writeFileSync(join(pbDir, "references", "land.md"), "Land with round.mjs land.\n");
  const setAutomation = (a: unknown) => {
    mkdirSync(join(root, ".sova", "automations"), { recursive: true });
    writeFileSync(join(root, ".sova", "automations", "merge-round.json"), typeof a === "string" ? a : JSON.stringify(a));
  };
  if (opts.automation) setAutomation(opts.automation);
  const state = { profile: opts.profile ?? true, host: "h_thisone1" };
  const profile: ListedProfile = {
    id: "merge-captain",
    label: "Merge captain",
    icon: "branch",
    description: "",
    remove: ["workers", "web"],
    grant: ["sessions.read", "sessions.message"],
    singleton: true,
    limits: { ...DEFAULT_LIMITS, targetsPerRun: 10, perDay: 80 },
    overseerMayStart: false,
    source: "project",
    key: `project:${root}#merge-captain`,
    project: root,
    projectName: "sova",
    approval: "approved",
  };
  const header = scheduleOf(fieldsOf(ENTRY))!;
  const pin = pinOf({ tz: header.tz, triggers: header.triggers! }, profile);
  const now = { t: T0 };
  const sessions: SessionSummary[] = [{ id: "captain", path: CAPTAIN_PATH, cwd: root, title: "Merge captain", profile: { id: "merge-captain", label: "Merge captain", icon: "branch", source: "project", project: root, singleton: true } } as SessionSummary];
  const branches = new Map<string, HEntry[]>([[CAPTAIN_PATH, []]]);
  const woken: { path: string; text: string }[] = [];
  const configured: { path: string; automation: Automation }[] = [];
  const created: { text: string; title: string }[] = [];
  const slots = { free: 5 };
  const logins: LoginNow[] = [];
  const turns = new Map<string, { failed: boolean; at: number; login?: string }>();
  const file = join(dir, "schedules.json");
  const logFile = join(dir, "schedule-runs.jsonl");
  const versions = new PlaybookVersions(join(dir, "versions"));
  const initial = opts.store?.({ root, pin });
  if (initial) writeFileSync(file, typeof initial === "string" ? initial : `${JSON.stringify(initial, null, 2)}\n`);
  let k = 0;
  const say = (path: string, text: string) => branches.get(path)!.push({ id: `u${++k}`, parentId: null, kind: "user", blocks: [{ type: "text", text }] });
  const keeper = () =>
    new ScheduleKeeper({
      file,
      logFile,
      now: () => now.t,
      realNow: () => now.t,
      lateAfterMs: MIN,
      async readPlaybook(r, id) {
        if (r !== root || id !== "merge-round") return null;
        let text: string;
        try {
          text = readFileSync(join(pbDir, "PLAYBOOK.md"), "utf8");
        } catch {
          return null;
        }
        const fields = fieldsOf(text);
        const info: PlaybookInfo = { id, title: fields.title ?? id, description: "", source: "project", dir: pbDir, entry: "PLAYBOOK.md", body: text };
        return { info, fields };
      },
      findProfile: async (id) => (state.profile && id === profile.id ? { ...profile } : null),
      automations: readAutomations,
      sessions: async () => sessions,
      busy: () => false,
      freeSlots: () => slots.free,
      started: () => {},
      async wake(path, text) {
        woken.push({ path, text });
        say(path, text);
        return { ok: true };
      },
      async create() {
        return { ok: false, error: "no header-profile sessions in these tests" };
      },
      async createForAutomation(_r, _a, text, title) {
        const id = `auto-${created.length + 1}`;
        const path = `/sessions/${id}.jsonl`;
        created.push({ text, title });
        sessions.push({ id, path, cwd: root, title } as SessionSummary);
        branches.set(path, []);
        say(path, text);
        return { ok: true, id, path };
      },
      async configure(path, automation) {
        configured.push({ path, automation });
        return { ok: true };
      },
      payload: async (path, bundle) => playbookPayload(bundle, path ? { branch: branches.get(path) ?? [], cwd: root } : null, versions),
      hostId: () => state.host,
      seenAt: () => 0,
      logins: () => logins,
      lastTurn: async (path) => turns.get(path) ?? null,
    });
  return {
    root,
    pbDir,
    pin,
    file,
    now,
    state,
    sessions,
    branches,
    woken,
    configured,
    created,
    slots,
    logins,
    turns,
    versions,
    keeper,
    setAutomation,
    store: () => JSON.parse(readFileSync(file, "utf8")) as ScheduleStore,
    log: () => readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { outcome: string; why?: string; trigger: string; id: string; session?: string }),
  };
}

/** The live store's s1, sanitized: 30 wakes into the captain, today's count, the board's ready map, the next fire. */
function s1Fixture(root: string, pin: string): ScheduleStore {
  const fires = Array.from({ length: 30 }, (_, i) => ({ at: T0 - (30 - i) * HOUR, real: T0 - (30 - i) * HOUR, trigger: i % 3 ? "merge-ready" : "every 6h", kind: "wake" as const, sessionId: "captain", path: CAPTAIN_PATH }));
  const s1: StoredSchedule = {
    id: "s1",
    root,
    playbook: "merge-round",
    approved: { pin, at: T0 - 40 * HOUR },
    next: { at: Date.parse("2026-10-05T12:00:00Z"), trigger: "every 6h" },
    fires,
    day: { key: "2026-10-05", n: 2 },
    ready: { "/wt/feat-a": { branch: "feat/a", at: T0 - 2 * HOUR, out: true }, "/wt/feat-b": { branch: "feat/b", at: T0 - HOUR } },
  };
  return { version: 1, seq: 1, schedules: [s1], logins: { default: { state: "ready", name: "Claude" } } };
}

describe("s1 carries over to the automation file with no gap and no re-approval", () => {
  test("same id, approval time, fires, day count, ready map and next fire; no s2, no Needs approval; one backup", async () => {
    const w = world({ automation: AUTOMATION, store: ({ root, pin }) => s1Fixture(root, pin) });
    const before = readFileSync(w.file, "utf8");
    const fixture = JSON.parse(before) as ScheduleStore;
    const list = await w.keeper().list();
    assert.equal(list.length, 1, "no second schedule");
    const [s] = list;
    assert.deepEqual([s!.id, s!.automation, s!.state, s!.reason], ["s1", "merge-round", "active", undefined]);
    assert.equal(s!.next, "2026-10-05T12:00:00.000Z");
    const stored = w.store();
    assert.equal(stored.seq, 1, "no sN was minted");
    const row = stored.schedules[0]!;
    const was = fixture.schedules[0]!;
    assert.equal(row.approved!.at, was.approved!.at, "approval time kept");
    assert.equal(row.approved!.pin, was.approved!.pin, "the header pin kept, for an older Sova");
    assert.ok(row.approved!.pin2 && row.approved!.carried === T0);
    assert.deepEqual(row.fires, was.fires);
    assert.deepEqual([row.day, row.ready, row.next], [was.day, was.ready, was.next]);
    assert.deepEqual(row.session, { id: "captain", path: CAPTAIN_PATH }, "its own session: the captain the header's fires woke");
    assert.equal(row.host, "h_thisone1");
    const outcomes = w.log().map((l) => l.outcome);
    assert.ok(outcomes.includes("carried"));
    assert.ok(!outcomes.includes("approved") && !outcomes.includes("found"), outcomes.join(","));
    assert.equal(readFileSync(backupFileOf(w.file), "utf8"), before, "the store as it was, once");
    // Again: nothing more is carried, minted or backed up.
    await w.keeper().list();
    assert.equal(w.log().filter((l) => l.outcome === "carried").length, 1);
    assert.equal(w.store().schedules.length, 1);
    assert.equal(readFileSync(backupFileOf(w.file), "utf8"), before);
  });

  test("the next fire wakes the same captain, with its settings applied and the playbook inside", async () => {
    const w = world({ automation: AUTOMATION, store: ({ root, pin }) => s1Fixture(root, pin) });
    const k = w.keeper();
    w.now.t = Date.parse("2026-10-05T12:00:30Z");
    await k.tick();
    assert.equal(w.woken.length, 1);
    assert.equal(w.woken[0]!.path, CAPTAIN_PATH);
    assert.match(w.woken[0]!.text, /^\[schedule s1\] Scheduled run fired \(every 6h, automation merge-round\)\.\nReason: Run this playbook\nRun the playbook "Merge round": its entry is in the playbook block below\.\n<playbook id="merge-round" dir="[^"]+" entry="PLAYBOOK\.md" sha="[0-9a-f]{16}" load="full">\n---\ntitle: Merge round/);
    assert.deepEqual(w.configured.map((c) => [c.path, c.automation.settings.model]), [[CAPTAIN_PATH, "zai/glm-5.3"]]);
    assert.equal(w.store().schedules[0]!.fires.length, 30, "the 30 kept, the oldest out");
  });

  test("carried from what this Sova recorded while the header held, once the header and profile are gone", async () => {
    const w = world({ store: ({ root, pin }) => s1Fixture(root, pin) });
    await w.keeper().list(); // the header still declares it: its approval is recorded in automation terms
    assert.ok(w.store().schedules[0]!.approved!.carry2);
    writeFileSync(join(w.pbDir, "PLAYBOOK.md"), ENTRY.replace(/profile: .*\n/, "").replace(/when: .*\n/, ""));
    w.state.profile = false;
    w.setAutomation(AUTOMATION);
    const [s] = await w.keeper().list();
    assert.deepEqual([s!.id, s!.state], ["s1", "active"]);
    assert.ok(w.log().some((l) => l.outcome === "carried"));
  });

  test("a file that says something else is adopted but not approved: Changed since you approved it, until the user approves", async () => {
    const w = world({ automation: { ...AUTOMATION, permissions: { ...AUTOMATION.permissions, grant: ["sessions.read", "sessions.message", "sessions.all"] } }, store: ({ root, pin }) => s1Fixture(root, pin) });
    const [s] = await w.keeper().list();
    assert.deepEqual([s!.id, s!.state, s!.reason], ["s1", "paused", CHANGED]);
    assert.equal(w.store().schedules[0]!.approved!.at, T0 - 40 * HOUR, "the keeper approved nothing");
    assert.ok(w.log().some((l) => l.outcome === "adopted"));
    const ok = await w.keeper().approve(w.root, { automation: "merge-round" }, s!.pin!);
    assert.equal(ok.ok, true);
    assert.equal((await w.keeper().list())[0]!.state, "active");
  });
});

describe("the store is never read as empty", () => {
  for (const [what, text] of [
    ["not JSON", "{ not json"],
    ["another version", JSON.stringify({ version: 2, seq: 3, schedules: [] })],
    ["no schedules list", JSON.stringify({ version: 1, seq: 3 })],
  ] as const) {
    test(`${what}: refused, nothing fires, nothing is written`, async () => {
      const w = world({ automation: AUTOMATION, store: () => text });
      const k = w.keeper();
      await assert.rejects(k.list(), StoreRefused);
      await assert.rejects(k.tick(), StoreRefused);
      await assert.rejects(k.approve(w.root, { automation: "merge-round" }, "x"), StoreRefused);
      assert.equal(readFileSync(w.file, "utf8"), text, "the file as it was");
      assert.equal(w.woken.length, 0);
      assert.throws(() => readStore(w.file), StoreRefused);
    });
  }
  test("a missing store is empty, and a new automation file reads Needs approval", async () => {
    const w = world({ automation: AUTOMATION });
    await w.keeper().discover([w.root], async () => []);
    const [s] = await w.keeper().list();
    assert.deepEqual([s!.id, s!.state, s!.automation], ["s1", "needs-approval", "merge-round"]);
  });
});

describe("an older Sova keeps the migrated rows", () => {
  /** master's readStore before this change, frozen: what an older Sova would do with the file. */
  function v1Reader(file: string) {
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<ScheduleStore>;
      if (raw?.version !== 1 || !Array.isArray(raw.schedules)) throw new Error("not a store");
      return {
        version: 1,
        seq: typeof raw.seq === "number" ? raw.seq : 0,
        schedules: raw.schedules.filter((s) => s && typeof s.id === "string" && typeof s.root === "string" && typeof s.playbook === "string").map((s) => ({ ...s, fires: Array.isArray(s.fires) ? s.fires : [] })),
        logins: raw.logins && typeof raw.logins === "object" ? raw.logins : {},
      };
    } catch {
      return { version: 1, seq: 0, schedules: [], logins: {} };
    }
  }
  test("the carried s1 reads as s1 with its header pin, approval time and fires", async () => {
    const w = world({ automation: AUTOMATION, store: ({ root, pin }) => s1Fixture(root, pin) });
    await w.keeper().list();
    const old = v1Reader(w.file);
    assert.equal(old.seq, 1);
    assert.equal(old.schedules.length, 1);
    const s = old.schedules[0]!;
    assert.deepEqual([s.id, s.root, s.playbook, s.approved?.pin, s.approved?.at, s.fires.length], ["s1", w.root, "merge-round", w.pin, T0 - 40 * HOUR, 30]);
  });
});

describe("the playbook inside every fire (§chat.schedules/delivery)", () => {
  /** An approved automation with no session yet: its first fire starts one. */
  async function approved() {
    const w = world({ automation: AUTOMATION });
    const k = w.keeper();
    await k.discover([w.root], async () => []);
    const [s] = await k.list();
    assert.equal((await k.approve(w.root, { automation: "merge-round" }, s!.pin!)).ok, true);
    return { w, k };
  }
  const fireAt = async (w: ReturnType<typeof world>, k: InstanceType<typeof ScheduleKeeper>, iso: string) => {
    w.now.t = Date.parse(iso);
    await k.tick();
  };
  const load = (text: string) => /load="(full|diff|unchanged)"/.exec(text)?.[1];

  test("first fire: a new session with the entry whole; then unchanged; an edit goes as a diff; a read file edited since is listed until read again", async () => {
    const { w, k } = await approved();
    await fireAt(w, k, "2026-10-05T12:00:30Z");
    assert.equal(w.created.length, 1);
    assert.equal(w.created[0]!.title, "Merge round (automation)");
    assert.equal(load(w.created[0]!.text), "full");
    const own = w.store().schedules[0]!.session!;
    assert.equal(own.id, "auto-1");

    await fireAt(w, k, "2026-10-05T18:00:30Z");
    assert.equal(w.created.length, 1, "long-running: woken, never a second session");
    assert.equal(w.woken.at(-1)!.path, own.path);
    assert.equal(load(w.woken.at(-1)!.text), "unchanged");
    assert.match(w.woken.at(-1)!.text, /Unchanged since you last loaded it\./);

    // The session reads a detail file through playbook_read, which is then edited.
    const landSha = w.versions.keep("Land with round.mjs land.\n");
    w.branches.get(own.path)!.push(
      { id: "a1", parentId: null, kind: "assistant", blocks: [{ type: "toolCall", id: "c1", name: "playbook_read", arguments: { file: "references/land.md" } }] },
      { id: "r1", parentId: null, kind: "tool-result", callId: "c1", tool: "playbook_read", blocks: [{ type: "text", text: "Land with round.mjs land.\n" }], details: { v: 1, playbook: "merge-round", file: "references/land.md", sha: landSha } },
    );
    writeFileSync(join(w.pbDir, "references", "land.md"), "Land with round.mjs land, then landed.\n");
    writeFileSync(join(w.pbDir, "PLAYBOOK.md"), ENTRY.replace("Rule 7:", "Rule 7 (changed):"));
    await fireAt(w, k, "2026-10-06T00:00:30Z");
    const third = w.woken.at(-1)!.text;
    assert.equal(load(third), "diff");
    assert.match(third, /\n-Rule 7: land one branch/);
    assert.match(third, /\n\+Rule 7 \(changed\): land one branch/);
    assert.match(third, /Changed since you read it: references\/land\.md\. Call playbook_read to read them again\./);

    await fireAt(w, k, "2026-10-06T06:00:30Z");
    assert.match(w.woken.at(-1)!.text, /Changed since you read it: references\/land\.md\./, "still listed: not read again");
    assert.equal(load(w.woken.at(-1)!.text), "unchanged");

    // A compaction: the next fire is whole again, and nothing counts as read.
    w.branches.get(own.path)!.push({ id: "cp", parentId: null, kind: "compaction" });
    await fireAt(w, k, "2026-10-06T12:00:30Z");
    assert.equal(load(w.woken.at(-1)!.text), "full");
    assert.doesNotMatch(w.woken.at(-1)!.text, /Changed since you read it/);
  });

  test("a session with memory on as UniiChat gets the entry whole every time", async () => {
    const { w, k } = await approved();
    await fireAt(w, k, "2026-10-05T12:00:30Z");
    const own = w.store().schedules[0]!.session!;
    w.branches.get(own.path)!.push({ id: "m", parentId: null, kind: "state", key: "mode", data: { mode: "normal", active: { version: 1, mode: "normal", minorModes: ["memory"], strict: false } } }, { id: "mt", parentId: null, kind: "state", key: "sova-memory", data: { v: 1, type: "uniichat" } });
    await fireAt(w, k, "2026-10-05T18:00:30Z");
    assert.equal(load(w.woken.at(-1)!.text), "full");
  });

  test("a limit reset passes the running-at-once cap and carries the block", async () => {
    const { w, k } = await approved();
    await fireAt(w, k, "2026-10-05T12:00:30Z");
    const own = w.store().schedules[0]!.session!;
    w.logins.push({ id: "work", name: "Work", state: "limited", since: w.now.t - HOUR, until: w.now.t + MIN });
    await k.tick();
    w.turns.set(own.path, { failed: true, at: w.now.t, login: "work" });
    w.logins[0] = { id: "work", name: "Work", state: "ready" };
    w.slots.free = 0;
    w.now.t += 2 * MIN;
    await k.tick();
    const skipped = w.log().filter((l) => l.trigger === "claude-limit-reset");
    assert.deepEqual(skipped.map((l) => [l.outcome, l.why]), [["skipped", "the running-at-once limit was reached"]]);
    // The next reset, with a slot free, continues it with the playbook.
    w.slots.free = 5;
    w.logins[0] = { id: "work", name: "Work", state: "limited", since: w.now.t - MIN, until: w.now.t + MIN };
    await k.tick();
    w.turns.set(own.path, { failed: true, at: w.now.t, login: "work" });
    w.logins[0] = { id: "work", name: "Work", state: "ready" };
    w.now.t += 2 * MIN;
    await k.tick();
    const text = w.woken.at(-1)!.text;
    assert.match(text, /^\[schedule s1\] Scheduled run fired \(claude-limit-reset, automation merge-round\)\.\n(?:Late by .*\n)?Reason: Claude login Work is ready again\.\nYour last turn stopped at that Claude login's usage limit, which has now reset\. Continue where you left off\.\n<playbook /);
    assert.equal(load(text), "unchanged");
  });

  test("playbook_read's lookup: the session's own schedule, also after a revoke; an unknown session only by an approved schedule's delivered folder", async () => {
    const { w, k } = await approved();
    await fireAt(w, k, "2026-10-05T12:00:30Z");
    const own = w.store().schedules[0]!.session!;
    assert.equal((await k.bundleFor(own.id))?.dir, w.pbDir);
    // A brand-new session whose fire isn't recorded yet: by the delivered folder, exactly.
    assert.equal((await k.bundleFor("new-one", { id: "merge-round", dir: w.pbDir }))?.dir, w.pbDir);
    assert.equal(await k.bundleFor("new-one", { id: "merge-round", dir: "/elsewhere/merge-round" }), null);
    assert.equal((await k.revoke("s1")).ok, true);
    assert.equal((await k.bundleFor(own.id))?.dir, w.pbDir, "a run under way keeps its playbook");
    assert.equal(await k.bundleFor("stranger", { id: "merge-round", dir: w.pbDir }), null, "revoked: no stranger reads through it");
    assert.equal(await k.bundleFor("stranger"), null);
  });

  test("a row another device runs fires nothing here", async () => {
    const { w, k } = await approved();
    w.state.host = "h_another1";
    const [s] = await k.list();
    assert.deepEqual([s!.state, s!.reason], ["paused", OTHER_DEVICE]);
    await (async () => {
      w.now.t = Date.parse("2026-10-05T12:00:30Z");
      await k.tick();
    })();
    assert.equal(w.created.length + w.woken.length, 0);
  });

  test("an invalid automation file is shown with its exact error and never fires", async () => {
    const w = world({ automation: { ...AUTOMATION, session: "one-shot" } });
    await w.keeper().discover([w.root], async () => []);
    const [s] = await w.keeper().list();
    assert.deepEqual([s!.state, s!.reason], ["invalid", `"session" must be "long-running".`]);
  });
});
