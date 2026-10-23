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

after(async () => {
  await disposeAllChats();
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
