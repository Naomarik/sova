// Run: pnpm test -- server/fixed-names.test.ts
// The chats Sova names itself (shared/fixed-names.ts): the Overseer reads "Overseer", a project's overseer
// "Overseer · {project}" (following a project rename), and a merge thread, a merge reviewer, a release chat and a
// gathering session the name Sova gave each when it started. Whatever their first message, an automatic naming pass,
// a rename or a pi session name says, every server summary (the list, one summary, the monitor's titles, the share
// pages' and notifications' display title) hands out that name; a rename is refused. Earlier Overseer conversations
// keep what each was about apart from the name, and the monitor's saved history is relabelled when read.
// A throwaway PI_CODING_AGENT_DIR, org workspace and project root in the OS temp dir; no model is called.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import type { MonitorHistory, SessionSummary } from "../shared/protocol";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-fixed-names-")));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
const sessionsDir = join(agentDir, "sessions", "--tmp-fixed-names--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });

await import("./testing/in-process-chats"); // chats open in this process (the server hosts none)
const { buildApp } = await import("./app");
const { app } = buildApp({ extensionEntriesOf: async () => [] });
const index = await import("./sessions-index");
const { canonicalPath } = await import("./paths");
const { readSessionTitleRecords, setSessionTitle, writeAutoTitle } = await import("./session-titles");
const { setSovaChatName } = await import("./sova-chat-names");
const overseer = await import("./overseer");
const { writeOverseerState, readOverseerState } = await import("./overseer-store");
const { sessionsChanged } = await import("./list-generation");
const orgs = await import("./orgs");
await import("./org-sessions"); // the org layer's list fields (a baton's), as index.ts loads it
const baton = await import("./baton");
const po = await import("./project-overseer");
const { editProject } = await import("./projects/spaces");
const { settled } = await import("./workspace-git");
const { disposeAllChats } = await import("./chat-manager");
const { nameSession } = await import("./session-autotitle");
const { relabelFixed } = await import("./resource-monitor");
const { sessionName } = await import("./session-names");
const { stateRoot } = await import("./state-root");
const { projectKey } = await import("./merge-queue/store");
const { memoSovaChatNames } = await import("./sova-chat-names");

after(async () => {
  await disposeAllChats();
  for (const o of orgs.orgsInfo().orgs) await settled(o.dir);
});

const line = (o: unknown) => JSON.stringify(o);
let n = 0;
const newId = () => `01234567-89ab-7cde-8f01-${String(++n).padStart(12, "0")}`;
const userLine = (text: string) => line({ type: "message", id: `u${++n}`, parentId: null, timestamp: "2026-11-05T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text }], timestamp: 1 } });
/** A pi session name (pi's /name, session_info): never a fixed chat's name either. */
const piName = (name: string) => line({ type: "session_info", id: `n${++n}`, parentId: null, name });
const sova = (id: string) => ({ id, label: id, icon: "branch", source: "sova" });
const profileLine = (id: string) => line({ type: "custom", customType: "sova-profile", id: "p1", parentId: null, data: { v: 1, profile: sova(id) } });

/** A session file in `dir`, with the given lines after its header. */
function file(dir: string, lines: string[], id = newId()): { id: string; path: string } {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `2026-11-05T00-00-00-000Z_${id}.jsonl`);
  writeFileSync(path, `${[line({ type: "session", version: 3, id, timestamp: "2026-11-05T00:00:00.000Z", cwd: "/tmp" }), ...lines].join("\n")}\n`);
  sessionsChanged(); // as the file watcher says it: the next listing reads again
  return { id, path: canonicalPath(path) };
}
const say = (path: string, text: string) => {
  appendFileSync(path, `${userLine(text)}\n`);
  sessionsChanged();
};

const listed = async (path: string): Promise<SessionSummary> => {
  const row = (await index.listSessions()).find((s) => s.path === path);
  assert.ok(row, `listed: ${path}`);
  return row;
};
const rename = (path: string, title: string | null, source?: "overseer") =>
  app.request("/api/sessions/title", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path, title, ...(source ? { source } : {}) }) });

/** Every server summary of one file says `name`: the list's row, one summary, the cached and display titles. */
async function readsEverywhere(path: string, name: string): Promise<void> {
  assert.equal((await listed(path)).title, name, "the list's row");
  assert.equal((await index.getSessionSummary(path))?.title, name, "one summary (GET /api/sessions/summary, the Overseer's tools)");
  assert.equal(await index.displayTitleOf(path), name, "the display title (notifications, project costs)");
  assert.equal(index.monitorFixedOf(path, true)?.title, name, "the resource monitor's row and chart");
  assert.equal(index.cachedTitleOf(path), name, "the cached title (share pages)");
}

/** A rename (the user's and the Overseer's) is refused with `sentence`, and nothing is stored. */
async function renameRefused(path: string, id: string, sentence: string): Promise<void> {
  const before = readSessionTitleRecords()[id];
  for (const source of [undefined, "overseer"] as const) {
    const r = await rename(path, "huh renamed", source);
    assert.equal(r.status, 409);
    assert.deepEqual(await r.json(), { error: sentence });
  }
  assert.equal((await rename(path, null)).status, 409, "clearing is refused too");
  assert.deepEqual(readSessionTitleRecords()[id], before, "nothing was stored");
}

/** An automatic naming pass (Regenerate title, the button, Shorten long titles, the sweep) names nothing, and never
    calls a model. */
async function autoNamingSkips(path: string): Promise<void> {
  for (const mode of ["regenerate", "button", "shorten", "sweep"] as const) {
    const r = await nameSession(path, mode, {
      runtime: async () => {
        throw new Error("no model is called for a chat Sova names itself");
      },
      settings: () => ({ version: 1, enabled: true, intervalMinutes: 5, quietMinutes: 0, primary: { backend: "pi", model: "prov/t", effort: "off" }, fallback: null }) as never,
      summary: (p) => index.getSessionSummary(p),
      input: async () => ({ userMessages: ["huh"], summaryLine: "a summary" }) as never,
    });
    assert.equal(r.outcome, "skipped", `${mode} skipped`);
  }
}

describe("the Overseer", () => {
  test('its first message "huh" never names it: every summary reads "Overseer"', async () => {
    const cur = await overseer.ensureOverseer();
    say(cur.path, "huh");
    const row = await listed(cur.path);
    assert.equal(row.overseer, true);
    assert.equal(row.fixedName, "overseer");
    assert.equal(row.originalTitle, undefined);
    assert.equal(row.titleBy, undefined);
    await readsEverywhere(cur.path, "Overseer");
    assert.equal(index.monitorFixedOf(cur.path, true)?.overseer, "current", "the monitor's Open Session goes to the Overseer page");
  });

  test("a rename by the user or the Overseer is refused and changes nothing; an old stored title is ignored", async () => {
    const cur = await overseer.ensureOverseer();
    await renameRefused(cur.path, cur.id, "An overseer keeps its own name.");
    // A title stored before this rule (a rename that once went through) is never read.
    setSessionTitle(cur.id, "huh");
    await readsEverywhere(cur.path, "Overseer");
    setSessionTitle(cur.id, null);
    await autoNamingSkips(cur.path);
    await readsEverywhere(cur.path, "Overseer");
  });

  test("an alias never names it for the Overseer's tools", () => {
    assert.equal(sessionName({ title: "Overseer", fixedName: "overseer" }, "my alias"), "Overseer");
  });

  test("two earlier conversations, 'alpha' and 'beta', stay apart on History; each still reads \"Overseer\"", async () => {
    const cur = await overseer.ensureOverseer();
    const marker = line({ type: "custom", customType: "sova-overseer", id: "ov", parentId: null, data: { v: 1 } });
    // Beside the current one, where Sova writes the Overseer's files.
    const alpha = file(dirname(cur.path), [marker, userLine("alpha")]);
    const beta = file(dirname(cur.path), [marker, userLine("beta")]);
    // beta was named by Sova's namer once: its automatic title is what it was about.
    writeAutoTitle(beta.id, "Beta, named");
    writeOverseerState({ version: 1, current: cur.id, history: [beta.id, alpha.id] });
    const info = await overseer.overseerInfo();
    assert.deepEqual(
      info.history.map((h) => ({ id: h.id, title: h.title, about: h.about })),
      [
        { id: beta.id, title: "Overseer", about: "Beta, named" },
        { id: alpha.id, title: "Overseer", about: "alpha" },
      ],
    );
    await readsEverywhere(alpha.path, "Overseer");
    assert.equal(index.monitorFixedOf(alpha.path, true)?.overseer, "earlier");
    writeOverseerState({ version: 1, current: cur.id, history: [] });
    assert.equal(readOverseerState()?.history.length, 0);
  });

  test('the monitor\'s saved history, recorded as "huh", reads "Overseer" (and says it is the Overseer\'s)', async () => {
    const cur = await overseer.ensureOverseer();
    const other = file(sessionsDir, [userLine("an ordinary chat")]);
    const saved: MonitorHistory = {
      res: "30s",
      since: 0,
      points: [],
      groups: { [cur.path]: { label: "huh", sessionPath: cur.path }, [other.path]: { label: "an ordinary chat", sessionPath: other.path }, server: { label: "Backend" } },
    };
    const read = relabelFixed(saved, (p, fresh) => index.monitorFixedOf(p, fresh));
    assert.deepEqual(read.groups[cur.path], { label: "Overseer", sessionPath: cur.path, overseer: "current" });
    assert.deepEqual(read.groups[other.path], saved.groups[other.path], "an ordinary session keeps its recorded label");
    assert.deepEqual(read.groups.server, { label: "Backend" });
  });
});

describe("a project's overseer", async () => {
  const org = await orgs.createOrg({ name: "Gate", dir: join(root, "ws") });
  mkdirSync(join(root, "proj"));
  const project = await orgs.addProject(org.id, { name: "Portal", root: join(root, "proj") });

  test('reads "Overseer · {project}" past its first message, a rename attempt, a pi name and an old stored title', async () => {
    const made = await po.ensureProjectOverseer(project.id);
    say(made.path, "huh");
    appendFileSync(made.path, `${piName("a pi name")}\n`);
    sessionsChanged();
    await readsEverywhere(made.path, "Overseer · Portal");
    assert.equal((await listed(made.path)).fixedName, "project-overseer");
    await renameRefused(made.path, made.id, "An overseer keeps its own name.");
    await autoNamingSkips(made.path);
    setSessionTitle(made.id, "huh");
    await readsEverywhere(made.path, "Overseer · Portal");
    setSessionTitle(made.id, null);
    assert.equal(index.monitorFixedOf(made.path, true)?.overseer, undefined, "its own page, not the Overseer's");
  });

  test("follows a project rename", async () => {
    const made = await po.ensureProjectOverseer(project.id);
    await editProject(project.id, { name: "Gateway" });
    await readsEverywhere(made.path, "Overseer · Gateway");
    await editProject(project.id, { name: "Portal" });
  });

  test("its History rows keep what each earlier conversation was about", async () => {
    const before = await po.ensureProjectOverseer(project.id);
    const info = await po.clearProjectOverseer(project.id);
    const row = info.history.find((h) => h.id === before.id);
    assert.equal(row?.title, "Overseer · Portal");
    assert.equal(row?.about, "huh");
  });
});

describe("the chats Sova starts with a name", () => {
  const cases = [
    { kind: "merge-thread", profile: "merge-thread", name: "Merge thread · sova · 2026-11-05", refusal: "The merge queue's chats keep the names Sova gives them." },
    { kind: "merge-reviewer", profile: "merge-reviewer", name: "Review · feat/x · abc1234", refusal: "The merge queue's chats keep the names Sova gives them." },
    { kind: "release", profile: "release-thread", name: "Release v1.2.0 of sova", refusal: "A release chat keeps the name Sova gives it." },
  ] as const;
  for (const c of cases) {
    test(`a ${c.kind} keeps the name Sova gave it past its first message, a naming pass and a rename attempt`, async () => {
      const s = file(sessionsDir, [line({ type: "custom", customType: "sova-profile", id: "p1", parentId: null, data: { v: 1, profile: sova(c.profile) } }), userLine("huh"), piName("a pi name")]);
      // What Sova's start does (createChat): the name goes to Sova's own record, never the title store.
      setSovaChatName(s.id, c.kind, c.name);
      await readsEverywhere(s.path, c.name);
      assert.equal((await listed(s.path)).fixedName, c.kind);
      await autoNamingSkips(s.path);
      await renameRefused(s.path, s.id, c.refusal);
      await readsEverywhere(s.path, c.name);
    });
  }

  test("with no record of Sova's anywhere: a merge chat's own automatic title, else the kind's word; never a release chat's auto title", async () => {
    const thread = file(sessionsDir, [profileLine("merge-thread"), userLine("huh")]);
    writeAutoTitle(thread.id, "Merge thread · gone · 2026-01-01");
    await readsEverywhere(thread.path, "Merge thread · gone · 2026-01-01");
    const release = file(sessionsDir, [profileLine("release-thread"), userLine("huh")]);
    writeAutoTitle(release.id, "Release v0.9 of sova");
    await readsEverywhere(release.path, "Release chat");
    const renamed = file(sessionsDir, [profileLine("merge-thread"), userLine("huh")]);
    setSessionTitle(renamed.id, "a user's rename from before");
    await readsEverywhere(renamed.path, "Merge thread");
  });

  test("a later release retitle (Sova's own) is the name; a user profile of the same id is an ordinary chat", async () => {
    const s = file(sessionsDir, [line({ type: "custom", customType: "sova-profile", id: "p1", parentId: null, data: { v: 1, profile: sova("release-thread") } }), userLine("huh")]);
    setSovaChatName(s.id, "release", "Release (version not picked yet) of sova");
    setSovaChatName(s.id, "release", "Release v2.0.0 of sova");
    await readsEverywhere(s.path, "Release v2.0.0 of sova");
    const plain = file(sessionsDir, [line({ type: "custom", customType: "sova-profile", id: "p1", parentId: null, data: { v: 1, profile: { ...sova("release-thread"), source: "user" } } }), userLine("huh")]);
    assert.equal((await listed(plain.path)).title, "huh");
    assert.equal((await listed(plain.path)).fixedName, undefined);
  });
});

describe("a chat Sova started before it recorded its name: rebuilt from Sova's own records", () => {
  const queueDir = () => join(stateRoot(), "merge-queue");
  const writeJson = (path: string, v: unknown) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(v));
  };

  test("a merge thread renamed by the user goes back to the name Sova gave it (and it is recorded once)", async () => {
    const s = file(sessionsDir, [profileLine("merge-thread"), userLine("huh")]);
    writeJson(join(queueDir(), "threads.json"), { version: 1, threads: { "/w/p": { sessionId: s.id, path: s.path, startedAt: Date.parse("2026-11-02T10:00:00.000Z"), playbook: "" } } });
    writeAutoTitle(s.id, "Merge thread · p · 2026-11-02");
    setSessionTitle(s.id, "x", "user");
    await readsEverywhere(s.path, "Merge thread · p · 2026-11-02");
    assert.deepEqual(memoSovaChatNames()[s.id], { kind: "merge-thread", name: "Merge thread · p · 2026-11-02" }, "backfilled");
  });

  test("an earlier merge thread (the record's history) and a reviewer, by its run's commit or its own first message", async () => {
    const old = file(sessionsDir, [profileLine("merge-thread"), userLine("huh")]);
    const rev = file(sessionsDir, [profileLine("merge-reviewer"), userLine("huh")]);
    const rev2 = file(sessionsDir, [profileLine("merge-reviewer"), userLine("Review one change before it lands.\n\n- Commit under review: 0123456789abcdef (branch feat/y merged onto the target at aaa).")]);
    writeJson(join(queueDir(), "threads.json"), { version: 1, threads: { "/w/q": { history: [{ sessionId: old.id, path: old.path, startedAt: Date.parse("2026-10-30T23:59:00.000Z"), endedAt: 1, why: "replaced" }] } } });
    writeJson(join(queueDir(), "chats.json"), {
      version: 1,
      projects: { "/w/q": { reviewers: [{ session: rev.id, path: rev.path, run: "mr_1", branch: "feat/x", attempt: 2, startedAt: "" }, { session: rev2.id, path: rev2.path, run: "mr_gone", branch: "feat/y", attempt: 1, startedAt: "" }] } },
    });
    writeJson(join(queueDir(), projectKey("/w/q"), "runs", "mr_1", "run.json"), { id: "mr_1", commit: "abcdef0123456789" });
    for (const id of [old.id, rev.id, rev2.id]) setSessionTitle(id, "renamed", "user");
    await readsEverywhere(old.path, "Merge thread · q · 2026-10-30");
    await readsEverywhere(rev.path, "Review · feat/x · abcdef0 · attempt 2");
    await readsEverywhere(rev2.path, "Review · feat/y · 0123456");
  });

  test("a release chat the namer renamed reads its Sova name (its release's tag as now); a withdrawal's own chat its own", async () => {
    const s = file(sessionsDir, [profileLine("release-thread"), userLine("huh")]);
    const dir = join(stateRoot(), "project-services", "release", projectKey("/w/proj"));
    writeJson(join(dir, "rl_aaa.json"), { id: "rl_aaa", project: "/w/proj", tag: "v1.2.0", thread: { session: s.id } });
    writeAutoTitle(s.id, "Fix the flaky tests", { redo: true }); // Name sessions, before release chats were skipped
    await readsEverywhere(s.path, "Release v1.2.0 of proj");
    const w = file(sessionsDir, [profileLine("release-thread"), userLine("huh")]); // created 2026-11-05
    writeJson(join(dir, "rl_bbb.json"), { id: "rl_bbb", project: "/w/proj", tag: "v1.1.0", withdrawn: { at: "2026-11-04T00:00:00.000Z" }, thread: { session: w.id } });
    await readsEverywhere(w.path, "Withdraw v1.1.0");
  });
});

describe("a gathering session", async () => {
  const org = await orgs.createOrg({ name: "Gatherers", dir: join(root, "ws-g") });
  mkdirSync(join(root, "proj-g"));
  const project = await orgs.addProject(org.id, { name: "Intake", root: join(root, "proj-g") });
  const tony = await orgs.addPerson(org.id, { name: "Tony Reyes", role: "IT" });

  test("keeps its public title past its first message, a naming pass and a rename attempt", async () => {
    const g = await baton.createBaton({ orgId: org.id, projectId: project.id, to: tony.id, publicTitle: "Supplier bank details", goal: "g" }, { mintLink: false });
    const path = canonicalPath(g.path);
    say(path, "huh");
    await readsEverywhere(path, "Supplier bank details");
    assert.equal((await listed(path)).fixedName, "gathering");
    await autoNamingSkips(path);
    await renameRefused(path, g.sessionId, "A gathering session keeps its public title as its name.");
    await readsEverywhere(path, "Supplier bank details");
  });
});
