import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { stateRoot } from "./state-root";

/** What the Overseer's read/grep/find/ls answer for a secret file. */
export const SECRET_REFUSAL = "That file holds credentials; the Overseer can't read it.";

/** Secret places another part of Sova keeps (the outreach sender's credentials, §app.outreach/secrets). */
interface KeptSecrets {
  files(state: string): string[];
  dirs(agentDir: string, home: string): string[];
}
const kept: KeptSecrets[] = [];
export function keepSecrets(s: KeptSecrets): void {
  kept.push(s);
}

/**
 * THE list of what the Overseer's read/grep/find/ls never read, list or match (overseer-file-tools.ts
 * applies it). Everything else on the machine stays readable. Change it here and only here; the
 * prompt (overseer-prompt.md) names every entry, and a test holds it to that.
 *
 * Three layers, each checked at the path as written and at its realpath:
 * - `namesUnder`, `files`, `dirs`: the places pi, Claude Code and the usual tools keep credentials.
 * - `names`: file names that hold credentials wherever they are, so a copy (another worktree's
 *   `.agent/auth.json`, a `.credentials.json.mtn` backup) is denied like the original.
 * - hard links: any file with the same (device, inode) as one of `files` (SecretGuard).
 *
 * A fixed file is denied at its own path and at its symlink target, so `~/.pi/agent/models.json`
 * also denies the file it links to.
 *
 * The outreach sender's credentials are the outreach part's to name: server/outreach/protected-paths.ts
 * adds them (keepSecrets) when it loads, which the server does at startup.
 */
export function secretRules(home = homedir(), agentDir = getAgentDir(), state = stateRoot()) {
  const piRoots = [join(home, ".pi"), agentDir];
  return {
    /** File names that are secret at any depth under these roots. `models.json`: pi's model
        registry, whose `apiKey` and `headers` may be a literal key, `$ENV` or a `!command`. */
    namesUnder: { names: ["models.json"], roots: piRoots },
    /** Single files (with their symlink targets, and hard links to them). */
    files: [
      // The ones pi actually reads: named here so their symlink targets and hard links are denied too.
      ...[join(home, ".pi", "agent"), agentDir].flatMap((d) => ["auth.json", "models.json"].map((n) => join(d, n))),
      // Claude Code's OAuth tokens.
      join(home, ".claude", ".credentials.json"),
      // Claude Code's account record: `primaryApiKey` after an API-key login.
      join(home, ".claude.json"),
      // Plain-text logins for curl, git and ftp.
      join(home, ".netrc"),
      // The GitHub CLI's tokens. (`targets.json` names SSH key *paths*, denied below, so it stays readable.)
      join(home, ".config", "gh", "hosts.yml"),
      // Sova's link stores: every hand-off link's and owner link's token hash (§app.overseer/tools).
      join(state, "baton-links.json"),
      join(state, "person-links.json"),
      // The main listener's per-install token (§app.access/token): whoever has it has the app.
      ...[join(home, ".pi", "agent"), agentDir].map((d) => join(d, "sova", "auth-token")),
      // The outreach setting and its receipts (§app.outreach/secrets).
      ...kept.flatMap((k) => k.files(state)),
    ],
    /** Whole directories: nothing inside is read, listed or matched. */
    dirs: [
      // SSH keys, GnuPG keys, AWS credentials.
      join(home, ".ssh"),
      join(home, ".gnupg"),
      join(home, ".aws"),
      // Claude Code's backups (of `.claude.json`, which may hold `primaryApiKey`).
      join(home, ".claude", "backups"),
      // Every process's environment, memory and command line (`/proc/self/environ` is the server's
      // own environment), and the kernel's: nothing the Overseer needs.
      "/proc",
      "/sys",
      // The reading process's open files, the server's own: on Linux `/dev/fd` resolves into
      // `/proc`, but on macOS it is its own file system, and `/dev/stdin` and the like resolve here.
      "/dev/fd",
      // The WhatsApp sender's home and its auth directory, wherever configured (§app.outreach/secrets).
      ...kept.flatMap((k) => k.dirs(agentDir, home)),
    ],
    /** File names that are secret anywhere; `name` is how the prompt names each. */
    names: [
      // pi's stored provider keys, every copy (each isolated agent dir holds one) and its backups.
      { name: "auth.json", test: (n: string) => n === "auth.json" || n.startsWith("auth.json.") },
      // Claude Code's account record (`primaryApiKey`) and its backups (`.claude.json.backup`).
      { name: ".claude.json", test: (n: string) => n === ".claude.json" || n.startsWith(".claude.json.") },
      // Claude Code's `.credentials.json` and its backups (`.credentials.json.mtn`), `~/.aws/credentials`, and the like.
      { name: "credentials", test: (n: string) => n.toLowerCase().includes("credentials") },
      // Environment files, except the documented templates.
      { name: ".env", test: isEnvFile },
      // SSH private keys (`id_ed25519`, `id_rsa`); the `.pub` half is public.
      { name: "id_*", test: (n: string) => n.startsWith("id_") && !n.endsWith(".pub") },
      // Certificates' private keys and key stores.
      ...[".pem", ".key", ".p12", ".pfx"].map((ext) => ({ name: ext, test: (n: string) => n.toLowerCase().endsWith(ext) })),
      // Plain-text logins for curl/git and for PostgreSQL.
      { name: ".netrc", test: (n: string) => n === ".netrc" },
      { name: ".pgpass", test: (n: string) => n === ".pgpass" },
    ],
  };
}

export type SecretRules = ReturnType<typeof secretRules>;

/** `.env` / `.env.*`, except the documented templates. */
export function isEnvFile(name: string): boolean {
  if (name === ".env") return true;
  return name.startsWith(".env.") && name !== ".env.example" && name !== ".env.sample";
}

/** The realpath of `p`, or of its longest existing ancestor with the rest appended (a path that
    doesn't exist yet still resolves through a symlinked parent). */
export function realpathLoose(p: string): string {
  const abs = resolve(p);
  const rest: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      return join(realpathSync(cur), ...rest.reverse());
    } catch {
      const up = dirname(cur);
      if (up === cur) return abs;
      rest.push(basename(cur));
      cur = up;
    }
  }
}

const within = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);

/**
 * Answers "is this path secret?" for one tool call. A path is checked both as written (resolved,
 * so `..` is gone) and at its realpath (so a symlink can't reach a secret under another name);
 * each rule's own paths are taken both ways too. A file that is one of the fixed files under
 * another name (a hard link: same device and inode) is secret too.
 */
export class SecretGuard {
  private readonly dirs: string[];
  private readonly files: Set<string>;
  private readonly underNames: Set<string>;
  private readonly roots: string[];
  private readonly names: ((n: string) => boolean)[];
  /** `dev:ino` of each fixed file that exists (read once per guard, i.e. once per tool call). */
  private readonly inodes = new Set<string>();
  constructor(rules: SecretRules = secretRules()) {
    const both = (p: string) => [...new Set([resolve(p), realpathLoose(p)])];
    this.dirs = rules.dirs.flatMap(both);
    this.files = new Set(rules.files.flatMap(both));
    this.underNames = new Set(rules.namesUnder.names);
    this.roots = rules.namesUnder.roots.flatMap(both);
    this.names = rules.names.map((r) => r.test);
    for (const f of rules.files) {
      try {
        const st = statSync(f, { throwIfNoEntry: false });
        if (st?.isFile()) this.inodes.add(`${st.dev}:${st.ino}`);
      } catch {
        // unreadable parent: nothing to compare against
      }
    }
  }
  /** Whether `p` (absolute) is a secret file, or inside a secret directory. */
  isSecret(p: string): boolean {
    for (const c of new Set([resolve(p), realpathLoose(p)])) {
      const name = basename(c);
      if (this.names.some((t) => t(name))) return true;
      if (this.files.has(c)) return true;
      if (this.dirs.some((d) => within(c, d))) return true;
      if (this.underNames.has(name) && this.roots.some((r) => within(c, r))) return true;
    }
    if (this.inodes.size) {
      let st;
      try {
        st = statSync(p, { throwIfNoEntry: false });
      } catch {
        st = undefined;
      }
      if (st?.isFile() && st.nlink > 1 && this.inodes.has(`${st.dev}:${st.ino}`)) return true;
    }
    return false;
  }
  /** Throw the refusal for a secret path. */
  check(p: string): void {
    if (this.isSecret(p)) throw new Error(SECRET_REFUSAL);
  }
}

/** What the Overseer's read/grep/find/ls answer for a path in an attached organization's workspace. */
export const WORKSPACE_REFUSAL = "That folder is an organization's workspace; read it with sova_orgs and sova_read_session.";

/**
 * The Overseer's guard: the secret files, and every attached organization's workspace directory as a
 * whole (its roster and history with every contact, the About text, the hand-off transcripts, the
 * overseers' state; §app.overseer/tools). The workspaces are the ones attached when the call runs,
 * each taken as given and at its realpath, and every path both ways, so a symlink can't reach one;
 * a search or listing from a parent leaves them out.
 */
export class OverseerGuard extends SecretGuard {
  private readonly workspaces: string[];
  constructor(workspaces: readonly string[], rules: SecretRules = secretRules()) {
    super(rules);
    this.workspaces = workspaces.flatMap((w) => [...new Set([resolve(w), realpathLoose(w)])]);
  }
  /** Whether `p` is an attached workspace or inside one. */
  inWorkspace(p: string): boolean {
    return [resolve(p), realpathLoose(p)].some((c) => this.workspaces.some((w) => within(c, w)));
  }
  override isSecret(p: string): boolean {
    return this.inWorkspace(p) || super.isSecret(p);
  }
  override check(p: string): void {
    if (this.inWorkspace(p)) throw new Error(WORKSPACE_REFUSAL);
    super.check(p);
  }
}

/** What the project overseer's read/grep/find/ls answer for a path outside its project root. */
export const outsideRootRefusal = (root: string) => `That path is outside the project root ${root}; the project overseer reads only inside it.`;
/** …and for the org workspace or Sova's own state, even when the root holds them. */
export const EXCLUDED_REFUSAL = "That folder holds an organization's workspace or Sova's own state; the project overseer can't read it.";

/**
 * Confines one tool call to a root: a path is inside only if it is, both as written (resolved, so
 * `..` is gone) and at its realpath (so a symlink in the root can't lead out), under the root, and
 * under none of `excluded` (either way). The root and each excluded folder are taken both as given
 * and at their realpath.
 */
export class RootConfinement {
  private readonly roots: string[];
  private readonly excluded: string[];
  constructor(
    readonly root: string,
    excluded: string[] = [],
  ) {
    const both = (p: string) => [...new Set([resolve(p), realpathLoose(p)])];
    this.roots = both(root);
    this.excluded = excluded.flatMap(both);
  }
  /** Why `p` (absolute) may not be read, or null when it may. */
  problem(p: string): string | null {
    const forms = [resolve(p), realpathLoose(p)];
    if (!forms.every((c) => this.roots.some((r) => within(c, r)))) return outsideRootRefusal(this.root);
    if (forms.some((c) => this.excluded.some((d) => within(c, d)))) return EXCLUDED_REFUSAL;
    return null;
  }
  check(p: string): void {
    const why = this.problem(p);
    if (why) throw new Error(why);
  }
}
