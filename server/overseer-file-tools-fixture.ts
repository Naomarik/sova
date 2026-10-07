import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { overseerFileTools } from "./overseer-file-tools";
import { EXCLUDED_REFUSAL, outsideRootRefusal, RootConfinement, SECRET_REFUSAL, SecretGuard, secretRules } from "./overseer-deny";

/**
 * Tests only (nothing in the server imports this): the fake home of overseer-file-tools.test.ts and
 * its integration sibling (whose cases run the real rg and fd). One file per denied class, the
 * neighbours that must stay readable, and links that lead to secrets; every file holds TOKEN.
 * `dispose` removes it.
 */
export function secretBox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-overseer-deny-")));
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
  return { root, home, agentDir, project, put, SECRETS, ALLOWED, HARD_LINKS, guard, call, refused, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * The project overseer's box inside a secretBox: <box>/proj is the root; <box>/org is the org's
 * workspace beside it, <box>/proj/ws another one the root happens to hold, <box>/state Sova's
 * state. Every file holds MARK.
 */
export function confinedBox({ root, home, put, guard }: ReturnType<typeof secretBox>) {
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
  const ptools = Object.fromEntries(overseerFileTools(proot, guard, undefined, () => new RootConfinement(proot, [orgWs, innerWs, state])).map((t) => [t.name, t]));
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
  return { box, proot, orgWs, innerWs, state, IN, OUT, pcall, outside, excluded };
}
