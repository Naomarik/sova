// Run: npx tsx --test server/overseer-file-tools.test.ts (or npm test). Builds a fake home in the
// OS temp dir (removed after); the real home is never read.
import assert from "node:assert/strict";
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { overseerFileTools } from "./overseer-file-tools";
import { EXCLUDED_REFUSAL, isEnvFile, outsideRootRefusal, RootConfinement, SECRET_REFUSAL, SecretGuard, secretRules } from "./overseer-deny";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-overseer-deny-")));
after(() => rmSync(root, { recursive: true, force: true }));
const home = join(root, "home");
const agentDir = join(root, "isolated", ".agent");
const project = join(home, "proj");
const put = (p: string, text = "TOKEN=1 in a file\n") => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
};

// One file per denied class; every file, denied or not, holds the word TOKEN.
const SECRETS: Record<string, string> = {
  "pi auth.json": join(home, ".pi", "agent", "auth.json"),
  "pi auth.json, deeper": join(home, ".pi", "agent", "sub", "auth.json"),
  "pi models.json": join(home, ".pi", "agent", "models.json"),
  "agent-dir auth.json": join(agentDir, "auth.json"),
  "agent-dir models.json": join(agentDir, "models.json"),
  "claude credentials": join(home, ".claude", ".credentials.json"),
  "claude account": join(home, ".claude.json"),
  "ssh key": join(home, ".ssh", "id_ed25519"),
  "gnupg": join(home, ".gnupg", "private-keys-v1.d", "k.key"),
  "aws": join(home, ".aws", "credentials"),
  "netrc": join(home, ".netrc"),
  "gh hosts": join(home, ".config", "gh", "hosts.yml"),
  "sova access token": join(agentDir, "sova", "auth-token"),
  ".env": join(project, ".env"),
  ".env.local": join(project, "app", ".env.local"),
  // Copies the fixed paths miss (RETEST3 N6-R1): denied by name wherever they are.
  "another worktree's .agent/auth.json": join(root, "worktrees", "other", ".agent", "auth.json"),
  "an auth.json backup": join(home, "old", "auth.json.bak"),
  "claude credentials backup (.mtn)": join(home, ".claude", ".credentials.json.mtn"),
  "claude account backup": join(home, ".claude.json.backup"),
  "claude backups dir": join(home, ".claude", "backups", "claude.json.1"),
  "a *credentials* file": join(project, "deploy", "gcp-credentials.json"),
  "an ssh key outside ~/.ssh": join(project, "id_rsa"),
  ".pem": join(project, "certs", "server.pem"),
  ".key": join(project, "certs", "server.key"),
  ".p12": join(project, "certs", "store.p12"),
  ".pfx": join(project, "certs", "store.pfx"),
  ".pgpass": join(home, ".pgpass"),
  ".netrc elsewhere": join(project, ".netrc"),
};
const ALLOWED = [
  join(project, "src", "main.ts"),
  join(project, ".env.example"),
  join(project, ".env.sample"),
  join(home, ".pi", "agent", "settings.json"),
  join(home, ".claude", "settings.json"),
  join(home, ".config", "gh", "config.yml"),
  // Neighbours of the name patterns.
  join(project, "id_rsa.pub"),
  join(project, "src", "keyboard.ts"),
  join(project, "src", "auth.jsonc"),
  join(project, "src", "author.json"),
  join(root, "worktrees", "other", ".agent", "settings.json"),
];
for (const p of [...Object.values(SECRETS), ...ALLOWED]) put(p);
// A models.json the pi one links to (the repo's pi-config/models.json, here): denied at its target too.
put(join(root, "repo", "pi-config", "models.json"));
rmSync(SECRETS["pi models.json"]!);
symlinkSync(join(root, "repo", "pi-config", "models.json"), SECRETS["pi models.json"]!);
// Innocent-looking names that lead to secrets.
symlinkSync(join(home, ".ssh"), join(project, "keys"));
symlinkSync(SECRETS["pi auth.json"]!, join(project, "notes.txt"));
symlinkSync(SECRETS["claude account"]!, join(project, "src", "config.json"));
// A symlink to a copy (the copy's own name gives it away), and hard links to the fixed files under
// innocent names (only the inode does).
symlinkSync(SECRETS["another worktree's .agent/auth.json"]!, join(project, "copy-link.txt"));
linkSync(SECRETS["pi auth.json"]!, join(project, "hardlink.txt"));
linkSync(SECRETS["agent-dir auth.json"]!, join(root, "worktrees", "agent-hardlink.txt"));
const HARD_LINKS = [join(project, "hardlink.txt"), join(root, "worktrees", "agent-hardlink.txt")];

const guard = () => new SecretGuard(secretRules(home, agentDir));
const tools = Object.fromEntries(overseerFileTools(project, guard).map((t) => [t.name, t]));
async function call(name: string, params: Record<string, unknown>): Promise<string> {
  try {
    const r = await tools[name]!.execute("tc", params as never, undefined, undefined, undefined as never);
    return (r.content as { type: string; text?: string }[]).map((c) => c.text ?? `[${c.type}]`).join("");
  } catch (err) {
    return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
  }
}
const refused = `ERROR: ${SECRET_REFUSAL}`;

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

  test("find: a secret dir is refused, and a search from a parent never names a secret", async () => {
    assert.equal(await call("find", { pattern: "*", path: join(home, ".aws") }), refused);
    const all = await call("find", { pattern: "*", path: root });
    const found = new Set(all.split("\n").map((l) => l.replace(/\/$/, "")));
    for (const [what, p] of Object.entries(SECRETS)) assert.ok(!found.has(p.slice(root.length + 1)), `${what} in find output`);
    assert.doesNotMatch(all, /id_ed25519|credentials|hosts\.yml|\.netrc|k\.key|auth\.json(?!c)|\.claude\.json|hardlink|agent-hardlink|copy-link|\.pem|\.p12|\.pfx|\.pgpass|\/id_rsa$/m);
    assert.match(all, /id_rsa\.pub/);
    assert.match(all, /proj\/src\/main\.ts/);
    assert.match(all, /\.env\.example/);
    assert.match(await call("find", { pattern: "*.json", path: join(home, ".pi") }), /settings\.json/);
    assert.doesNotMatch(await call("find", { pattern: "auth.json", path: home }), /auth\.json/);
  });

  test("grep: a secret path is refused, and a recursive search from a parent returns no secret's lines", async () => {
    assert.equal(await call("grep", { pattern: "TOKEN", path: join(home, ".ssh") }), refused);
    assert.equal(await call("grep", { pattern: "TOKEN", path: SECRETS["claude account"] }), refused);
    assert.equal(await call("grep", { pattern: "TOKEN", path: join(project, "keys") }), refused, "a symlink to ~/.ssh");
    for (const from of [root, home, project, join(home, ".pi"), agentDir, join(root, "worktrees")]) {
      const out = await call("grep", { pattern: "TOKEN", path: from, context: from === home ? 1 : 0 });
      // The file each output line names (pi's "path:N: text" and "path-N- text").
      const files = new Set(out.split("\n").map((l) => resolve(from, /^(.*?)(?::|-)\d+(?::|-) /.exec(l)?.[1] ?? "")));
      for (const [what, p] of Object.entries(SECRETS)) assert.ok(!files.has(p), `${what} from ${from}: ${out}`);
      assert.doesNotMatch(out, /auth\.json(?!c)|models\.json|credentials|id_ed25519|hosts\.yml|\.netrc|\.env(\.local)?:|hardlink|copy-link|\.pem|\.key:|\.p12|\.pfx|\.pgpass|\.claude\.json|id_rsa:/, from);
    }
    const fromHome = await call("grep", { pattern: "TOKEN", path: home });
    assert.match(fromHome, /^proj\/src\/main\.ts:1: TOKEN=1 in a file$/m, "pi's own line format");
    assert.match(fromHome, /^proj\/\.env\.example:1:/m);
    assert.equal(await call("grep", { pattern: "TOKEN", path: agentDir }), "No matches found");
  });
});

describe("the project overseer's read/grep/find/ls stay inside the project root", () => {
  // <box>/proj is the root; <box>/org is the org's workspace beside it, <box>/proj/ws another one
  // the root happens to hold, <box>/state Sova's state. Every file holds MARK.
  const box = join(root, "confined");
  const proot = join(box, "proj");
  const orgWs = join(box, "org");
  const innerWs = join(proot, "ws");
  const state = join(box, "state");
  const IN = [join(proot, "README.md"), join(proot, "src", "a.ts")];
  const OUT = [join(orgWs, "roster.json"), join(box, "outside.txt"), join(innerWs, "roster.json"), join(state, "baton-links.json"), join(home, "AGENTS.md")];
  for (const p of [...IN, ...OUT]) put(p, "MARK here\n");
  put(join(proot, ".env"));
  symlinkSync(orgWs, join(proot, "org-link"));
  symlinkSync(join(box, "outside.txt"), join(proot, "notes.md"));
  symlinkSync(box, join(proot, "up"));
  const ptools = Object.fromEntries(
    overseerFileTools(proot, guard, undefined, () => new RootConfinement(proot, [orgWs, innerWs, state])).map((t) => [t.name, t]),
  );
  const pcall = async (name: string, params: Record<string, unknown>) => {
    try {
      const r = await ptools[name]!.execute("tc", params as never, undefined, undefined, undefined as never);
      return (r.content as { type: string; text?: string }[]).map((c) => c.text ?? `[${c.type}]`).join("");
    } catch (err) {
      return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
  };
  const outside = `ERROR: ${outsideRootRefusal(proot)}`;
  const excluded = `ERROR: ${EXCLUDED_REFUSAL}`;

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

  test("find: searches are held to the root, whatever the pattern", async () => {
    for (const p of ["..", "/", box, "org-link", "~"]) assert.equal(await pcall("find", { pattern: "*", path: p }), outside, p);
    assert.equal(await pcall("find", { pattern: "*", path: "ws" }), excluded);
    for (const pattern of ["*", "**/*", "roster.json", "../*", "/**", `${box}/**`, "**/outside.txt"]) {
      const out = await pcall("find", { pattern });
      assert.doesNotMatch(out, /roster\.json|outside\.txt|baton-links|AGENTS|\.env$/m, pattern);
    }
    assert.match(await pcall("find", { pattern: "*.ts" }), /src\/a\.ts/);
  });

  test("grep: searches are held to the root, whatever the path or glob", async () => {
    for (const p of ["..", "/", box, orgWs, "org-link", "notes.md", "~", "../outside.txt"]) assert.equal(await pcall("grep", { pattern: "MARK", path: p }), outside, p);
    assert.equal(await pcall("grep", { pattern: "MARK", path: "ws" }), excluded);
    for (const glob of [undefined, "**", "../**", "**/roster.json", "*.json"]) {
      const out = await pcall("grep", { pattern: "MARK", ...(glob ? { glob } : {}) });
      assert.doesNotMatch(out, /roster|outside|baton-links|AGENTS/, `glob ${glob}`);
    }
    const all = await pcall("grep", { pattern: "MARK" });
    assert.match(all, /^README\.md:1: MARK here$/m);
    assert.match(all, /^src\/a\.ts:1:/m);
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
