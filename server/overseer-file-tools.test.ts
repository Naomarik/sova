// Run: npx tsx --test server/overseer-file-tools.test.ts (or npm test). Builds a fake home in the
// OS temp dir (removed after); the real home is never read.
import assert from "node:assert/strict";
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { overseerFileTools } from "./overseer-file-tools";
import { isEnvFile, SECRET_REFUSAL, SecretGuard, secretRules } from "./overseer-deny";

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
