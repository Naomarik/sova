import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { Hono } from "hono";
import { linkPiConfigExtensions } from "./testing/agent-dir";

// A project's settings and the project overseer's sova_settings (§app.project-overseer/settings):
// what narrows applies at once in the operator's turn, every grant and every file change waits on a
// card only the operator's Apply lands (with the approvals of exactly the card's grants), a propose
// never touches the project folder, uncommitted edits there are one card of their own.

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-settings-")));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
linkPiConfigExtensions(agentDir);

await import("./testing/in-process-chats");
const po = await import("./project-overseer");
const settings = await import("./project-settings");
const { registerProjectSettingsRoutes } = await import("./project-settings-routes");
const { registerProjectIn } = await import("./projects/spaces");
const { readPoSettings, projectOverseerPaths } = await import("./project-overseer-store");
const { findProfile } = await import("./profile-sources");
const { OVERSEER_SENDER_HEADER, senderSecret } = await import("./overseer-sender");
const { disposeAllChats } = await import("./chat-manager");
const orgs = await import("./orgs");
const reconcile = await import("./reconcile");
const { runSettingsTool } = await import("./project-settings-tool");
const { settled } = await import("./workspace-git");

after(async () => {
  await disposeAllChats();
  await settled(join(root, "ws"));
});

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const REVIEWER = { id: "reviewer", label: "Reviewer", remove: ["shell"] };
const POWERFUL = { id: "reviewer", label: "Reviewer", grant: ["sessions.read"] };

/** A standalone project in a fresh Git repo with one committed profile. */
async function gitProject(name: string) {
  const dir = join(root, name);
  mkdirSync(join(dir, ".sova", "profiles"), { recursive: true });
  writeFileSync(join(dir, ".sova", "profiles", "reviewer.json"), `${JSON.stringify(REVIEWER, null, 2)}\n`);
  writeFileSync(join(dir, "README.md"), "hello\n");
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "add", "-A");
  sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
  const { project } = await registerProjectIn("standalone", dir, { name, origin: "folder" });
  await po.ensureProjectOverseer(project.id);
  return { dir, project };
}

const tool = (pid: string, attended: boolean) => po.toolsForTest(pid, { attended }).find((t) => t.name === "sova_settings")!;
const run = async (pid: string, attended: boolean, params: Record<string, unknown>) => (await tool(pid, attended).execute("t1", params, undefined, undefined, undefined as never)) as { content: { text: string }[]; details: any };

function app() {
  const a = new Hono();
  registerProjectSettingsRoutes(a);
  return a;
}
const post = (a: Hono, path: string, body: unknown, headers: Record<string, string> = {}) =>
  a.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("b1: its own switches, in the operator's turn", async () => {
  const { project } = await gitProject("b1");
  const pid = project.id;

  test("turning one of its own switches ON leaves it off and makes a card; what narrows applies at once", async () => {
    const before = readPoSettings(projectOverseerPaths(pid));
    assert.equal(before.powers.overseer.codingStart, false, "the carry-over from L1 has it Off");
    const out = await run(pid, true, {
      op: "propose",
      why: "Let it start builds, and keep it to one prompt a message.",
      edits: [{ setting: "overseer", patch: { powers: { overseer: { codingStart: true } }, caps: { promptsPerTurn: 1 } } }],
    });
    const now = readPoSettings(projectOverseerPaths(pid));
    assert.equal(now.powers.overseer.codingStart, false, "the switch stays Off: only the operator's Apply turns it On");
    assert.equal(now.caps.promptsPerTurn, 1, "a lowered limit narrows it: applied at once");
    const d = out.details;
    assert.equal(d.kind, "settings-card");
    assert.equal(d.card.state, "waiting");
    assert.deepEqual(d.card.kept.map((k: any) => k.field), ["powers.overseer.codingStart"]);
    assert.equal(d.card.grants.length, 1);
    assert.match(d.card.grants[0].what, /start coding sessions/i);
    assert.deepEqual(d.appliedNow.map((r: any) => [r.field, r.from, r.to, r.by.kind]), [["caps.promptsPerTurn", 5, 1, "project-overseer"]]);
    assert.match(out.content[0]!.text, /waits for the operator's Apply and Approve/);
    // The history has the at-once change, with Undo.
    const h = settings.readHistory(pid);
    assert.equal(h.at(-1)!.field, "caps.promptsPerTurn");
    // The operator applies it: the switch is On, recorded as theirs, through the card.
    const a = app();
    const r = await post(a, `/api/projects/${pid}/settings/apply`, { card: d.card.id, fingerprint: d.card.fingerprint });
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal(readPoSettings(projectOverseerPaths(pid)).powers.overseer.codingStart, true);
    const last = settings.readHistory(pid).at(-1)!;
    assert.deepEqual([last.field, last.to, last.by.kind, last.by.via, last.card], ["powers.overseer.codingStart", true, "operator", "card", d.card.id]);
  });

  test("a7: in a run the operator did not start nothing applies, even what narrows: it only prepares a card", async () => {
    const out = await run(pid, false, { op: "propose", why: "Fewer prompts.", edits: [{ setting: "overseer", patch: { caps: { promptsPerTurn: 0 } } }] });
    assert.equal(readPoSettings(projectOverseerPaths(pid)).caps.promptsPerTurn, 1);
    assert.equal(out.details.appliedNow.length, 0);
    assert.equal(out.details.card.state, "waiting");
    assert.match(out.content[0]!.text, /wasn't started by the operator, so nothing applied/);
  });

  test("Undo puts a field back, and refuses (409) once it changed since", async () => {
    const row = settings.readHistory(pid).find((r) => r.field === "caps.promptsPerTurn")!;
    await po.patchProjectOverseer(pid, { caps: { promptsPerTurn: 3 } });
    const a = app();
    const refused = await post(a, `/api/projects/${pid}/settings/undo`, { id: row.id });
    assert.equal(refused.status, 409);
    assert.match((await refused.json()).error, /changed since: undo the newer change first/);
    const newest = settings.readHistory(pid).at(-1)!;
    assert.deepEqual([newest.field, newest.by.via], ["caps.promptsPerTurn", "page"], "the page's own PATCH is in the history too");
    const ok = await post(a, `/api/projects/${pid}/settings/undo`, { id: newest.id });
    assert.equal(ok.status, 200);
    assert.equal(readPoSettings(projectOverseerPaths(pid)).caps.promptsPerTurn, 1);
    assert.equal(settings.readHistory(pid).at(-1)!.revertOf, newest.id);
  });

  test("Undo of a power turned Off is a grant: a chat's key, a script's token and the Overseer are refused (403) and it stays Off; the page puts it back", async () => {
    await po.patchProjectOverseer(pid, { powers: { overseer: { codingStart: true } } });
    await po.patchProjectOverseer(pid, { powers: { overseer: { codingStart: false } } });
    const row = settings.readHistory(pid).at(-1)!;
    assert.deepEqual([row.field, row.from, row.to], ["powers.overseer.codingStart", true, false]);
    const a = app();
    for (const headers of [{ "x-sova-caller": "k" }, { "x-sova-token": "x" }, { [OVERSEER_SENDER_HEADER]: senderSecret() }] as Record<string, string>[]) {
      const r = await post(a, `/api/projects/${pid}/settings/undo`, { id: row.id }, headers);
      assert.equal(r.status, 403, JSON.stringify(headers));
      assert.equal(readPoSettings(projectOverseerPaths(pid)).powers.overseer.codingStart, false, "the power stays Off");
    }
    assert.equal(settings.readHistory(pid).at(-1)!.id, row.id, "nothing written");
    const ok = await post(a, `/api/projects/${pid}/settings/undo`, { id: row.id });
    assert.equal(ok.status, 200, await ok.clone().text());
    assert.equal(readPoSettings(projectOverseerPaths(pid)).powers.overseer.codingStart, true);
    // A narrowing undo stays open to any caller, as today.
    const on = settings.readHistory(pid).at(-1)!;
    const narrow = await post(a, `/api/projects/${pid}/settings/undo`, { id: on.id }, { "x-sova-caller": "k" });
    assert.equal(narrow.status, 200, await narrow.clone().text());
    assert.equal(readPoSettings(projectOverseerPaths(pid)).powers.overseer.codingStart, false);
  });

  test("Apply is the operator's page only: the Overseer's sender mark, a script's token header and a chat's key are refused; a stale fingerprint is 409", async () => {
    const out = await run(pid, true, { op: "propose", why: "Look more.", edits: [{ setting: "overseer", patch: { holdMin: 0 } }] });
    const c = out.details.card;
    const a = app();
    const callers: Record<string, string>[] = [{ [OVERSEER_SENDER_HEADER]: senderSecret() }, { "x-sova-token": "x" }, { "x-sova-caller": "k" }];
    for (const headers of callers) {
      const r = await post(a, `/api/projects/${pid}/settings/apply`, { card: c.id, fingerprint: c.fingerprint }, headers);
      assert.equal(r.status, 403, JSON.stringify(headers));
    }
    const stale = await post(a, `/api/projects/${pid}/settings/apply`, { card: c.id, fingerprint: "0".repeat(32) });
    assert.equal(stale.status, 409);
    assert.notEqual(readPoSettings(projectOverseerPaths(pid)).holdMin, 0, "nothing applied");
  });
});

describe("file changes: a card, a Sova-owned ref, and Apply on the branch", async () => {
  const { dir, project } = await gitProject("files");
  const pid = project.id;

  test("a propose touches nothing in the project folder: its changes are a commit on refs/sova/settings/<pid>/<n>", async () => {
    const head = sh(dir, "rev-parse", "HEAD");
    const out = await run(pid, true, { op: "propose", why: "Add an offer.", edits: [{ setting: "offers", file: { version: 1, offers: { "next-step": { when: "after a turn", why: "to keep going", title: "Carry on?", buttons: [{ label: "Carry On", about: "Go on", send: "Go on." }] } } } }] });
    const c = out.details.card;
    assert.equal(c.files[0].path, ".sova/offers.json");
    assert.equal(c.grants.length, 0, "send buttons only: no grant");
    assert.equal(sh(dir, "rev-parse", "HEAD"), head);
    assert.equal(sh(dir, "status", "--porcelain"), "", "files and index untouched");
    assert.ok(!existsSync(join(dir, ".sova", "offers.json")));
    const ref = sh(dir, "rev-parse", `refs/sova/settings/${pid}/${c.id.slice(3)}`);
    assert.match(sh(dir, "show", "--stat", "--format=%s", ref), /offers\.json/);
    assert.match(c.diff, /\+\s+"version": 1/);
  });

  test("b2: a tracked profile already edited in the folder: Apply gives a plain refusal and the local card; once landed, findProfile sees the card's file at once", async () => {
    // Hand edits in the main folder (the overseer's own write, say).
    writeFileSync(join(dir, ".sova", "profiles", "reviewer.json"), `${JSON.stringify({ ...REVIEWER, description: "hand edit" }, null, 2)}\n`);
    const out = await run(pid, true, { op: "propose", why: "Let the reviewer read other sessions.", edits: [{ setting: "profile", id: "reviewer", profile: POWERFUL }] });
    const c = out.details.card;
    assert.equal(c.grants.length, 1);
    assert.equal(c.grants[0].key, `project:${project.root}#reviewer`);
    const a = app();
    const r = await post(a, `/api/projects/${pid}/settings/apply`, { card: c.id, fingerprint: c.fingerprint });
    assert.equal(r.status, 409);
    const said = (await r.json()).error as string;
    assert.equal(said, ".sova/profiles/reviewer.json has uncommitted edits in the project folder: land or discard them on the waiting card first.");
    // The waiting local card lists it.
    const info = await (await a.request(`/api/projects/${pid}/settings`)).json();
    assert.equal(info.local.id, "local");
    assert.deepEqual(info.local.files.map((f: any) => f.path), [".sova/profiles/reviewer.json"]);
    // Discard it, then Apply lands the card.
    const d = await post(a, `/api/projects/${pid}/settings/cards/local/withdraw`, { fingerprint: info.local.fingerprint });
    assert.equal(d.status, 200);
    assert.equal(sh(dir, "status", "--porcelain"), "");
    const ok = await post(a, `/api/projects/${pid}/settings/apply`, { card: c.id, fingerprint: c.fingerprint });
    assert.equal(ok.status, 200, await ok.clone().text());
    const body = await ok.json();
    assert.match(sh(dir, "log", "-1", "--format=%s"), /^Settings: Profile reviewer/);
    assert.equal(sh(dir, "status", "--porcelain"), "", "the folder's files and index match the new commit");
    const p = await findProfile({ source: "project", id: "reviewer" }, dir);
    assert.deepEqual(p?.grant, ["sessions.read"], "the new file, straight after");
    // F3: Apply and Approve recorded the approval of exactly what the card showed.
    assert.equal(p?.approval, "approved");
    assert.deepEqual(body.approved, [p!.key]);
    const fileRow = settings.readHistory(pid).at(-1)!;
    assert.equal(fileRow.field, "file:.sova/profiles/reviewer.json");
    assert.equal(fileRow.commit, sh(dir, "rev-parse", "HEAD"));
  });

  test("Land: uncommitted settings edits commit as they are, approving the grants they hold; other files stay", async () => {
    writeFileSync(join(dir, ".sova", "profiles", "wide.json"), `${JSON.stringify({ id: "wide", label: "Wide", grant: ["sessions.message"], overseerMayStart: true }, null, 2)}\n`);
    writeFileSync(join(dir, "README.md"), "edited\n");
    const a = app();
    const info = await (await a.request(`/api/projects/${pid}/settings`)).json();
    assert.deepEqual(info.local.files.map((f: any) => f.path), [".sova/profiles/wide.json"], "only settings files");
    assert.equal(info.local.grants.length, 1);
    const ok = await post(a, `/api/projects/${pid}/settings/apply`, { card: "local", fingerprint: info.local.fingerprint });
    assert.equal(ok.status, 200, await ok.clone().text());
    assert.equal(sh(dir, "status", "--porcelain"), "M README.md");
    assert.equal((await findProfile({ source: "project", id: "wide" }, dir))?.approval, "approved");
  });

  test("a file that changed on the branch since the card was made is refused, and the card stays", async () => {
    const out = await run(pid, true, { op: "propose", why: "Rename the label.", edits: [{ setting: "profile", id: "reviewer", profile: { ...POWERFUL, label: "Checker" } }] });
    const c = out.details.card;
    writeFileSync(join(dir, ".sova", "profiles", "reviewer.json"), `${JSON.stringify({ ...POWERFUL, label: "Other" }, null, 2)}\n`);
    sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "by hand");
    const r = await post(app(), `/api/projects/${pid}/settings/apply`, { card: c.id, fingerprint: c.fingerprint });
    assert.equal(r.status, 409);
    assert.match((await r.json()).error, /changed on main since sc_\d+ was made/);
  });

  test("edits are checked by the parsers; a path, archiving and moving the folder are refused, and nothing is written", async () => {
    const head = sh(dir, "rev-parse", "HEAD");
    await assert.rejects(() => run(pid, true, { op: "propose", why: "x", edits: [{ setting: "profile", id: "bad", profile: { id: "bad", label: "B", grant: ["root"] } }] }), /"grant" has unknown name "root"/);
    await assert.rejects(() => run(pid, true, { op: "propose", why: "x", edits: [{ setting: "services", file: { version: 1, nope: true } }] }), /The services file:/);
    await assert.rejects(() => run(pid, true, { op: "propose", why: "x", edits: [{ setting: "project", archived: true }] }), /Archiving is the operator's own/);
    await assert.rejects(() => run(pid, true, { op: "propose", why: "x", edits: [{ setting: "overseer", patch: { autonomy: "L3" } }] }), /Levels are gone/);
    await assert.rejects(() => run(pid, true, { op: "propose", why: "x", edits: [{ setting: "file", path: "src/x.ts" }] }), /Unknown setting/);
    assert.equal(sh(dir, "rev-parse", "HEAD"), head);
  });

  test("only settings files: the allowlist", () => {
    for (const ok of [".sova/project.json", ".sova/offers.json", ".sova/profiles/a.json", ".sova/playbooks/x/PLAYBOOK.md", ".sova/minor-modes/m/MODE.md"]) assert.ok(settings.isSettingsPath(ok), ok);
    for (const no of ["src/a.ts", ".sova/spec/manifest.json", ".sova/project.json/x", ".sova/profiles/../../x", "AGENTS.md"]) assert.ok(!settings.isSettingsPath(no), no);
  });
});

describe("a project that isn't in Git", async () => {
  const dir = join(root, "plain");
  mkdirSync(dir);
  const { project } = await registerProjectIn("standalone", dir, { name: "plain", origin: "folder" });
  await po.ensureProjectOverseer(project.id);
  test("file edits are refused in words; Sova-kept ones still work", async () => {
    await assert.rejects(() => run(project.id, true, { op: "propose", why: "x", edits: [{ setting: "offers", file: { version: 1, offers: {} } }] }), /isn't a Git repository, so its settings files change by hand/);
    const out = await run(project.id, true, { op: "propose", why: "Quieter.", edits: [{ setting: "overseer", patch: { watch: false } }] });
    assert.equal(out.details.card, null);
    assert.equal(readPoSettings(projectOverseerPaths(project.id)).watch, false);
  });
  test("get lists every setting with where it is changed", async () => {
    const out = await run(project.id, true, { op: "get" });
    for (const s of ["overseer.watch", "overseer.powers", "overseer.limits", "services", "offers"]) assert.match(out.content[0]!.text, new RegExp(`- ${s.replace(".", "\\.")}`), s);
    const ref = await run(project.id, true, { op: "reference", setting: "profile" });
    assert.match(ref.content[0]!.text, /overseerMayStart/);
  });
});

describe("an organization's project: the main stakeholder, the owner's page and Frozen", async () => {
  const org = await orgs.createOrg({ name: "Gate", dir: join(root, "ws") });
  mkdirSync(join(root, "orgproj"));
  const project = await orgs.addProject(org.id, { name: "Portal", root: join(root, "orgproj") });
  const pid = project.id;
  await po.ensureProjectOverseer(pid);
  const tony = await orgs.addPerson(org.id, { name: "Tony", role: "IT", decides: ["invoicing"] });
  const placed = () => orgs.readProjects(org.id).find((p) => p.id === pid)!;

  test("reference: project.frozen, project.stakeholder, project.ownerHidden and project.archive have entries", async () => {
    for (const [setting, words] of [["project.frozen", /frozen/i], ["project.stakeholder", /stakeholder/i], ["project.ownerHidden", /owner's page/i], ["project.archive", /its own confirm/i]] as const) {
      const out = await runSettingsTool(pid, { op: "reference", setting }, true);
      assert.match(out.content[0]!.text, words, setting);
    }
  });

  test("unfreezing the spec is a grant: a waiting card, applied only from the page", async () => {
    await reconcile.setFrozen(org.id, pid, true);
    const out = await run(pid, true, { op: "propose", why: "Let chats write the spec again.", edits: [{ setting: "project", frozen: false }] });
    assert.equal(placed().spec?.frozen, true, "still frozen: a grant waits for the operator");
    const c = out.details.card;
    assert.equal(c.state, "waiting");
    assert.deepEqual(c.kept.map((k: any) => [k.field, k.from, k.to]), [["project.frozen", true, false]]);
    assert.equal(c.grants.length, 1);
    assert.match(c.grants[0].what, /unfreez/i);
    const a = app();
    const refused = await post(a, `/api/projects/${pid}/settings/apply`, { card: c.id, fingerprint: c.fingerprint }, { "x-sova-caller": "k" });
    assert.equal(refused.status, 403);
    const r = await post(a, `/api/projects/${pid}/settings/apply`, { card: c.id, fingerprint: c.fingerprint });
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal(placed().spec?.frozen, false, "unfrozen by the page's Apply");
    const last = settings.readHistory(pid).at(-1)!;
    assert.deepEqual([last.field, last.from, last.to, last.by.kind, last.card], ["project.frozen", true, false, "operator", c.id]);
  });

  test("freezing, hiding from the owner's page and a stakeholder change apply at once in the operator's turn, with Undo; putting the page back is a grant", async () => {
    const out = await run(pid, true, { op: "propose", why: "Freeze it, hide it, Tony decides.", edits: [{ setting: "project", frozen: true, ownerHidden: true, stakeholder: tony.id }] });
    assert.equal(out.details.card, null, "nothing widens: no card");
    assert.equal(placed().spec?.frozen, true);
    assert.equal(placed().ownerHidden, true);
    assert.equal(placed().stakeholder, tony.id);
    assert.deepEqual(out.details.appliedNow.map((r: any) => r.field).sort(), ["project.frozen", "project.ownerHidden", "project.stakeholder"]);
    // Unattended, even hiding only prepares a card (a7).
    const later = await run(pid, false, { op: "propose", why: "None.", edits: [{ setting: "project", stakeholder: null }] });
    assert.equal(placed().stakeholder, tony.id);
    assert.equal(later.details.card.state, "waiting");
    // Undo of the hide shows the project again: a grant, the page's only.
    const hide = settings.readHistory(pid).find((r) => r.field === "project.ownerHidden" && r.to === true)!;
    const a = app();
    const no = await post(a, `/api/projects/${pid}/settings/undo`, { id: hide.id }, { "x-sova-token": "x" });
    assert.equal(no.status, 403);
    assert.equal(placed().ownerHidden, true);
    const ok = await post(a, `/api/projects/${pid}/settings/undo`, { id: hide.id });
    assert.equal(ok.status, 200, await ok.clone().text());
    assert.notEqual(placed().ownerHidden, true);
    // Undo of the stakeholder change is no grant.
    const st = settings.readHistory(pid).find((r) => r.field === "project.stakeholder")!;
    const back = await post(a, `/api/projects/${pid}/settings/undo`, { id: st.id }, { "x-sova-caller": "k" });
    assert.equal(back.status, 200, await back.clone().text());
    assert.equal(placed().stakeholder ?? null, null);
    // Unknown project keys and archiving are refused.
    await assert.rejects(() => run(pid, true, { op: "propose", why: "x", edits: [{ setting: "project", owner: "x" }] }), /Unknown project setting "owner"/);
    await assert.rejects(() => run(pid, true, { op: "propose", why: "x", edits: [{ setting: "project", archived: true }] }), /its own confirm/);
    await assert.rejects(() => run(pid, true, { op: "propose", why: "x", edits: [{ setting: "project", stakeholder: "p_nobody00" }] }), /active person on the roster/);
  });
});

test("a standalone project has no stakeholder, owner's page or Frozen: refused in words", async () => {
  const { project } = await gitProject("lone");
  await assert.rejects(() => run(project.id, true, { op: "propose", why: "x", edits: [{ setting: "project", frozen: true }] }), /only an organization's project/i);
});

test("only the project overseer has sova_settings, and its ops map to a power (propose always, apply the operator's)", async () => {
  const { TOOL_POWER, OP_POWER } = await import("./project-overseer-tools");
  assert.equal(TOOL_POWER.sova_settings, "per-op");
  assert.deepEqual(OP_POWER.sova_settings, { get: "always", reference: "always", propose: "always", withdraw: "always", apply: "operator" });
  const snapshot = readFileSync(join(import.meta.dirname, "agent-loadouts.snapshot.json"), "utf8");
  const families = Object.entries((JSON.parse(snapshot) as { families: Record<string, unknown> }).families)
    .filter(([, v]) => JSON.stringify(v).includes("sova_settings"))
    .map(([k]) => k);
  assert.ok(families.length > 0 && families.every((k) => k.startsWith("project-overseer")), families.join(", "));
});

test("an offers file's only grant is its unapproved run buttons: removing a leftover mainMerges, or the file, is none", async () => {
  const left = JSON.stringify({ version: 1, mainMerges: "go-ahead", offers: {} });
  const plain = JSON.stringify({ version: 1, offers: {} });
  const f = { setting: "offers" as const, rel: ".sova/offers.json" };
  const r = join(root, "guard-root");
  assert.equal(await settings.fileGrant(r, f, left, plain), null);
  assert.equal(await settings.fileGrant(r, f, left, null), null);
  assert.equal(await settings.fileGrant(r, f, plain, left), null);
  const runs = JSON.stringify({ version: 1, offers: { m: { when: "w", title: "t", buttons: [{ label: "Merge", about: "Merges.", run: "project.worktree.merge" }] } } });
  const g = await settings.fileGrant(r, f, left, runs);
  assert.equal(g?.what, "run buttons: Merge (m) runs project.worktree.merge");
  assert.equal(typeof g?.pin, "string");
});

describe("this machine's copy limit (§app.project-services/instances): a Sova-kept setting with history, Undo and grant/narrow", async () => {
  const { dir, project } = await gitProject("copies");
  const pid = project.id;
  writeFileSync(join(dir, ".sova", "project.json"), JSON.stringify({ version: 1, slots: { cap: 4 }, services: { web: { cmd: ["node", "web.mjs"], ports: { http: { base: 41_000 } } } } }));
  const { machineCopyLimit } = await import("./project-services/copy-limit");
  const { registerServicesViewRoutes } = await import("./project-services/view-routes");
  const put = (body: unknown, headers: Record<string, string> = {}) => {
    const a = new Hono();
    registerServicesViewRoutes(a);
    return a.request(`/api/projects/${pid}/services/limit`, { method: "PUT", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  };

  test("lowering applies at once in the operator's turn; raising waits on a card; a run the operator didn't start applies nothing", async () => {
    const params = tool(pid, true).parameters as any;
    assert.ok(params.properties.edits.items.properties.setting.enum.includes("copies"), "the model can name it");
    assert.match(tool(pid, true).description, /\{setting: "copies", limit: 1–16 \| null\}/);
    const low = await run(pid, true, { op: "propose", why: "Fewer copies at once.", edits: [{ setting: "copies", limit: 2 }] });
    assert.equal(machineCopyLimit(dir), 2, "lowered below the file's 4: applied at once");
    assert.deepEqual(low.details.appliedNow.map((r: any) => [r.field, r.from, r.to, r.by.kind]), [["copies", null, 2, "project-overseer"]]);
    const quiet = await run(pid, false, { op: "propose", why: "Even fewer.", edits: [{ setting: "copies", limit: 1 }] });
    assert.equal(machineCopyLimit(dir), 2, "nothing applies in a run the operator didn't start");
    assert.equal(quiet.details.card.state, "waiting");
    await post(app(), `/api/projects/${pid}/settings/cards/${quiet.details.card.id}/withdraw`, {});
    const high = await run(pid, true, { op: "propose", why: "Room for twelve.", edits: [{ setting: "copies", limit: 12 }] });
    assert.equal(machineCopyLimit(dir), 2, "a raise is a grant: it waits");
    const c = high.details.card;
    assert.deepEqual(c.kept.map((k: any) => [k.field, k.from, k.to]), [["copies", 2, 12]]);
    assert.match(c.grants[0].what, /raises the copy limit on this machine to 12 running copies at once \(from 2\)/);
    const r = await post(app(), `/api/projects/${pid}/settings/apply`, { card: c.id, fingerprint: c.fingerprint });
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal(machineCopyLimit(dir), 12);
    const last = settings.readHistory(pid).at(-1)!;
    assert.deepEqual([last.field, last.from, last.to, last.by.via, last.card], ["copies", 2, 12, "card", c.id]);
  });

  test("a reset to the file's value is a grant only when the file's is higher; bad values are refused in words", async () => {
    const reset = await run(pid, true, { op: "propose", why: "Back to the file's.", edits: [{ setting: "copies", limit: null }] });
    assert.equal(machineCopyLimit(dir), null, "12 → the file's 4 narrows: applied at once");
    assert.equal(reset.details.card, null);
    await run(pid, true, { op: "propose", why: "One.", edits: [{ setting: "copies", limit: 1 }] });
    const back = await run(pid, true, { op: "propose", why: "Back to the file's.", edits: [{ setting: "copies", limit: null }] });
    assert.equal(machineCopyLimit(dir), 1, "1 → the file's 4 raises it: a card");
    assert.match(back.details.card.grants[0].what, /to 4 running copies at once \(from 1\)/);
    await post(app(), `/api/projects/${pid}/settings/cards/${back.details.card.id}/withdraw`, {});
    for (const [edit, why] of [
      [{ setting: "copies", limit: 17 }, /a whole number from 1 to 16/],
      [{ setting: "copies", limit: 0 }, /a whole number from 1 to 16/],
      [{ setting: "copies" }, /names limit/],
      [{ setting: "copies", limit: 3, cap: 3 }, /Unknown copies setting "cap"/],
    ] as const) {
      await assert.rejects(run(pid, true, { op: "propose", why: "x", edits: [edit] }), why, JSON.stringify(edit));
    }
    assert.equal(machineCopyLimit(dir), 1, "nothing written");
  });

  test("the Branches tab's PUT is the operator's page only; its change is a history line whose raise only the page may undo", async () => {
    for (const headers of [{ "x-sova-caller": "k" }, { "x-sova-token": "x" }, { [OVERSEER_SENDER_HEADER]: senderSecret() }] as Record<string, string>[]) {
      const r = await put({ cap: 9 }, headers);
      assert.equal(r.status, 403, JSON.stringify(headers));
    }
    assert.equal(machineCopyLimit(dir), 1);
    assert.equal((await put({ cap: 40 })).status, 400);
    assert.equal((await put({})).status, 400);
    const r = await put({ cap: 9 });
    assert.equal(r.status, 200, await r.clone().text());
    const body = await r.json();
    assert.deepEqual([body.limit.value, body.limit.source, body.limit.file], [9, "machine", 4]);
    const row = settings.readHistory(pid).at(-1)!;
    assert.deepEqual([row.field, row.from, row.to, row.by.kind, row.by.via], ["copies", 1, 9, "operator", "page"]);
    // Lowering it again, then undoing that lowering, raises it: the page only.
    assert.equal((await put({ cap: 3 })).status, 200);
    const lowered = settings.readHistory(pid).at(-1)!;
    const refused = await post(app(), `/api/projects/${pid}/settings/undo`, { id: lowered.id }, { "x-sova-caller": "k" });
    assert.equal(refused.status, 403);
    assert.equal(machineCopyLimit(dir), 3);
    const ok = await post(app(), `/api/projects/${pid}/settings/undo`, { id: lowered.id });
    assert.equal(ok.status, 200, await ok.clone().text());
    assert.equal(machineCopyLimit(dir), 9);
    // The history reads in words, and All settings lists the row with its source.
    const h = await (await app().request(`/api/projects/${pid}/settings/history`)).json();
    assert.deepEqual([h[0].label, h[0].fromText, h[0].toText], ["Copy limit", "3 at once", "9 at once"]);
    const info = await settings.settingsInfo(pid);
    const rowInfo = info.rows.find((x) => x.setting === "copies")!;
    assert.deepEqual([rowInfo.label, rowInfo.state, rowInfo.detail, rowInfo.href], ["Copy limit", "9 at once", "set on this machine", `#/projects/${pid}/branches`]);
    assert.equal((await put({ cap: null })).status, 200);
    assert.deepEqual([machineCopyLimit(dir), (await settings.settingsInfo(pid)).rows.find((x) => x.setting === "copies")!.detail], [null, "from the project's file"]);
  });
});
