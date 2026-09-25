import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** What the Overseer's read/grep/find/ls answer for a secret file. */
export const SECRET_REFUSAL = "That file holds credentials; the Overseer can't read it.";

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
 */
export function secretRules(home = homedir(), agentDir = getAgentDir()) {
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
