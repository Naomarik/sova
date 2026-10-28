// Run: npx tsx --test server/overseer-file-tools.test.ts (or npm test). Builds a fake home in the
// OS temp dir (removed after; server/overseer-file-tools-fixture.ts); the real home is never read.
// The refusals are checked here, before any program runs; what the real rg and fd return from a
// search is checked in overseer-file-tools.integration.test.ts.
import assert from "node:assert/strict";
import { existsSync, linkSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { after, describe, test } from "node:test";
import { type FileWrites, overseerFileTools } from "./overseer-file-tools";
import {
  EXCLUDED_REFUSAL,
  EXCLUDED_WRITE_REFUSAL,
  HARDLINK_WRITE_REFUSAL,
  isEnvFile,
  OverseerGuard,
  outsideRootWriteRefusal,
  RootConfinement,
  SECRET_WRITE_REFUSAL,
  type SecretGuard,
  secretRules,
  STATE_WRITE_REFUSAL,
  WORKSPACE_WRITE_REFUSAL,
} from "./overseer-deny";
import { confinedBox, secretBox } from "./overseer-file-tools-fixture";

const fx = secretBox();
after(fx.dispose);
const { root, home, project, put, SECRETS, ALLOWED, HARD_LINKS, guard, call, refused } = fx;
const cbox = confinedBox(fx);

describe("the secret list", () => {
  test(".env and .env.* are secret, the templates are not", () => {
    for (const n of [".env", ".env.local", ".env.production"]) assert.equal(isEnvFile(n), true, n);
    for (const n of [".env.example", ".env.sample", "env", ".envrc", "x.env"]) assert.equal(isEnvFile(n), false, n);
  });
  test("every class is secret, and none of the neighbours is", () => {
    const g = guard();
    for (const [what, p] of Object.entries(SECRETS)) assert.equal(g.isSecret(p), true, what);
    for (const p of ALLOWED) assert.equal(g.isSecret(p), false, p);
    assert.equal(g.isSecret(join(root, "repo", "pi-config", "models.json")), true, "the target pi's models.json links to");
    assert.equal(g.isSecret(home), false, "a parent of secrets is not itself secret");
    for (const p of HARD_LINKS) assert.equal(g.isSecret(p), true, `hard link ${p}`);
    assert.equal(g.isSecret(join(project, "copy-link.txt")), true, "a symlink to a copy");
    for (const p of ["/proc", "/proc/self/environ", "/proc/1/cmdline", "/sys/kernel", "/dev/fd/0"]) assert.equal(g.isSecret(p), true, p);
  });
});

describe("the Overseer's read/grep/find/ls never reach a secret", () => {
  test("read: each class by path, through `..`, and through a symlink, is refused", async () => {
    for (const [what, p] of Object.entries(SECRETS)) assert.equal(await call("read", { path: p }), refused, what);
    assert.equal(await call("read", { path: join(project, "..", ".ssh", "id_ed25519") }), refused, "..");
    assert.equal(await call("read", { path: "../.aws/credentials" }), refused, "relative ..");
    assert.equal(await call("read", { path: join(project, "keys", "id_ed25519") }), refused, "a symlinked dir");
    assert.equal(await call("read", { path: join(project, "notes.txt") }), refused, "a symlink to auth.json");
    assert.equal(await call("read", { path: join(project, "src", "config.json") }), refused, "a symlink to ~/.claude.json");
    assert.equal(await call("read", { path: join(project, "copy-link.txt") }), refused, "a symlink to another worktree's auth.json");
    for (const p of HARD_LINKS) assert.equal(await call("read", { path: p }), refused, `hard link ${p}`);
    for (const p of ["/proc/self/environ", "/proc/self/root/etc/hostname", "/proc/self/cmdline", "/sys/kernel/hostname"]) assert.equal(await call("read", { path: p }), refused, p);
    assert.equal(await call("ls", { path: "/proc/self" }), refused);
    assert.equal(await call("grep", { pattern: "PATH", path: "/proc/self/environ" }), refused);
    assert.equal(await call("find", { pattern: "environ", path: "/proc/self" }), refused);
  });

  test("read: an ordinary project file (and a .env.example) still reads", async () => {
    assert.match(await call("read", { path: join(project, "src", "main.ts") }), /TOKEN=1/);
    assert.match(await call("read", { path: "src/main.ts" }), /TOKEN=1/);
    assert.match(await call("read", { path: join(project, ".env.example") }), /TOKEN=1/);
  });

  test("ls: a secret dir is refused, and listings from a parent leave secrets and links to them out", async () => {
    assert.equal(await call("ls", { path: join(home, ".ssh") }), refused);
    assert.equal(await call("ls", { path: join(project, "keys") }), refused, "a symlink to ~/.ssh");
    assert.equal(await call("ls", { path: join(project, "..", ".gnupg") }), refused);
    const homeList = await call("ls", { path: home });
    for (const hidden of [".ssh", ".gnupg", ".aws", ".netrc", ".claude.json"]) assert.ok(!homeList.split("\n").some((l) => l.replace(/\/$/, "") === hidden), `${hidden} in: ${homeList}`);
    assert.match(homeList, /^proj\/$/m);
    assert.match(homeList, /^\.pi\/$/m);
    const projList = await call("ls", { path: project });
    assert.doesNotMatch(projList, /^(\.env|keys|notes\.txt|copy-link\.txt|hardlink\.txt|id_rsa|\.netrc)$/m);
    assert.match(projList, /^id_rsa\.pub$/m);
    assert.doesNotMatch(await call("ls", { path: join(root, "worktrees", "other", ".agent") }), /auth\.json/);
    assert.doesNotMatch(await call("ls", { path: join(home, ".claude") }), /credentials|backups/);
    assert.match(projList, /^\.env\.example$/m);
    const agent = await call("ls", { path: join(home, ".pi", "agent") });
    assert.doesNotMatch(agent, /auth\.json|models\.json/);
    assert.match(agent, /settings\.json/);
  });

  test("find: a secret dir is refused (the search itself: the integration file)", async () => {
    assert.equal(await call("find", { pattern: "*", path: join(home, ".aws") }), refused);
  });

  test("grep: a secret path is refused (the recursive search itself: the integration file)", async () => {
    assert.equal(await call("grep", { pattern: "TOKEN", path: join(home, ".ssh") }), refused);
    assert.equal(await call("grep", { pattern: "TOKEN", path: SECRETS["claude account"] }), refused);
    assert.equal(await call("grep", { pattern: "TOKEN", path: join(project, "keys") }), refused, "a symlink to ~/.ssh");
  });
});

describe("the project overseer's read/grep/find/ls read anywhere but other clients' work, Sova's and pi's state and secrets", () => {
  const { box, proot, orgWs, innerWs, state, client, exclusions, IN, pcall, outside, excluded, otherProject } = cbox;

  test("read: the root and the rest of the host read; every excluded folder is refused, by path, `..` and symlink", async () => {
    for (const p of IN) assert.match(await pcall("read", { path: p }), /MARK/, p);
    assert.match(await pcall("read", { path: "src/../README.md" }), /MARK/);
    for (const p of [join(box, "outside.txt"), "../outside.txt", "src/../../outside.txt", join(home, "AGENTS.md"), "notes.md", "up/outside.txt"])
      assert.match(await pcall("read", { path: p }), /MARK/, `outside the root: ${p}`);
    assert.equal(await pcall("read", { path: join(proot, ".env") }), refused, "still no secret");
    for (const p of [join(orgWs, "roster.json"), "../org/roster.json", "org-link/roster.json", "up/org/roster.json", "ws/roster.json", join(state, "baton-links.json"), "up/state/baton-links.json"])
      assert.equal(await pcall("read", { path: p }), excluded, p);
    for (const p of [join(client, "plan.md"), "../client/plan.md", "client-link/plan.md", "up/client/plan.md"]) assert.equal(await pcall("read", { path: p }), otherProject, p);
    for (const p of Object.values(SECRETS)) assert.equal(await pcall("read", { path: p }), refused, `secret ${p}`);
  });

  test("ls: a listing from a parent leaves the excluded folders and links to them out; an excluded folder is refused", async () => {
    const list = await pcall("ls", { path: "." });
    assert.match(list, /^README\.md$/m);
    assert.match(list, /^src\/$/m);
    assert.doesNotMatch(list, /^(ws|org-link|client-link|\.env)\/?$/m);
    const up = await pcall("ls", { path: ".." });
    assert.match(up, /^outside\.txt$/m);
    assert.match(up, /^proj\/$/m);
    assert.doesNotMatch(up, /^(org|state|client)\/?$/m);
    for (const p of [orgWs, "org-link", "ws", state]) assert.equal(await pcall("ls", { path: p }), excluded, p);
    for (const p of [client, "client-link"]) assert.equal(await pcall("ls", { path: p }), otherProject, p);
  });

  test("find and grep: an excluded folder is refused (searches from a parent: the integration file)", async () => {
    for (const name of ["find", "grep"] as const) {
      const args = (path: string) => (name === "find" ? { pattern: "*", path } : { pattern: "MARK", path });
      for (const p of [orgWs, "org-link", "ws", state]) assert.equal(await pcall(name, args(p)), excluded, `${name} ${p}`);
      for (const p of [client, "client-link"]) assert.equal(await pcall(name, args(p)), otherProject, `${name} ${p}`);
    }
  });

  test("held to the root (context files, writes): the same confinement without readAnywhere", () => {
    const rooted = new RootConfinement(proot, exclusions);
    assert.equal(rooted.problem(join(box, "outside.txt")), outside.slice("ERROR: ".length));
    assert.equal(rooted.problem(join(proot, "README.md")), null);
    assert.equal(rooted.problem(join(innerWs, "roster.json")), EXCLUDED_REFUSAL);
    const anywhere = new RootConfinement(proot, exclusions, [], { readAnywhere: true });
    assert.equal(anywhere.problem(join(box, "outside.txt")), null);
    assert.equal(anywhere.writeProblem(join(box, "outside.txt")), outsideRootWriteRefusal(proot), "a write stays in the root");
    assert.equal(anywhere.writeProblem(join(innerWs, "roster.json")), EXCLUDED_WRITE_REFUSAL);
  });

  test("read alone opens the conversation's own attachments folder, and nothing beside it", async () => {
    // <state>/attachments/<own> is this conversation's; <other> another's. Sova's state stays excluded.
    const atts = join(state, "attachments");
    const own = join(atts, "019a0000-0000-7000-8000-00000000000a");
    const other = join(atts, "019a0000-0000-7000-8000-00000000000b");
    // A 1×1 PNG.
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, "sova-shot.png"), png);
    put(join(own, "note.txt"), "MARK own\n");
    put(join(other, "sova-theirs.txt"), "MARK theirs\n");
    symlinkSync(join(box, "outside.txt"), join(own, "sova-link.txt"));
    symlinkSync(other, join(own, "sova-other"));
    const atools = Object.fromEntries(
      overseerFileTools(proot, guard, undefined, () => new RootConfinement(proot, exclusions, [own], { readAnywhere: true })).map((t) => [t.name, t]),
    );
    const acall = async (name: string, params: Record<string, unknown>) => {
      try {
        const r = await atools[name]!.execute("tc", params as never, undefined, undefined, undefined as never);
        return (r.content as { type: string; text?: string; mimeType?: string }[]).map((c) => c.text ?? `[${c.type} ${c.mimeType}]`).join("");
      } catch (err) {
        return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
      }
    };
    assert.match(await acall("read", { path: join(own, "note.txt") }), /MARK own/);
    assert.match(await acall("read", { path: join(own, "sova-shot.png") }), /\[image image\/png\]/, "an image comes back as an image");
    assert.match(await acall("read", { path: "README.md" }), /MARK/, "the root still reads");
    for (const p of [join(other, "sova-theirs.txt"), join(state, "baton-links.json"), join(own, "..", "..", "baton-links.json"), join(own, "..", basename(other), "sova-theirs.txt")])
      assert.equal(await acall("read", { path: p }), excluded, p);
    // A symlink in it that leads elsewhere is refused, wherever it leads.
    for (const p of [join(own, "sova-link.txt"), join(own, "sova-other", "sova-theirs.txt")]) assert.equal(await acall("read", { path: p }), excluded, `symlink ${p}`);
    // Only read: grep, find and ls never reach it.
    assert.equal(await acall("ls", { path: own }), excluded);
    assert.equal(await acall("find", { pattern: "*", path: own }), excluded);
    assert.equal(await acall("grep", { pattern: "MARK", path: own }), excluded);
    // Without the folder (as before), the same file is refused.
    assert.equal(await pcall("read", { path: join(own, "note.txt") }), excluded);
    // A root that holds Sova's state: the own folder wins over the exclusion, for read and itself alone.
    const wide = new RootConfinement(box, [state], [own]);
    assert.equal(wide.readProblem(join(own, "sova-shot.png")), null);
    assert.equal(wide.problem(join(own, "sova-shot.png")), EXCLUDED_REFUSAL, "grep/find/ls still refused");
    for (const p of [join(other, "sova-theirs.txt"), join(state, "baton-links.json"), join(own, "..", "x"), join(own, "sova-other", "sova-theirs.txt"), join(own, "sova-link.txt")])
      assert.equal(wide.readProblem(p), EXCLUDED_REFUSAL, p);
  });

  test("the main Overseer, given no root, still reads outside any project", async () => {
    assert.match(await call("read", { path: join(box, "outside.txt") }), /MARK/);
  });
});

/** write and edit, with a log and a switch for who started the run. `cwd` is where a relative path lands. */
function writeBox(opts: { cwd: string; guard: () => SecretGuard; protectedRoots: string[]; confine?: () => RootConfinement }) {
  const lines: Parameters<FileWrites["log"]>[0][] = [];
  let attended = true;
  const tools = Object.fromEntries(
    overseerFileTools(opts.cwd, opts.guard, undefined, opts.confine, {
      protectedRoots: () => opts.protectedRoots,
      attended: () => attended,
      unattended: "UNATTENDED",
      log: (l) => lines.push(l),
    }).map((t) => [t.name, t]),
  );
  const wcall = async (name: string, params: Record<string, unknown>) => {
    try {
      const r = await tools[name]!.execute("tc", params as never, undefined, undefined, undefined as never);
      return (r.content as { type: string; text?: string }[]).map((c) => c.text ?? `[${c.type}]`).join("");
    } catch (err) {
      return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
  };
  const raw = (name: string, params: Record<string, unknown>) => tools[name]!.execute("tc", params as never, undefined, undefined, undefined as never);
  return { wcall, raw, lines, setAttended: (v: boolean) => void (attended = v) };
}

describe("the Overseer's write and edit (§app.overseer/tools)", () => {
  const { agentDir } = fx;
  const state = join(agentDir, "sova");
  const ws = join(root, "orgs", "acme");
  put(join(state, "schedules.json"), "{}\n");
  put(join(state, "overseer.json"), "{}\n");
  put(join(agentDir, "settings.json"), "{}\n");
  put(join(ws, "roster.json"), "{}\n");
  const work = join(root, "work");
  put(join(work, "playbook.md"), "every day at 9\n");
  // Ordinary-looking names that lead into what no write may reach.
  symlinkSync(state, join(work, "state-link"));
  symlinkSync(join(state, "new-file.json"), join(work, "dangling.json"));
  symlinkSync(join(work, "dangling.json"), join(work, "dangling-2.json"));
  symlinkSync(ws, join(work, "ws-link"));
  // Two names for one ordinary file: neither is written (one could be Sova's under another name).
  put(join(work, "pair-a.txt"), "x\n");
  linkSync(join(work, "pair-a.txt"), join(work, "pair-b.txt"));
  const { wcall, raw, lines, setAttended } = writeBox({
    cwd: project,
    guard: () => new OverseerGuard([ws], secretRules(home, agentDir)),
    protectedRoots: [agentDir, state, join(home, ".pi")],
  });
  const err = (s: string) => `ERROR: ${s}`;

  test("writes and edits an ordinary file, creating folders; the log has the path and bytes, never the content", async () => {
    const target = join(work, ".sova", "automations", "merge-round.json");
    assert.match(await wcall("write", { path: target, content: '{"when":"9:00"}' }), /Successfully wrote/);
    assert.equal(readFileSync(target, "utf8"), '{"when":"9:00"}');
    assert.match(await wcall("edit", { path: join(work, "playbook.md"), edits: [{ oldText: "at 9", newText: "at 10" }] }), /Successfully/);
    assert.equal(readFileSync(join(work, "playbook.md"), "utf8"), "every day at 10\n");
    assert.deepEqual(lines.slice(-2), [
      { toolCallId: "tc", tool: "write", args: { path: target, bytes: 15 }, outcome: "ok" },
      { toolCallId: "tc", tool: "edit", args: { path: join(work, "playbook.md"), bytes: 16 }, outcome: "ok" },
    ]);
    assert.doesNotMatch(JSON.stringify(lines), /9:00|at 10/, "no content in the log");
  });

  test("never Sova's or pi's own state, an org's workspace, a secret or a hard-linked file: by path, `..`, symlink or dangling symlink", async () => {
    const before = readFileSync(join(state, "schedules.json"), "utf8");
    const cases: [string, string][] = [
      [join(state, "schedules.json"), STATE_WRITE_REFUSAL],
      [join(state, "overseer.json"), STATE_WRITE_REFUSAL],
      [join(state, "brand-new.json"), STATE_WRITE_REFUSAL],
      [join(agentDir, "settings.json"), STATE_WRITE_REFUSAL],
      [join(home, ".pi", "agent", "settings.json"), STATE_WRITE_REFUSAL],
      [join(work, "..", "isolated", ".agent", "sova", "schedules.json"), STATE_WRITE_REFUSAL],
      [join(work, "state-link", "schedules.json"), STATE_WRITE_REFUSAL],
      [join(work, "dangling.json"), STATE_WRITE_REFUSAL],
      [join(work, "dangling-2.json"), STATE_WRITE_REFUSAL],
      [join(ws, "roster.json"), WORKSPACE_WRITE_REFUSAL],
      [join(work, "ws-link", "roster.json"), WORKSPACE_WRITE_REFUSAL],
      [SECRETS[".env"]!, SECRET_WRITE_REFUSAL],
      [SECRETS["ssh key"]!, SECRET_WRITE_REFUSAL],
      [join(project, "notes.txt"), STATE_WRITE_REFUSAL],
      [join(project, "hardlink.txt"), SECRET_WRITE_REFUSAL],
      [join(work, "pair-b.txt"), HARDLINK_WRITE_REFUSAL],
    ];
    for (const [p, why] of cases) {
      assert.equal(await wcall("write", { path: p, content: "OVERWRITTEN" }), err(why), `write ${p}`);
      assert.equal(await wcall("edit", { path: p, edits: [{ oldText: "{}", newText: "OVERWRITTEN" }] }), err(why), `edit ${p}`);
    }
    assert.equal(readFileSync(join(state, "schedules.json"), "utf8"), before);
    assert.equal(existsSync(join(state, "new-file.json")), false, "the dangling link's target was never created");
    assert.equal(existsSync(join(state, "brand-new.json")), false);
    assert.equal(readFileSync(join(work, "pair-a.txt"), "utf8"), "x\n");
    const refused = lines.filter((l) => l.outcome === "refused");
    assert.ok(refused.length >= cases.length * 2);
    assert.ok(refused.every((l) => !("bytes" in l.args) && typeof l.args.path === "string"), "a refused call logs the path, no bytes");
  });

  test("a relative path lands in its own cwd: in Sova's state (the Overseer's), refused", async () => {
    const { wcall: scall } = writeBox({ cwd: join(state, "overseer"), guard: () => new OverseerGuard([], secretRules(home, agentDir)), protectedRoots: [agentDir, state] });
    assert.equal(await scall("write", { path: "notes.md", content: "x" }), err(STATE_WRITE_REFUSAL));
    assert.equal(existsSync(join(state, "overseer", "notes.md")), false);
  });

  test("in a run the user did not start, write and edit refuse, write nothing, and the refusal is logged", async () => {
    setAttended(false);
    try {
      const target = join(work, "unattended.json");
      assert.equal(await wcall("write", { path: target, content: "x" }), "ERROR: UNATTENDED");
      assert.equal(await wcall("edit", { path: join(work, "playbook.md"), edits: [{ oldText: "every", newText: "no" }] }), "ERROR: UNATTENDED");
      assert.equal(existsSync(target), false);
      assert.match(readFileSync(join(work, "playbook.md"), "utf8"), /^every/);
      assert.deepEqual(lines.at(-1), { toolCallId: "tc", tool: "edit", args: { path: join(work, "playbook.md") }, outcome: "refused", error: "UNATTENDED" });
    } finally {
      setAttended(true);
    }
  });

  test("an edit's failure that is no refusal is an error, logged as one", async () => {
    assert.match(await wcall("edit", { path: join(work, "playbook.md"), edits: [{ oldText: "not there", newText: "y" }] }), /^ERROR: /);
    assert.equal(lines.at(-1)!.outcome, "error");
  });

  test("their arguments reach the file as given; their results are redacted", async () => {
    // A key-shaped value is redacted in what comes back, never in what is written.
    const key = "sk-abcdefghijklmnop1234567890";
    const target = join(work, "keyed.txt");
    const out = await wcall("write", { path: target, content: `KEY ${key}\n` });
    assert.match(out, /Successfully/);
    assert.equal(readFileSync(target, "utf8"), `KEY ${key}\n`, "the content is written as given");
    const edited = JSON.stringify(await raw("edit", { path: target, edits: [{ oldText: `KEY ${key}`, newText: `OLD ${key}` }] }));
    assert.match(edited, /OLD \[redacted\]/, "the diff is in the result, redacted");
    assert.doesNotMatch(edited, new RegExp(key));
    assert.equal(readFileSync(target, "utf8"), `OLD ${key}\n`, "the match used the real text");
  });
});

describe("the project overseer's write and edit stay inside the project root", () => {
  const { box, proot, orgWs, innerWs, state } = cbox;
  const own = join(state, "attachments", "019a0000-0000-7000-8000-0000000000aa");
  put(join(own, "sova-shot.txt"), "MARK attached\n");
  const confine = () => new RootConfinement(proot, [orgWs, innerWs, state], [own]);
  const { wcall, setAttended } = writeBox({ cwd: proot, guard, protectedRoots: [orgWs, innerWs, state], confine });
  const out = `ERROR: ${outsideRootWriteRefusal(proot)}`;
  const excl = `ERROR: ${EXCLUDED_WRITE_REFUSAL}`;

  test("writes and edits inside the root; every way out is refused, and the attachments folder stays read-only", async () => {
    assert.match(await wcall("write", { path: ".sova/automations/a.json", content: "{}" }), /Successfully/);
    assert.equal(readFileSync(join(proot, ".sova", "automations", "a.json"), "utf8"), "{}");
    assert.match(await wcall("edit", { path: "README.md", edits: [{ oldText: "MARK here", newText: "MARK edited" }] }), /Successfully/);
    for (const p of ["../outside.txt", join(orgWs, "roster.json"), "org-link/roster.json", "notes.md", "up/outside.txt", "~/AGENTS.md", join(own, "sova-shot.txt"), join(own, "new.txt")])
      assert.equal(await wcall("write", { path: p, content: "OVERWRITTEN" }), out, p);
    assert.equal(await wcall("write", { path: "ws/roster.json", content: "OVERWRITTEN" }), excl, "a workspace inside the root");
    assert.equal(await wcall("edit", { path: join(own, "sova-shot.txt"), edits: [{ oldText: "MARK", newText: "X" }] }), out, "edit in the attachments folder");
    assert.equal(await wcall("write", { path: ".env", content: "X=1" }), `ERROR: ${SECRET_WRITE_REFUSAL}`, "still no secret inside the root");
    assert.equal(readFileSync(join(box, "outside.txt"), "utf8"), "MARK here\n");
    assert.equal(readFileSync(join(own, "sova-shot.txt"), "utf8"), "MARK attached\n");
    // A root that holds Sova's state: the attachments folder opens to read only, never to a write.
    const wide = new RootConfinement(box, [state], [own]);
    assert.equal(wide.readProblem(join(own, "sova-shot.txt")), null);
    assert.equal(wide.writeProblem(join(own, "sova-shot.txt")), EXCLUDED_WRITE_REFUSAL);
  });

  test("unattended, at any level, a write refuses", async () => {
    setAttended(false);
    try {
      assert.equal(await wcall("write", { path: "x.txt", content: "x" }), "ERROR: UNATTENDED");
      assert.equal(existsSync(join(proot, "x.txt")), false);
    } finally {
      setAttended(true);
    }
  });
});
