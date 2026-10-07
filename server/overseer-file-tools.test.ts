// Run: npx tsx --test server/overseer-file-tools.test.ts (or npm test). Builds a fake home in the
// OS temp dir (removed after; server/overseer-file-tools-fixture.ts); the real home is never read.
// The refusals are checked here, before any program runs; what the real rg and fd return from a
// search is checked in overseer-file-tools.integration.test.ts.
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { after, describe, test } from "node:test";
import { overseerFileTools } from "./overseer-file-tools";
import { EXCLUDED_REFUSAL, isEnvFile, RootConfinement } from "./overseer-deny";
import { confinedBox, secretBox } from "./overseer-file-tools-fixture";

const fx = secretBox();
after(fx.dispose);
const { root, home, project, put, SECRETS, ALLOWED, HARD_LINKS, guard, call, refused } = fx;

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

describe("the project overseer's read/grep/find/ls stay inside the project root", () => {
  const { box, proot, orgWs, innerWs, state, IN, pcall, outside, excluded } = confinedBox(fx);

  test("read: files in the root read; every way out is refused", async () => {
    for (const p of IN) assert.match(await pcall("read", { path: p }), /MARK/, p);
    assert.match(await pcall("read", { path: "src/a.ts" }), /MARK/);
    assert.match(await pcall("read", { path: "src/../README.md" }), /MARK/);
    assert.equal(await pcall("read", { path: join(proot, ".env") }), refused, "still no secret inside the root");
    for (const p of [join(orgWs, "roster.json"), join(box, "outside.txt"), join(state, "baton-links.json"), join(home, "AGENTS.md"), "/etc/hostname"])
      assert.equal(await pcall("read", { path: p }), outside, p);
    for (const p of ["../outside.txt", "../org/roster.json", "src/../../outside.txt", "~/AGENTS.md", "@../outside.txt"]) assert.equal(await pcall("read", { path: p }), outside, p);
    for (const p of ["org-link/roster.json", "notes.md", "up/outside.txt"]) assert.equal(await pcall("read", { path: p }), outside, `symlink ${p}`);
    assert.equal(await pcall("read", { path: "ws/roster.json" }), excluded, "a workspace inside the root");
  });

  test("ls: the root lists without the excluded and the escaping entries; nothing else lists", async () => {
    const list = await pcall("ls", { path: "." });
    assert.match(list, /^README\.md$/m);
    assert.match(list, /^src\/$/m);
    assert.doesNotMatch(list, /^(ws|org-link|notes\.md|up|\.env)\/?$/m);
    for (const p of ["..", orgWs, "/", "~", "org-link", "up", "../proj/.."]) assert.equal(await pcall("ls", { path: p }), outside, p);
    assert.equal(await pcall("ls", { path: "ws" }), excluded);
  });

  test("find: a path outside the root, or an excluded folder, is refused (searches from the root: the integration file)", async () => {
    for (const p of ["..", "/", box, "org-link", "~"]) assert.equal(await pcall("find", { pattern: "*", path: p }), outside, p);
    assert.equal(await pcall("find", { pattern: "*", path: "ws" }), excluded);
  });

  test("grep: a path outside the root, or an excluded folder, is refused (searches from the root: the integration file)", async () => {
    for (const p of ["..", "/", box, orgWs, "org-link", "notes.md", "~", "../outside.txt"]) assert.equal(await pcall("grep", { pattern: "MARK", path: p }), outside, p);
    assert.equal(await pcall("grep", { pattern: "MARK", path: "ws" }), excluded);
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
      overseerFileTools(proot, guard, undefined, () => new RootConfinement(proot, [orgWs, innerWs, state], [own])).map((t) => [t.name, t]),
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
      assert.equal(await acall("read", { path: p }), outside, p);
    for (const p of [join(own, "sova-link.txt"), join(own, "sova-other", "sova-theirs.txt")]) assert.match(await acall("read", { path: p }), /^ERROR: /, `symlink ${p}`);
    for (const p of [join(own, "..", "..", "..", "outside.txt"), join(home, "AGENTS.md"), "/etc/hostname"]) assert.equal(await acall("read", { path: p }), outside, p);
    // Only read: grep, find and ls stay in the root.
    assert.equal(await acall("ls", { path: own }), outside);
    assert.equal(await acall("find", { pattern: "*", path: own }), outside);
    assert.equal(await acall("grep", { pattern: "MARK", path: own }), outside);
    // Without the folder (as before), the same file is refused.
    assert.equal(await pcall("read", { path: join(own, "note.txt") }), outside);
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
