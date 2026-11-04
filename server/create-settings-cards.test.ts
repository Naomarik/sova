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
const { runCreateSettingsTool } = await import("./project-settings-tool");
const { createSettingsTool } = await import("./create-settings-tool");
const sova = await import("./sova-settings");
const { SOVA_SETTING_IDS, SOVA_SETTINGS } = await import("../shared/sova-settings-reference");
const { settingsDocs } = await import("./sync/docs");
const { setSettingsSpreadProbe } = await import("./sync/spreads");
const { setQueueCardPort } = await import("./merge-queue/card-port");
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
    const d = await propose("models.policy", { disabledProviders: ["zai"], disabledModels: [], subagentDisabledProviders: [], subagentDisabledModels: [] });
    assert.equal(d.card.grants.length, 1);
    sova.withdrawSovaCard(d.card.id);
  });

  test("a key never goes on a card; a variable's name isn't a key", async () => {
    const provider = (apiKey: string) => ({ providers: { mine: { baseUrl: "http://localhost:1", api: "openai", apiKey, models: [] } } });
    await assert.rejects(propose("models.providers", provider("abc123literalkey")), /Create doesn't handle sign-ins or keys/);
    await assert.rejects(propose("models.providers", provider("!cat ~/.key")), /Create doesn't handle sign-ins or keys/);
    await assert.rejects(propose("decisions", { jev: { key: "abcdef" } }), /Settings → Decisions/);
    const d = await propose("models.providers", provider("MY_PROVIDER_KEY"));
    sova.withdrawSovaCard(d.card.id);
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

test("the tool answers only in Create", async () => {
  const off = createSettingsTool({ sessionId: "s", mode: () => "delegate", cwd: () => root });
  await assert.rejects(off.execute("t", { op: "get" }, undefined as never, undefined as never, undefined as never), /isn't in Create/);
  assert.ok(!existsSync(join(root, "never")));
});
