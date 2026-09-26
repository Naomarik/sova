// Run: pnpm exec tsx --test server/orgs.test.ts. A throwaway PI_CODING_AGENT_DIR and workspace
// dirs in the OS temp dir, deleted after; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { PROFILE_FIELDS, type ChangeWriter, type ProfileField } from "../shared/orgs";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-orgs-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sessions"), { recursive: true });

const orgs = await import("./orgs");
const { resolveSessionPath } = await import("./paths");
const { settled } = await import("./workspace-git");

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

  test("the field-authority table: every writer × every field", () => {
    const allowed: Record<ChangeWriter, ProfileField[]> = {
      operator: [...PROFILE_FIELDS],
      wrapup: ["skills", "competence", "language", "voice"],
      overseer: ["skills", "competence", "language", "voice"],
      referral: [],
    };
    for (const kind of ["operator", "wrapup", "overseer", "referral"] as ChangeWriter[])
      for (const field of PROFILE_FIELDS) {
        const p = orgs.addPerson(org.id, { name: `P ${kind} ${field}`, role: "r", contact: { email: "a@b.c" } });
        const before = orgs.readHistory(org.id).length;
        const patch = field === "name" ? { name: `${p.name} two` } : { [field]: VALUE[field] };
        const ok = allowed[kind].includes(field);
        if (ok) {
          orgs.applyChange(org.id, p.id, patch, { kind });
          assert.equal(orgs.readHistory(org.id).length, before + 1, `${kind} may write ${field}: one history line`);
        } else {
          assert.throws(() => orgs.applyChange(org.id, p.id, patch, { kind }), orgs.OrgError, `${kind} may not write ${field}`);
          assert.equal(orgs.readHistory(org.id).length, before, `a refused ${kind} change of ${field} appends nothing`);
        }
      }
  });

  test("a referral only creates a proposed person, and a proposed person must be complete", () => {
    const complete = { name: "Bob Ref", status: "proposed" as const, role: "Accountant", contact: { phone: "+1 555 010 0199" }, referral: { why: "Does the books", referredBy: "Tony" } };
    const bob = orgs.applyChange(org.id, null, complete, { kind: "referral", sessionId: "s1", quote: "ask Bob" });
    assert.equal(bob.status, "proposed");
    assert.throws(() => orgs.applyChange(org.id, null, { ...complete, name: "Active Ref", status: "active" }, { kind: "referral" }), /only create a proposed/);
    assert.throws(() => orgs.applyChange(org.id, bob.id, { role: "x" }, { kind: "referral" }), orgs.OrgError);
    for (const drop of ["contact", "role", "referral"] as const) {
      const partial: Record<string, unknown> = { ...complete, name: `Missing ${drop}` };
      delete partial[drop];
      assert.throws(() => orgs.addPerson(org.id, partial as never), /A proposed person needs/, `without ${drop}`);
    }
    assert.throws(() => orgs.addPerson(org.id, { ...complete, name: "No why", referral: { why: "", referredBy: "x" } }), /why they were referred/);
    // Making an active person proposed later is held to the same rule.
    const al = orgs.addPerson(org.id, { name: "Al", role: "r" });
    assert.throws(() => orgs.applyChange(org.id, al.id, { status: "proposed" }, { kind: "operator" }), /A proposed person needs/);
  });

  test("caps are refused, never cut", () => {
    assert.throws(() => orgs.addPerson(org.id, { name: "Long", voice: "x".repeat(301) }), /at most 300/);
    assert.throws(() => orgs.addPerson(org.id, { name: "Many", skills: Array.from({ length: 13 }, (_, i) => `s${i}`) }), /at most 12/);
    assert.throws(() => orgs.addPerson(org.id, { name: "Wide", decides: ["y".repeat(41)] }), /at most 40/);
    assert.throws(() => orgs.addPerson(org.id, { name: "Lang", language: "not a tag!" }), /BCP-47/);
  });

  test("revert writes a new change back to the old value, and history is never edited", () => {
    const p = orgs.addPerson(org.id, { name: "Rita", voice: "Warm." });
    orgs.applyChange(org.id, p.id, { voice: "Cold." }, { kind: "wrapup", sessionId: "s", quote: "q" });
    const change = orgs.readHistory(org.id, p.id).find((c) => c.field === "voice" && c.to === "Cold.")!;
    const before = readFileSync(join(dir, "roster-history.jsonl"), "utf8");
    const back = orgs.revertChange(org.id, p.id, change.at);
    assert.equal(back.voice, "Warm.");
    const after = readFileSync(join(dir, "roster-history.jsonl"), "utf8");
    assert.ok(after.startsWith(before), "appended only");
    const last = orgs.readHistory(org.id, p.id).at(-1)!;
    assert.deepEqual([last.field, last.from, last.to, last.revertOf, last.by.kind], ["voice", "Cold.", "Warm.", change.at, "operator"]);
  });

  test("prompt partition: contact never, steering only for the holder, redaction phrases ≥ 16 chars", () => {
    const p = orgs.addPerson(org.id, { name: "Tina", role: "IT", decides: ["servers"], skills: ["SQL", "Windows Server administration"], voice: "Short answers, please.", contact: { email: "tina@example.com" } });
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
});
