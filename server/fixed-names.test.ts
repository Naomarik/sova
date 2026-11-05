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

  test("a chat started before Sova recorded its name reads its own automatic title, else the kind's word", async () => {
    const named = file(sessionsDir, [line({ type: "custom", customType: "sova-profile", id: "p1", parentId: null, data: { v: 1, profile: sova("release-thread") } }), userLine("huh")]);
    writeAutoTitle(named.id, "Release v0.9 of sova");
    await readsEverywhere(named.path, "Release v0.9 of sova");
    const renamed = file(sessionsDir, [line({ type: "custom", customType: "sova-profile", id: "p1", parentId: null, data: { v: 1, profile: sova("merge-thread") } }), userLine("huh")]);
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
