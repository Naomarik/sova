// Run: pnpm exec tsx --test server/orgs.test.ts. A throwaway PI_CODING_AGENT_DIR and workspace
// dirs in the OS temp dir, deleted after; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { PROFILE_FIELDS, type ChangeWriter, type ProfileField } from "../shared/orgs";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-orgs-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sessions"), { recursive: true });

const orgs = await import("./orgs");
const { resolveSessionPath } = await import("./paths");
const { settled } = await import("./workspace-git");
const { Hono } = await import("hono");
const { registerOrgRoutes } = await import("./org-routes");

after(() => rmSync(root, { recursive: true, force: true }));

const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();

/** A value each field accepts, different from the person's current one. */
const VALUE: Record<ProfileField, unknown> = {
  name: "Renamed Person",
  status: "left",
  contact: { email: "new@example.com" },
  role: "New role",
  decides: ["budget"],
  skills: ["Python"],
  competence: { Python: { level: 3, n: 1 } },
  language: "fr",
  voice: "Formal.",
  referral: { why: "Knows it", referredBy: "operator" },
  tz: "Europe/Istanbul",
  hours: { days: [1, 2, 3, 4, 5], from: "09:00", to: "17:00" },
};

describe("organizations", async () => {
  const org = await orgs.createOrg({ name: "Acme Co", dir: join(root, "ws-acme") });
  const dir = orgs.orgDir(org.id);

  test("create makes its own git repo with a first commit, and the sessions dir is a session root", async () => {
    await settled(dir);
    assert.equal(git(dir, "rev-parse", "--show-toplevel"), realpathSync(dir));
    assert.match(git(dir, "log", "--format=%s"), /Create organization Acme Co/);
    assert.deepEqual(orgs.workspaceSessionRoots(), [join(realpathSync(dir), "sessions")]);
    const inRoot = join(realpathSync(dir), "sessions", "2026-01-01T00-00-00-000Z_x.jsonl");
    writeFileSync(inRoot, "{}\n");
    assert.equal(resolveSessionPath(inRoot), inRoot, "a file directly in the org's sessions dir is a session");
    assert.equal(resolveSessionPath(join(dir, "roster-history.jsonl")), null, "the roster history is never a session");
    mkdirSync(join(dir, "sessions", "nested"), { recursive: true });
    assert.equal(resolveSessionPath(join(dir, "sessions", "nested", "a.jsonl")), null, "only directly inside");
  });

  test("the field-authority table: every writer × every field", async () => {
    const allowed: Record<ChangeWriter, ProfileField[]> = {
      operator: [...PROFILE_FIELDS],
      wrapup: ["skills", "competence", "language", "voice"],
      overseer: ["skills", "competence", "language", "voice"],
      referral: [],
    };
    for (const kind of ["operator", "wrapup", "overseer", "referral"] as ChangeWriter[])
      for (const field of PROFILE_FIELDS) {
        const p = await orgs.addPerson(org.id, { name: `P ${kind} ${field}`, role: "r", contact: { email: "a@b.c" } });
        const before = orgs.readHistory(org.id).length;
        const patch = field === "name" ? { name: `${p.name} two` } : { [field]: VALUE[field] };
        const ok = allowed[kind].includes(field);
        if (ok) {
          await orgs.applyChange(org.id, p.id, patch, { kind });
          assert.equal(orgs.readHistory(org.id).length, before + 1, `${kind} may write ${field}: one history line`);
        } else {
          // Today's order: field authority first; a referral's own fields then meet "only create".
          const referralField = ["name", "status", "contact", "role", "decides", "referral"].includes(field);
          const sentence = kind === "referral" && referralField ? "A referral may only create a proposed person." : `A ${kind} change may not write ${field}.`;
          await assert.rejects(orgs.applyChange(org.id, p.id, patch, { kind }), (e: unknown) => e instanceof orgs.OrgError && e.status === 409 && e.message === sentence, `${kind} may not write ${field}`);
          assert.equal(orgs.readHistory(org.id).length, before, `a refused ${kind} change of ${field} appends nothing`);
        }
      }
  });

  test("a referral only creates a proposed person, and a proposed person must be complete", async () => {
    const complete = { name: "Bob Ref", status: "proposed" as const, role: "Accountant", contact: { phone: "+1 555 010 0199" }, referral: { why: "Does the books", referredBy: "Tony" } };
    const bob = await orgs.addPerson(org.id, complete, { kind: "referral", sessionId: "s1", quote: "ask Bob" });
    assert.equal(bob.status, "proposed");
    await assert.rejects(orgs.addPerson(org.id, { ...complete, name: "Active Ref", status: "active" }, { kind: "referral" }), { message: "A referral may only create a proposed person." });
    await assert.rejects(orgs.applyChange(org.id, bob.id, { role: "x" }, { kind: "referral" }), orgs.OrgError);
    for (const drop of ["contact", "role", "referral"] as const) {
      const partial: Record<string, unknown> = { ...complete, name: `Missing ${drop}` };
      delete partial[drop];
      await assert.rejects(orgs.addPerson(org.id, partial as never), /A proposed person needs/, `without ${drop}`);
    }
    await assert.rejects(orgs.addPerson(org.id, { ...complete, name: "No why", referral: { why: "", referredBy: "x" } }), /why they were referred/);
    // Making an active person proposed later is held to the same rule.
    const al = await orgs.addPerson(org.id, { name: "Al", role: "r" });
    await assert.rejects(orgs.applyChange(org.id, al.id, { status: "proposed" }, { kind: "operator" }), /A proposed person needs/);
  });

  test("a decides entry with no letter names no area: refused, never filed under \"general\"", async () => {
    for (const bad of ["*", "-", "2024"]) await assert.rejects(orgs.addPerson(org.id, { name: `Star ${bad}`, decides: ["website", bad] }), { message: `“${bad}” names no decision area: use words, like “website”.` });
    assert.deepEqual((await orgs.addPerson(org.id, { name: "Ok Areas", decides: ["Café", "site structure / pages"] })).decides, ["Café", "site structure / pages"]);
  });

  test("the main stakeholder: operator-set, active people only, history kept; cleared when they leave, with a Needs-you item until any save", async () => {
    mkdirSync(join(root, "site"), { recursive: true });
    const pr = await orgs.addProject(org.id, { name: "Website", root: join(root, "site") });
    const alp = await orgs.addPerson(org.id, { name: "Alperen", role: "Owner", decides: ["website"] });
    const prop = await orgs.addPerson(org.id, { name: "Prop Osed", status: "proposed", role: "x", contact: { email: "p@example.com" }, referral: { why: "w", referredBy: alp.id } }, { kind: "referral" });
    const refusal = { message: "Only an active person on the roster can be a project's main stakeholder." };
    for (const bad of ["p_nobody00", prop.id, 42]) await assert.rejects(orgs.patchProject(org.id, pr.id, { stakeholder: bad }), refusal, String(bad));
    const project = () => orgs.readProjects(org.id).find((x) => x.id === pr.id)!;
    assert.equal(project().stakeholder, undefined, "a refusal writes nothing");
    await orgs.patchProject(org.id, pr.id, { stakeholder: alp.id });
    await orgs.patchProject(org.id, pr.id, { stakeholder: alp.id });
    assert.equal(project().stakeholder, alp.id);
    assert.deepEqual(project().stakeholderHistory?.map((h) => [h.from, h.to, h.why]), [[null, alp.id, "operator"]], "a save that changes nothing adds no line");
    assert.equal(orgs.stakeholderOf(org.id, pr.id), alp.id);
    assert.deepEqual(orgs.stakeholderAttention(), []);
    // They leave: cleared at once, with the why, and one decide-tier item for the project.
    await orgs.applyChange(org.id, alp.id, { status: "left" }, { kind: "operator" });
    assert.equal(project().stakeholder, undefined);
    assert.deepEqual(project().stakeholderHistory?.map((h) => [h.from, h.to, h.why]), [[null, alp.id, "operator"], [alp.id, null, "left"]]);
    assert.deepEqual({ ...project().stakeholderCleared, at: "" }, { personId: alp.id, name: "Alperen", at: "" });
    const items = orgs.stakeholderAttention().filter((i) => i.id === `project-stakeholder:${pr.id}`);
    assert.deepEqual(
      items.map((i) => [i.tier, i.kind, i.detail, i.href, i.org?.projectId]),
      [["decide", "project-stakeholder", "Pick a main stakeholder for Website: Alperen left the organization.", `#/orgs/${org.id}/projects/${pr.id}`, pr.id]],
    );
    // Choosing None answers it too.
    await orgs.patchProject(org.id, pr.id, { stakeholder: null });
    assert.equal(project().stakeholderCleared, undefined);
    assert.deepEqual(orgs.stakeholderAttention().filter((i) => i.id === `project-stakeholder:${pr.id}`), []);
    await assert.rejects(orgs.patchProject(org.id, pr.id, { stakeholder: alp.id }), refusal, "someone who left can't be picked");
  });

  test("caps are refused (400), never cut", async () => {
    const bad = (re: RegExp) => (e: unknown) => e instanceof orgs.OrgError && e.status === 400 && re.test(e.message);
    await assert.rejects(orgs.addPerson(org.id, { name: "Long", voice: "x".repeat(301) }), bad(/at most 300/));
    await assert.rejects(orgs.addPerson(org.id, { name: "Many", skills: Array.from({ length: 13 }, (_, i) => `s${i}`) }), bad(/at most 12/));
    await assert.rejects(orgs.addPerson(org.id, { name: "Wide", decides: ["y".repeat(41)] }), bad(/at most 40/));
    await assert.rejects(orgs.addPerson(org.id, { name: "Lang", language: "not a tag!" }), bad(/BCP-47/));
  });

  test("revert writes a new change back to the old value, and history is never edited", async () => {
    const p = await orgs.addPerson(org.id, { name: "Rita", voice: "Warm." });
    await orgs.applyChange(org.id, p.id, { voice: "Cold." }, { kind: "wrapup", sessionId: "s", quote: "q" });
    const change = orgs.readHistory(org.id, p.id).find((c) => c.field === "voice" && c.to === "Cold.")!;
    const before = readFileSync(join(dir, "roster-history.jsonl"), "utf8");
    const back = await orgs.revertChange(org.id, p.id, change.at);
    assert.equal(back.voice, "Warm.");
    const after = readFileSync(join(dir, "roster-history.jsonl"), "utf8");
    assert.ok(after.startsWith(before), "appended only");
    const last = orgs.readHistory(org.id, p.id).at(-1)!;
    assert.deepEqual([last.field, last.from, last.to, last.revertOf, last.by.kind], ["voice", "Cold.", "Warm.", change.at, "operator"]);
    await assert.rejects(orgs.revertChange(org.id, p.id, "1999-01-01T00:00:00.000Z"), (e: unknown) => e instanceof orgs.OrgError && e.status === 404 && e.message === "No such change");
    const created = orgs.readHistory(org.id, p.id).find((c) => c.field === "name")!;
    await assert.rejects(orgs.revertChange(org.id, p.id, created.at), { message: "A person's creation can't be reverted; set their status to left instead." });
  });

  test("C6: reverting a change the field no longer holds is refused (409), and nothing is written", async () => {
    const p = await orgs.addPerson(org.id, { name: "Stale Row", role: "One" });
    await orgs.applyChange(org.id, p.id, { role: "Two" }, { kind: "operator" });
    const first = orgs.readHistory(org.id, p.id).find((c) => c.field === "role" && c.to === "Two")!;
    await orgs.applyChange(org.id, p.id, { role: "Three" }, { kind: "operator" });
    const lines = orgs.readHistory(org.id).length;
    await assert.rejects(
      orgs.revertChange(org.id, p.id, first.at),
      (e: unknown) => e instanceof orgs.OrgError && e.status === 409 && e.message === "Stale Row's role has changed since then, so reverting this would undo a later change. Revert the latest change instead.",
    );
    assert.equal(orgs.findPerson(org.id, p.id)!.role, "Three");
    assert.equal(orgs.readHistory(org.id).length, lines);
    // The newest change of the field still reverts.
    const latest = orgs.readHistory(org.id, p.id).filter((c) => c.field === "role").at(-1)!;
    assert.equal((await orgs.revertChange(org.id, p.id, latest.at)).role, "Two");
  });

  test("a status move is one transition per pair, with its history line (C10)", async () => {
    const p = await orgs.addPerson(org.id, { name: "Moves", role: "r", contact: { email: "m@example.com" } });
    await orgs.applyChange(org.id, p.id, { status: "left" }, { kind: "operator" });
    assert.equal(orgs.findPerson(org.id, p.id)!.status, "left");
    await orgs.applyChange(org.id, p.id, { status: "active" }, { kind: "operator" });
    assert.equal(orgs.findPerson(org.id, p.id)!.status, "active");
    const statuses = orgs.readHistory(org.id, p.id).filter((c) => c.field === "status").map((c) => [c.from, c.to]);
    assert.deepEqual(statuses, [[null, "active"], ["active", "left"], ["left", "active"]]);
    await assert.rejects(orgs.approvePerson(org.id, p.id), { message: "Moves is not waiting for approval." });
  });

  test("a duplicate name is refused (409); someone who left frees their name", async () => {
    const a = await orgs.addPerson(org.id, { name: "Twin" });
    await assert.rejects(orgs.addPerson(org.id, { name: "twin" }), (e: unknown) => e instanceof orgs.OrgError && e.status === 409 && e.message === "twin is already on the roster.");
    await orgs.applyChange(org.id, a.id, { status: "left" }, { kind: "operator" });
    assert.equal((await orgs.addPerson(org.id, { name: "Twin" })).status, "active");
  });

  test("q1: no state file is written in the workspace (only charts, the plain files and git)", () => {
    for (const f of ["org.json", "roster.json", "projects.json", "holder.json", "baton.json"]) assert.equal(existsSync(join(dir, f)), false, f);
    assert.ok(existsSync(join(dir, "charts", "org")), "the org chart's snapshot");
    assert.ok(existsSync(join(dir, "roster-history.jsonl")));
  });

  test("prompt partition: contact never, steering only for the holder, redaction phrases ≥ 16 chars", async () => {
    const p = await orgs.addPerson(org.id, { name: "Tina", role: "IT", decides: ["servers"], skills: ["SQL", "Windows Server administration"], voice: "Short answers, please.", contact: { email: "tina@example.com" } });
    assert.ok(!orgs.participantLine(p).includes("tina@example.com") && !orgs.participantLine(p).includes("Short answers"));
    assert.match(orgs.participantLine(p), /Tina.*IT.*servers/);
    const steering = orgs.holderSteering(p);
    assert.ok(steering.includes("Short answers") && !steering.includes("tina@example.com"));
    assert.deepEqual(orgs.profileRedactTexts(p), ["Short answers, please.", "Windows Server administration"]);
  });
});

describe("workspace dirs never inside Sova's own repo", () => {
  const sova = join(root, "sova");
  mkdirSync(sova, { recursive: true });
  execFileSync("git", ["-C", sova, "init", "-q"]);
  writeFileSync(join(sova, ".gitignore"), ".agent/\n");
  mkdirSync(join(sova, ".agent"), { recursive: true });

  test("inside and not ignored: refused; ignored or outside: allowed", async () => {
    assert.match((await orgs.workspaceDirProblem(join(sova, "workspaces", "x"), sova)) ?? "", /must not live inside Sova/);
    assert.match((await orgs.workspaceDirProblem(sova, sova)) ?? "", /must not live inside Sova/);
    assert.equal(await orgs.workspaceDirProblem(join(sova, ".agent", "sova", "workspaces", "x"), sova), null);
    assert.equal(await orgs.workspaceDirProblem(join(root, "elsewhere"), sova), null);
    assert.match((await orgs.workspaceDirProblem("relative/dir", sova)) ?? "", /absolute/);
  });

  // An install that is not a git checkout (a copied or unpacked tree): nothing can say what it
  // ignores, so only Sova's own state dir (the default workspaces base) is allowed inside it.
  test("not a git checkout: the default workspaces dir is allowed, the rest of the tree is not", async () => {
    const plain = join(root, "plain-install");
    const base = join(plain, ".agent", "sova", "workspaces");
    mkdirSync(join(plain, "server"), { recursive: true });
    writeFileSync(join(plain, ".gitignore"), ".agent/\n");
    assert.equal(await orgs.workspaceDirProblem(join(base, "acme"), plain, base), null);
    assert.equal(await orgs.workspaceDirProblem(join(base, "deep", "acme"), plain, base), null);
    assert.match((await orgs.workspaceDirProblem(join(plain, "server", "x"), plain, base)) ?? "", /must not live inside Sova/);
    assert.match((await orgs.workspaceDirProblem(join(plain, ".agent", "sova", "other"), plain, base)) ?? "", /must not live inside Sova/);
    assert.match((await orgs.workspaceDirProblem(join(plain, ".agent", "sova", "workspaces-x"), plain, base)) ?? "", /must not live inside Sova/);
    assert.match((await orgs.workspaceDirProblem(plain, plain, base)) ?? "", /must not live inside Sova/);
    // The base is the root itself: that exception would cover the whole tree, so it never applies.
    assert.match((await orgs.workspaceDirProblem(join(plain, "server", "x"), plain, plain)) ?? "", /must not live inside Sova/);
    // In a git checkout the ignore rules decide, base or not: an unignored base is still refused.
    const unignored = join(sova, "state", "workspaces");
    assert.match((await orgs.workspaceDirProblem(join(unignored, "acme"), sova, unignored)) ?? "", /must not live inside Sova/);
  });
});

describe("About this organization (§app.organizations/about)", () => {
  // Made in before(): the first describe's tests pin the exact set of attached orgs.
  let org: { id: string };
  let dir = "";
  before(async () => {
    org = await orgs.createOrg({ name: "About Co", dir: join(root, "ws-about") });
    dir = orgs.orgDir(org.id);
  });
  const app = new Hono();
  registerOrgRoutes(app);
  const call = (method: string, path: string, body: unknown) =>
    app.request(`/api/orgs/${org.id}${path}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const historyText = () => readFileSync(join(dir, "org-history.jsonl"), "utf8");

  test("none at first: no file, no detail field, no history", async () => {
    assert.equal(orgs.readOrgAbout(org.id), "");
    const d = await orgs.orgDetail(org.id);
    assert.equal(d.about, undefined);
    assert.deepEqual(d.aboutHistory, []);
  });

  test("a save writes about.md trimmed, history first; the same text appends nothing", async () => {
    await orgs.patchOrg(org.id, { about: "  They pay late.\n" });
    assert.equal(readFileSync(join(dir, "about.md"), "utf8"), "They pay late.");
    assert.equal(orgs.readOrgAbout(org.id), "They pay late.");
    const lines = orgs.readOrgHistory(org.id);
    assert.equal(lines.length, 1);
    assert.deepEqual([lines[0]!.field, lines[0]!.from, lines[0]!.to, lines[0]!.by], ["about", "", "They pay late.", { kind: "operator" }]);
    const before = historyText();
    await orgs.patchOrg(org.id, { about: "They pay late." });
    assert.equal(historyText(), before, "no change, no line");
  });

  test("the cap: 4,000 characters saved, 4,001 refused and nothing written", async () => {
    const before = historyText();
    await assert.rejects(orgs.patchOrg(org.id, { about: "x".repeat(4001) }), /at most 4,000 characters/);
    assert.equal(historyText(), before);
    const res = await call("PATCH", "", { about: "y".repeat(4001) });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /at most 4,000 characters/);
    assert.equal((await call("PATCH", "", { about: "z".repeat(4000) })).status, 200);
    assert.equal(orgs.readOrgAbout(org.id).length, 4000);
    await assert.rejects(orgs.patchOrg(org.id, { about: 7 }), /about must be text/);
  });

  test("a blank save removes the file and records the clearing", async () => {
    await orgs.patchOrg(org.id, { about: "Short again." });
    await orgs.patchOrg(org.id, { about: "   " });
    assert.equal(existsSync(join(dir, "about.md")), false);
    assert.equal(orgs.readOrgAbout(org.id), "");
    const last = orgs.readOrgHistory(org.id).at(-1)!;
    assert.deepEqual([last.from, last.to], ["Short again.", ""]);
  });

  test("Revert writes a new change back to the line's from; a revert of a revert; history only grows; `at` is unique", async () => {
    await orgs.patchOrg(org.id, { about: "First." });
    await orgs.patchOrg(org.id, { about: "Second." });
    const second = orgs.readOrgHistory(org.id).at(-1)!;
    const before = historyText();
    const res = await call("POST", "/about/revert", { at: second.at });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { about?: string }).about, "First.");
    assert.ok(historyText().startsWith(before), "appended only");
    const back = orgs.readOrgHistory(org.id).at(-1)!;
    assert.deepEqual([back.from, back.to, back.revertOf], ["Second.", "First.", second.at]);
    orgs.revertOrgChange(org.id, back.at);
    assert.equal(orgs.readOrgAbout(org.id), "Second.");
    assert.equal(orgs.readOrgHistory(org.id).at(-1)!.revertOf, back.at);
    const ats = orgs.readOrgHistory(org.id).map((c) => c.at);
    assert.equal(new Set(ats).size, ats.length);
    assert.equal((await call("POST", "/about/revert", { at: "1999-01-01T00:00:00.000Z" })).status, 404);
  });

  test("the detail carries the text and the last 20 lines, newest first; the summary and the org never carry it", async () => {
    for (let i = 0; i < 22; i++) await orgs.patchOrg(org.id, { about: `Version ${i}` });
    const d = await orgs.orgDetail(org.id);
    assert.equal(d.about, "Version 21");
    assert.equal(d.aboutHistory!.length, 20);
    assert.equal(d.aboutHistory![0]!.to, "Version 21");
    assert.ok(!("about" in orgs.readOrg(org.id)));
    assert.ok(orgs.orgSummaries().every((s) => !("about" in s) && !("aboutHistory" in s)));
    assert.ok(!JSON.stringify(orgs.orgsInfo()).includes("Version 21"));
  });

  test("a hand-edited longer file is read whole (the render clips it); a hand edit has no history line", () => {
    const lines = orgs.readOrgHistory(org.id).length;
    writeFileSync(join(dir, "about.md"), "h".repeat(4100));
    assert.equal(orgs.readOrgAbout(org.id).length, 4100);
    assert.equal(orgs.readOrgHistory(org.id).length, lines);
  });

  test("a PATCH names only name and about: anything else in the body is ignored", async () => {
    assert.equal((await call("PATCH", "", { name: "About Co Ltd", notes: "NEW-NOTES" })).status, 200);
    assert.ok(!JSON.stringify(await orgs.orgDetail(org.id)).includes("NEW-NOTES"));
    assert.equal(orgs.readOrg(org.id).name, "About Co Ltd");
  });

  test("the name alone leaves the text and its history alone", async () => {
    const before = historyText();
    const about = orgs.readOrgAbout(org.id);
    await orgs.patchOrg(org.id, { name: "About Co" });
    assert.equal(historyText(), before);
    assert.equal(orgs.readOrgAbout(org.id), about);
  });
});
