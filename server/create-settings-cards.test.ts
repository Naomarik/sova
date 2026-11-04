import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { Hono } from "hono";
import type { MergeQueueSettings, MergeSettingsChange } from "../shared/merge-queue-settings";
import { linkPiConfigExtensions } from "./testing/agent-dir";

// A Create chat's settings cards (§chat.create-mode/settings-cards): it prepares, even what narrows; only the
// person's click on Sova's own page applies, whichever kind the card is; a merge queue card is a Save with its
// waits; no credential passes; a link into Sova's own folder is never written.

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-create-cards-")));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
linkPiConfigExtensions(agentDir);

await import("./testing/in-process-chats");
const po = await import("./project-overseer");
const settings = await import("./project-settings");
const { registerProjectSettingsRoutes } = await import("./project-settings-routes");
const { registerSovaSettingsRoutes } = await import("./sova-settings-routes");
const { registerProjectIn } = await import("./projects/spaces");
const { readPoSettings, projectOverseerPaths } = await import("./project-overseer-store");
const { OVERSEER_SENDER_HEADER, senderSecret } = await import("./overseer-sender");
const { disposeAllChats } = await import("./chat-manager");
const { NO_QUEUE, runCreateSettingsTool } = await import("./create-settings-run");
const { createSettingsTool } = await import("./create-settings-tool");
const sova = await import("./sova-settings");
const { SOVA_SETTING_IDS, SOVA_SETTINGS } = await import("../shared/sova-settings-reference");
const { settingsDocs } = await import("./sync/docs");
const { setSettingsSpreadProbe } = await import("./sync/spreads");
const { queueCardPort, setQueueCardPort } = await import("./merge-queue/card-port");
const { readModelPolicy } = await import("./model-policy");
const { readWebSettings } = await import("./web-settings");
const { settled } = await import("./workspace-git");

sova.setSovaSettingsDeps({ sources: { piModels: () => [], claudeModels: () => [], policy: () => readModelPolicy() } as never });

after(async () => {
  setQueueCardPort(null);
  await disposeAllChats();
  await settled(join(root, "ws"));
});

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

async function gitProject(name: string) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "README.md"), "hello\n");
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "add", "-A");
  sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
  const { project } = await registerProjectIn("standalone", dir, { name, origin: "folder" });
  await po.ensureProjectOverseer(project.id);
  return { dir, project };
}

const chat = (projectId: string | null, sessionId = "chat-1") => ({ sessionId, projectId, noProject: projectId ? null : "This folder isn't a project yet." });
const app = () => {
  const a = new Hono();
  registerProjectSettingsRoutes(a);
  registerSovaSettingsRoutes(a);
  return a;
};
// A call as the page's: over a socket of the main listener, on a server with no sign-in (no cookie to show).
process.env.SOVA_AUTH = "off";
const post = (a: Hono, path: string, body: unknown, headers: Record<string, string> = {}) => a.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }, { incoming: {} });
const callers: Record<string, string>[] = [{ [OVERSEER_SENDER_HEADER]: senderSecret() }, { "x-sova-token": "x" }, { "x-sova-caller": "k" }];

describe("a project's card", async () => {
  const { project } = await gitProject("narrow");
  const pid = project.id;

  test("what narrows waits for Apply too: nothing applies until the page does, and the row names the chat", async () => {
    const before = readPoSettings(projectOverseerPaths(pid)).caps.promptsPerTurn;
    const out = await runCreateSettingsTool(chat(pid), { op: "propose", why: "One prompt a message.", edits: [{ setting: "overseer", patch: { caps: { promptsPerTurn: 1 } } }] });
    const d = out.details as { card: { id: string; fingerprint: string; state: string; by: { kind: string } }; appliedNow: unknown[] };
    assert.equal(d.card.state, "waiting");
    assert.deepEqual(d.appliedNow, [], "the project overseer would apply this at once; Create never does");
    assert.equal(d.card.by.kind, "create");
    assert.equal(readPoSettings(projectOverseerPaths(pid)).caps.promptsPerTurn, before, "not applied");
    assert.match(out.content[0]!.text, /nothing in it applies until they click/);

    const a = app();
    for (const headers of callers) assert.equal((await post(a, `/api/projects/${pid}/settings/apply`, { card: d.card.id, fingerprint: d.card.fingerprint }, headers)).status, 403, JSON.stringify(headers));
    assert.equal(readPoSettings(projectOverseerPaths(pid)).caps.promptsPerTurn, before, "a token-only Apply changes nothing");

    const r = await post(a, `/api/projects/${pid}/settings/apply`, { card: d.card.id, fingerprint: d.card.fingerprint });
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal(readPoSettings(projectOverseerPaths(pid)).caps.promptsPerTurn, 1);
    const row = settings.readHistory(pid).at(-1)!;
    assert.deepEqual([row.by.kind, row.by.via, row.by.chat], ["create", "card", "chat-1"]);
  });

  test("an applied rename keeps its before", async () => {
    const out = await runCreateSettingsTool(chat(pid), { op: "propose", why: "A better name.", edits: [{ setting: "project", name: "Corner Shop" }] });
    const c = (out.details as { card: { id: string; fingerprint: string } }).card;
    const r = await post(app(), `/api/projects/${pid}/settings/apply`, { card: c.id, fingerprint: c.fingerprint });
    assert.equal(r.status, 200, await r.clone().text());
    const row = (await settings.settingsCard(pid, c.id))!.kept.find((k) => k.field === "project.name")!;
    assert.deepEqual([row.fromText, row.toText], ["narrow", "Corner Shop"]);
  });

  test("get tells a Create chat when its project has no queue, and only then", async () => {
    const port = (noQueue: boolean | Error) => ({ settings: async () => null, noQueue: async () => { if (noQueue instanceof Error) throw noQueue; return noQueue; }, save: async () => ({ state: "waiting" }), models: async () => {}, modelDenial: async () => null }) as never;
    const said = async () => (await runCreateSettingsTool(chat(pid), { op: "get" })).content[0]!.text;
    const was = queueCardPort();
    setQueueCardPort(port(true));
    assert.ok((await said()).includes(NO_QUEUE));
    setQueueCardPort(port(false));
    assert.ok(!(await said()).includes(NO_QUEUE), "a queue, or one it can't vouch for");
    setQueueCardPort(port(new Error("down")));
    assert.ok(!(await said()).includes(NO_QUEUE), "a failing read says nothing");
    setQueueCardPort(null);
    assert.ok(!(await said()).includes(NO_QUEUE), "no queue service to ask");
    setQueueCardPort(port(true));
    assert.ok(!(await runCreateSettingsTool(chat(null), { op: "get" })).content[0]!.text.includes(NO_QUEUE), "a folder that isn't a project");
    setQueueCardPort(was);
  });

  test("no queue is said only when it's known: queues down or an unreadable setup say nothing", async () => {
    const { noQueueOf } = await import("./merge-queue/settings-routes");
    const notSetUp = async () => false;
    assert.equal(await noQueueOf({ unserved: "/p" }, notSetUp), true);
    assert.equal(await noQueueOf(null, notSetUp), false, "no queues running");
    assert.equal(await noQueueOf({ settings: async () => ({}) }, notSetUp), false, "a served queue");
    assert.equal(await noQueueOf({ unserved: "/p" }, async () => true), false, "set up, served read failed");
    assert.equal(await noQueueOf({ unserved: "/p" }, async () => { throw new Error("git"); }), false, "a setup it can't read");
  });

  test("a chat withdraws only what it prepared", async () => {
    const out = await runCreateSettingsTool(chat(pid), { op: "propose", why: "Rename.", edits: [{ setting: "project", name: "Other" }] });
    const id = (out.details as { card: { id: string } }).card.id;
    await assert.rejects(runCreateSettingsTool(chat(pid, "chat-2"), { op: "withdraw", card: id }), /isn't this chat's/);
    await runCreateSettingsTool(chat(pid), { op: "withdraw", card: id });
  });

  test("a credential in a project's file is refused, and nothing is prepared", async () => {
    const waiting = (await settings.settingsInfo(pid)).cards.length;
    await assert.rejects(runCreateSettingsTool(chat(pid), { op: "propose", why: "Add it.", edits: [{ setting: "playbook", id: "x", text: "---\ntitle: x\n---\nUse sk-abcdefghijklmnopqrstuvwx to call it." }] }), /Create doesn't handle sign-ins or keys/);
    assert.equal((await settings.settingsInfo(pid)).cards.length, waiting);
  });

  test("a folder that isn't a project gets no project card, and says so", async () => {
    await assert.rejects(runCreateSettingsTool(chat(null), { op: "propose", why: "x", edits: [{ setting: "project", name: "n" }] }), /isn't a project yet/);
  });
});

describe("a merge queue card", async () => {
  const { project } = await gitProject("queue");
  const pid = project.id;
  let pending: MergeQueueSettings["pendingSave"] | undefined;
  let checking = false;
  let dirty = false;
  const saved: MergeSettingsChange[] = [];
  const values = { push: true, review: false, timeoutSec: 600 };
  const now = (): MergeQueueSettings =>
    ({
      landing: { target: "main", push: values.push, names: { setUp: false, count: 0 } },
      review: { on: values.review, canTurnOn: false, files: [], model: { picked: null, effective: { model: "x/y" } } },
      thread: { model: { picked: null, effective: { model: "x/y" } }, playbooks: [] },
      checks: { mode: "declared", list: [{ id: "unit", label: "unit", timeoutSec: values.timeoutSec, rerun: false, optional: false }] },
      ...(pending ? { pendingSave: pending } : {}),
    }) as unknown as MergeQueueSettings;
  const save = (c: MergeSettingsChange) => {
    if (c.push !== undefined) values.push = c.push;
    if (c.checks?.unit?.timeoutSec !== undefined) values.timeoutSec = c.checks.unit.timeoutSec;
  };
  setQueueCardPort({
    settings: async () => now(),
    async save(_id, c) {
      if (dirty) throw Object.assign(new Error("Commit or discard the edit in the project folder first."), { code: "dirty" });
      if (checking) {
        pending = { at: "now", changes: c };
        return { state: "waiting" };
      }
      save(c);
      saved.push(c);
      return { state: "saved", commit: "abc", pushed: false };
    },
    models: async () => {},
    modelDenial: async () => null,
  });
  const propose = async (changes: unknown) => (await runCreateSettingsTool(chat(pid), { op: "propose", why: "Faster.", edits: [{ setting: "merge-queue", changes }] })).details as { card: { id: string; fingerprint: string; kind: string; saveWaits?: boolean } };
  const apply = (c: { id: string; fingerprint: string }, headers = {}) => post(app(), `/api/projects/${pid}/settings/apply`, { card: c.id, fingerprint: c.fingerprint }, headers);
  const card = async (id: string) => settings.settingsCard(pid, id);

  test("the project overseer is still refused by name", async () => {
    await assert.rejects(settings.proposeSettings(pid, { why: "x", edits: [{ setting: "merge-queue", changes: { push: false } }] }, { attended: true, by: { kind: "project-overseer", via: "tool" } }), /aren't proposed here/);
  });

  test("Apply is a Save: its commit, and only from the page", async () => {
    const { card: c } = await propose({ push: false });
    assert.equal(c.kind, "queue");
    assert.equal((c as unknown as { place: string }).place, ".sova/project.json on main", "the card says where it lands");
    assert.equal(saved.length, 0, "a propose saves nothing");
    for (const headers of callers) assert.equal((await apply(c, headers)).status, 403);
    assert.equal(saved.length, 0);
    const r = await apply(c);
    assert.equal(r.status, 200, await r.clone().text());
    assert.deepEqual(saved.at(-1), { push: false });
    assert.equal((await card(c.id))!.state, "applied");
    assert.equal(settings.readHistory(pid).at(-1)!.by.kind, "create");
  });

  test("while a branch checks, it waits as Save does, then settles when the save is made", async () => {
    checking = true;
    const { card: c } = await propose({ checks: { unit: { timeoutSec: 900 } } });
    const r = await apply(c);
    assert.equal(r.status, 200);
    const waiting = await card(c.id);
    assert.deepEqual([waiting!.state, waiting!.saveWaits], ["waiting", true], "it hasn't happened yet: never reads Applied");
    assert.equal((await apply(c)).status, 409, "the second press doesn't save twice");
    await assert.rejects(runCreateSettingsTool(chat(pid), { op: "withdraw", card: c.id }), /Cancel Save/);
    // The run ends; the queue makes the save.
    checking = false;
    save(pending!.changes);
    pending = undefined;
    assert.equal((await card(c.id))!.state, "applied");
  });

  test("a save cancelled anywhere ends the card Dismissed, not Applied", async () => {
    checking = true;
    const { card: c } = await propose({ checks: { unit: { timeoutSec: 1200 } } });
    await apply(c);
    pending = undefined; // Cancel Save, on the card or on Settings → Merge Queue.
    checking = false;
    assert.equal((await card(c.id))!.state, "dismissed");
    assert.equal(values.timeoutSec, 900);
  });

  test("a save that failed when its turn came says why, and keeps Cancel Save", async () => {
    checking = true;
    const { card: c } = await propose({ checks: { unit: { timeoutSec: 1500 } } });
    await apply(c);
    pending = { ...pending!, failed: "the target moved" };
    const v = await card(c.id);
    assert.deepEqual([v!.state, v!.saveWaits, v!.saveFailed], ["waiting", true, "the target moved"]);
    pending = undefined;
    checking = false;
    await card(c.id);
  });

  test("an uncommitted edit refuses it in Save's words, and the card still waits", async () => {
    dirty = true;
    const { card: c } = await propose({ push: true });
    const r = await apply(c);
    assert.equal(r.status, 409);
    assert.match(((await r.json()) as { error: string }).error, /Commit or discard the edit/);
    assert.equal((await card(c.id))!.state, "waiting");
    dirty = false;
    await settings.withdrawCard(pid, c.id, { operator: true });
  });

  test("what goes by Land is refused, and a queue change goes alone", async () => {
    await assert.rejects(propose({ land: "github-pr" }), /go by Land/);
    await assert.rejects(propose({ target: "dev" }), /can't be changed here/);
    await assert.rejects(runCreateSettingsTool(chat(pid), { op: "propose", why: "x", edits: [{ setting: "merge-queue", changes: { push: true } }, { setting: "project", name: "n" }] }), /card of its own/);
  });

  test("first setup stays the person's own", async () => {
    setQueueCardPort({ settings: async () => null, save: async () => ({ state: "waiting" }), models: async () => {}, modelDenial: async () => null });
    await assert.rejects(runCreateSettingsTool(chat(pid), { op: "propose", why: "x", edits: [{ setting: "merge-queue", changes: { push: false } }] }), /Merge Queue tab/);
  });
});

describe("a Sova-wide card", () => {
  const propose = async (id: string, value: unknown, sessionId = "chat-1") => (await runCreateSettingsTool(chat(null, sessionId), { op: "propose", why: "Asked for it.", edits: [{ setting: "sova", id, value }] })).details as { projectId: null; card: { id: string; fingerprint: string; kind: string; place: string; grants: unknown[]; kept: { label: string }[] } };
  const apply = (c: { id: string; fingerprint: string }, headers = {}) => post(app(), "/api/settings/apply", { card: c.id, fingerprint: c.fingerprint }, headers);

  test("every setting has a reader and a writer, and what spreads is a document sync carries", () => {
    const docs = new Set(settingsDocs(agentDir, join(agentDir, "sova")).map((d) => d.key));
    for (const id of SOVA_SETTING_IDS) {
      assert.ok(sova.SOVA_ADAPTERS[id], id);
      const key = SOVA_SETTINGS[id].sync;
      if (key) assert.ok(docs.has(key), `${id}: ${key}`);
    }
  });

  test("Apply is the person's own page: a token-only Apply is refused and nothing is written", async () => {
    const was = readWebSettings().alignment.review;
    const d = await propose("alignment.review", !was);
    assert.equal(d.projectId, null);
    assert.equal(d.card.kind, "sova");
    assert.match(d.card.id, /^sw_\d+$/);
    for (const headers of callers) assert.equal((await apply(d.card, headers)).status, 403, JSON.stringify(headers));
    assert.equal(readWebSettings().alignment.review, was);
    assert.equal((await post(app(), "/api/settings/apply", { card: d.card.id, fingerprint: "0".repeat(32) })).status, 409, "a stale fingerprint");
    const r = await apply(d.card);
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal(readWebSettings().alignment.review, !was);
    assert.equal((await apply(d.card)).status, 409, "once");
    const row = JSON.parse(readFileSync(sova.sovaHistoryFile(), "utf8").trim().split("\n").at(-1)!);
    assert.deepEqual([row.field, row.by.kind, row.by.chat], ["alignment.review", "create", "chat-1"]);
  });

  test("one with no screen takes the same path, keeping the file's other keys", async () => {
    const file = join(agentDir, "sova", "settings.json");
    mkdirSync(join(agentDir, "sova"), { recursive: true });
    writeFileSync(file, JSON.stringify({ version: 1, keepMe: "yes" }));
    const d = await propose("workers.priority", 5);
    assert.equal((await apply(d.card)).status, 200);
    const now = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual([now.workerNice, now.keepMe], [5, "yes"]);
    await assert.rejects(propose("workers.priority", 99), /whole number/);
  });

  test("a file that changed since is refused", async () => {
    const d = await propose("workers.priority", 7);
    const file = join(agentDir, "sova", "settings.json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), workerNice: 3 }));
    const r = await apply(d.card);
    assert.equal(r.status, 409);
    assert.match(((await r.json()) as { error: string }).error, /changed since/);
    sova.withdrawSovaCard(d.card.id);
  });

  test("a parser's refusal writes nothing, and a grant says so", async () => {
    await assert.rejects(propose("models.policy", { disabledModels: "nope" }), /Models turned off/);
    const off = { disabledProviders: ["zai"], disabledModels: [], subagentDisabledProviders: [], subagentDisabledModels: [] };
    const d = await propose("models.policy", off);
    assert.equal(d.card.grants.length, 0, "turning a model off allows nothing new");
    assert.equal((await apply(d.card)).status, 200);
    const back = await propose("models.policy", { ...off, disabledProviders: [] });
    assert.deepEqual((back.card.grants as { what: string }[]).map((g) => g.what), ["Models turned back on"], "the card adds its own full stop");
    sova.withdrawSovaCard(back.card.id);
  });

  test("rows read as words, never raw JSON", async () => {
    const d = await propose("models.limits", { limits: { zai: 3 } });
    const row = (d.card.kept as { label: string; fromText: string; toText: string }[]);
    assert.deepEqual(row.map((k) => [k.label, k.fromText, k.toText]), [["Requests at once: zai", "not set", "3 at once"]]);
    sova.withdrawSovaCard(d.card.id);
    writeFileSync(join(agentDir, "topic-outline.json"), JSON.stringify({ summarizers: [{ backend: "pi", model: "a/b", timeoutMs: 120000 }, { backend: "claude-code", model: "c", timeoutMs: 45000, maxBudgetUsd: 0.05 }] }));
    const lim = await propose("summaries.limits", [{ timeoutMs: 180000 }, { timeoutMs: 90000, maxBudgetUsd: 0.1 }]);
    assert.deepEqual((lim.card.kept as { label: string; fromText: string; toText: string }[]).map((k) => [k.label.split(": ")[1], k.fromText, k.toText]), [
      ["first summarizer's timeout", "2 min", "3 min"],
      ["second summarizer's timeout", "45 s", "90 s"],
      ["second summarizer's spending limit", "$0.05", "$0.1"],
    ]);
    sova.withdrawSovaCard(lim.card.id);
    rmSync(join(agentDir, "topic-outline.json"));
    const off = await propose("models.policy", { ...readModelPolicy(), subagentDisabledModels: ["a/one", "b/two"] });
    assert.deepEqual((off.card.kept as { label: string; fromText: string; toText: string }[]).map((k) => [k.fromText, k.toText]), [["none", "a/one, b/two"]]);
    sova.withdrawSovaCard(off.card.id);
  });

  test("a change deep in a long list reads as that field, not as the list", async () => {
    const list = (model: string) => [...Array(30).keys()].map((n) => ({ name: `target-${n}`, kind: "docker", docker: { container: n === 7 ? model : `c${n}` } }));
    writeFileSync(join(agentDir, "targets.json"), JSON.stringify({ version: 1, targets: list("old") }));
    const d = await propose("remote.targets", list("new"));
    assert.deepEqual(d.card.kept.map((k) => k.label), ["Remote targets: [target-7].docker.container"]);
    sova.withdrawSovaCard(d.card.id);
    rmSync(join(agentDir, "targets.json"));
  });

  test("a key never goes on a card; a variable's name isn't a key", async () => {
    const provider = (apiKey: string) => ({ providers: { mine: { baseUrl: "http://localhost:1", api: "openai", apiKey, models: [] } } });
    await assert.rejects(propose("models.providers", provider("abc123literalkey")), /Create doesn't handle sign-ins or keys/);
    await assert.rejects(propose("models.providers", provider("!cat ~/.key")), /Create doesn't handle sign-ins or keys/);
    await assert.rejects(propose("decisions", { jev: { key: "abcdef" } }), /Settings → Decisions/);
    for (const reference of ["$MY_PROVIDER_KEY", "${my_key}", "LOCAL"]) sova.withdrawSovaCard((await propose("models.providers", provider(reference))).card.id);
  });

  test("a link into Sova's own folder is never written, and the way that fits is named", async () => {
    const outside = join(root, "sova-checkout", "pi-config");
    mkdirSync(outside, { recursive: true });
    const target = join(outside, "models.json");
    writeFileSync(target, "{}\n");
    const link = join(agentDir, "models.json");
    symlinkSync(target, link);
    await assert.rejects(propose("models.providers", { providers: { mine: {} } }), /link into Sova's own folder.*pi\.registerProvider/s);
    assert.equal(readFileSync(target, "utf8"), "{}\n");
    rmSync(link);
    // A link that appears after the card was made refuses Apply too.
    const d = await propose("models.providers", { providers: { mine: {} } });
    symlinkSync(target, link);
    assert.equal((await apply(d.card)).status, 409);
    assert.equal(readFileSync(target, "utf8"), "{}\n");
    rmSync(link);
    sova.withdrawSovaCard(d.card.id);
  });

  test("the card says when a change spreads, only when a peer would receive it", async () => {
    const d = await propose("workers.priority", 2);
    assert.equal(d.card.place, "Sova-wide");
    setSettingsSpreadProbe(() => true);
    const spreading = sova.sovaCardsInfo().cards.find((c) => c.id === d.card.id)!;
    assert.equal(spreading.place, "Sova-wide, and your other computers by sync");
    const stays = await propose("remote.targets", []);
    assert.equal(sova.sovaCardsInfo().cards.find((c) => c.id === stays.card?.id)?.place ?? "Sova-wide", "Sova-wide");
    setSettingsSpreadProbe(null);
    sova.withdrawSovaCard(d.card.id);
    if (stays.card) sova.withdrawSovaCard(stays.card.id);
  });

  test("Sova-wide cards have a limit of 10 of their own, and don't go with a project's", async () => {
    const { cards } = sova.sovaCardsInfo();
    for (const c of cards) sova.withdrawSovaCard(c.id);
    const made = [];
    for (let n = 0; n < sova.MAX_SOVA_WAITING; n++) made.push(await propose("workers.priority", 8 + (n % 5) + (n > 4 ? 5 : 0)));
    await assert.rejects(propose("workers.priority", 1), /already wait/);
    for (const m of made) sova.withdrawSovaCard(m.card.id);
    await assert.rejects(runCreateSettingsTool(chat("p"), { op: "propose", why: "x", edits: [{ setting: "sova", id: "workers.priority", value: 1 }, { setting: "project", name: "n" }] }), /card of its own/);
  });
});

describe("the added cards", async () => {
  const { project } = await gitProject("login");
  const pid = project.id;
  const sw = async (id: string, value: unknown) => (await runCreateSettingsTool(chat(null), { op: "propose", why: "Asked.", edits: [{ setting: "sova", id, value }] })).details as { card: { id: string; fingerprint: string } };
  const apply = (c: { id: string; fingerprint: string }) => post(app(), "/api/settings/apply", { card: c.id, fingerprint: c.fingerprint });

  test("a project's Claude login names an existing one, by card, and the overseer can't", async () => {
    const out = await runCreateSettingsTool(chat(pid), { op: "propose", why: "Bill this login.", edits: [{ setting: "claude-login", login: "default" }] });
    const c = (out.details as { card: { id: string; fingerprint: string } }).card;
    const { projectLoginView } = await import("./projects/claude-login");
    assert.equal(projectLoginView(pid).setting, "none", "nothing until Apply");
    const r = await post(app(), `/api/projects/${pid}/settings/apply`, { card: c.id, fingerprint: c.fingerprint });
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal(projectLoginView(pid).setting, "default");
    assert.deepEqual([settings.readHistory(pid).at(-1)!.field, settings.readHistory(pid).at(-1)!.by.kind], ["claude-login", "create"]);
    await assert.rejects(runCreateSettingsTool(chat(pid), { op: "propose", why: "x", edits: [{ setting: "claude-login", login: "nobody@else" }] }), /isn't on this computer/);
    await assert.rejects(settings.proposeSettings(pid, { why: "x", edits: [{ setting: "claude-login", login: "default" }] }, { attended: true, by: { kind: "project-overseer", via: "tool" } }), /Unknown setting/);
  });

  test("the default mode is normal or Delegate, and Create can never be saved", async () => {
    await assert.rejects(sw("modes.default", { mode: "create", strict: false, minorModes: [] }), /no default holds it/);
    const d = await sw("modes.default", { mode: "delegate", strict: true, minorModes: ["align"] });
    assert.equal((await apply(d.card)).status, 200);
    const { readMode } = await import("./mode-state");
    assert.deepEqual([readMode().mode, readMode().minorModes], ["delegate", ["align"]]);
  });

  test("favourites go as a whole list, starring and unstarring through the palette's store", async () => {
    await assert.rejects(sw("models.favorites", ["no-slash"]), /provider\/id/);
    assert.equal((await apply((await sw("models.favorites", ["zai/glm-5.3", "x/y"])).card)).status, 200);
    assert.equal((await apply((await sw("models.favorites", ["x/y"])).card)).status, 200);
    assert.deepEqual(sova.SOVA_ADAPTERS["models.favorites"].read(), ["x/y"]);
  });

  test("notifications and outreach are checked by their own parsers", async () => {
    const before = sova.SOVA_ADAPTERS.notifications.read() as Record<string, unknown>;
    await assert.rejects(sw("notifications", { ...before, enabled: "yes" }), /enabled must be true or false/);
    assert.equal((await apply((await sw("notifications", { ...before, enabled: !before.enabled })).card)).status, 200);
    assert.equal((sova.SOVA_ADAPTERS.notifications.read() as { enabled: boolean }).enabled, !before.enabled);
    await assert.rejects(sw("outreach", { nonsense: 1 }), /can't go on a card/);
    await assert.rejects(sw("outreach", { paused: "no" }), /paused must be true or false/);
    const c = await sw("outreach", { ...(sova.SOVA_ADAPTERS.outreach.read() as object), paused: true });
    sova.withdrawSovaCard(c.card.id);
  });

  test("a plain value that reads like a key is refused, and the refusal says where the person can change it", async () => {
    await assert.rejects(sw("models.providers", { providers: { mine: { token: "plain-label" } } }), /If this isn't a key.*~a\/models\.json/);
    await assert.rejects(sw("alignment.review", { token: "plain-label" }), /If this isn't a key.*Settings → Alignment/);
    await assert.rejects(runCreateSettingsTool(chat(pid), { op: "propose", why: "x", edits: [{ setting: "services", file: { token: "plain-label" } }] }), /If this isn't a key.*Branches tab/);
  });
});

describe("Apply and Approve says only what was approved", async () => {
  const { project } = await gitProject("sched");
  const pid = project.id;
  const { setScheduleKeeper } = await import("./schedules");
  const scheduled = (id: string) => ({ setting: "playbook", id, text: "---\ntitle: Daily\nwhen: weekdays 09:00\nprofile: reviewer\ntask: go\n---\nDo it.\n" });
  const cardOf = async (id: string) => ((await runCreateSettingsTool(chat(pid), { op: "propose", why: "Daily.", edits: [scheduled(id)] })).details as { card: { id: string; fingerprint: string; grants: unknown[] } }).card;
  const applied = (c: { id: string; fingerprint: string }) => post(app(), `/api/projects/${pid}/settings/apply`, { card: c.id, fingerprint: c.fingerprint });

  test("a schedule just committed is found and approved at once", async () => {
    const known: string[] = [];
    const approvedFor: string[] = [];
    setScheduleKeeper({ discover: async () => void known.push("daily"), list: async () => known.map((p) => ({ root: join(root, "sched"), playbook: p, pin: "pin1" })), approve: async (_r: string, ref: { playbook: string }, pin: string) => (approvedFor.push(`${ref.playbook}:${pin}`), { ok: true }) } as never);
    const c = await cardOf("daily");
    assert.equal(c.grants.length, 1);
    const r = await applied(c);
    assert.equal(r.status, 200, await r.clone().text());
    const body = (await r.json()) as { approved: string[]; card: { stillNeeds?: string[] } };
    assert.deepEqual(approvedFor, ["daily:pin1"], "the keeper hadn't seen it before the commit");
    assert.equal(body.approved.length, 1);
    assert.equal(body.card.stillNeeds, undefined);
  });

  test("one that can't be approved is never reported approved, and the card says where", async () => {
    setScheduleKeeper({ discover: async () => {}, list: async () => [], approve: async () => assert.fail("no pin to approve") } as never);
    const c = await cardOf("weekly");
    const body = (await (await applied(c)).json()) as { approved: string[]; card: { state: string; stillNeeds?: string[] } };
    assert.deepEqual(body.approved, [], "nothing was approved");
    assert.equal(body.card.state, "applied");
    assert.match(body.card.stillNeeds![0]!, /weekly still needs approving, in the Playbooks dialog/);
    assert.deepEqual((await settings.settingsCard(pid, c.id))!.stillNeeds, body.card.stillNeeds, "it stays on the card");
    setScheduleKeeper(null);
  });
});

test("what stays on its own screen is refused by name, saying where, in either shape of edit", async () => {
  const screens: Record<string, RegExp> = { "public-links": /Settings → Public Links, Where links open/, voice: /Settings → Voice, Set Up Voice/, updates: /Settings → General, Update from/, "mesh.links": /session pane's Agents tab/, "mesh.login-claim": /the Mesh page, Sync, Logins/, "mesh.internet-relay": /the Mesh page, Dial-out pairings/ };
  for (const [name, where] of Object.entries(screens)) {
    await assert.rejects(runCreateSettingsTool(chat(null), { op: "propose", why: "x", edits: [{ setting: name, value: 1 }] }), where);
    await assert.rejects(runCreateSettingsTool(chat(null), { op: "propose", why: "x", edits: [{ setting: "sova", id: name, value: 1 }] }), where);
  }
});

test("in Create the tool reaches the card path; a refusal is the tool's own words", async () => {
  const { setCreateSettingsRun } = await import("./create-settings-tool");
  const { runCreateSettings } = await import("./create-settings-run");
  setCreateSettingsRun(runCreateSettings);
  const on = createSettingsTool({ sessionId: "s", mode: () => "create", cwd: () => join(root, "not-a-project") });
  await assert.rejects(on.execute("t", { op: "propose", why: "x", edits: [{ setting: "project", name: "n" }] }, undefined as never, undefined as never, undefined as never), /isn't a project yet/);
  setCreateSettingsRun(null);
});

test("the tool answers only in Create", async () => {
  const off = createSettingsTool({ sessionId: "s", mode: () => "delegate", cwd: () => root });
  await assert.rejects(off.execute("t", { op: "get" }, undefined as never, undefined as never, undefined as never), /isn't in Create/);
  assert.ok(!existsSync(join(root, "never")));
});
