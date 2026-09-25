import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** What the Overseer's read/grep/find/ls answer for a secret file. */
export const SECRET_REFUSAL = "That file holds credentials; the Overseer can't read it.";

/**
 * THE list of what the Overseer's read/grep/find/ls never read, list or match (overseer-file-tools.ts
 * applies it). Everything else on the machine stays readable. Change it here and only here.
 *
 * - `auth.json` and `models.json` anywhere under `~/.pi` and under the active agent dir
 *   (`PI_CODING_AGENT_DIR`, e.g. an isolated `.agent`): pi's stored provider keys, and the model
 *   registry, whose `apiKey` and `headers` may be a literal key, `$ENV` or a `!command`.
 *   (`targets.json` names SSH key *paths*, which are denied below, so it stays readable.)
 * - Claude Code: `~/.claude/.credentials.json` (OAuth tokens) and `~/.claude.json` (the account
 *   record, which holds `primaryApiKey` after an API-key login).
 * - `~/.ssh`, `~/.gnupg`, `~/.aws` (whole directories), `~/.netrc`, `~/.config/gh/hosts.yml`.
 * - `.env` and `.env.*` files anywhere, except `.env.example` and `.env.sample`.
 *
 * A fixed file is denied at its own path and at its symlink target, so `~/.pi/agent/models.json`
 * also denies the file it links to.
 */
export function secretRules(home = homedir(), agentDir = getAgentDir()) {
  const piRoots = [join(home, ".pi"), agentDir];
  const namedUnderPi = ["auth.json", "models.json"];
  return {
    /** File names that are secret at any depth under these roots. */
    namesUnder: { names: namedUnderPi, roots: piRoots },
    /** Single files (with their symlink targets). */
    files: [
      // The ones pi actually reads: named here so their symlink targets are denied too.
      ...[join(home, ".pi", "agent"), agentDir].flatMap((d) => namedUnderPi.map((n) => join(d, n))),
      join(home, ".claude", ".credentials.json"),
      join(home, ".claude.json"),
      join(home, ".netrc"),
      join(home, ".config", "gh", "hosts.yml"),
    ],
    /** Whole directories: nothing inside is read, listed or matched. */
    dirs: [join(home, ".ssh"), join(home, ".gnupg"), join(home, ".aws")],
  };
}

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
 * each rule's own paths are taken both ways too.
 */
export class SecretGuard {
  private readonly dirs: string[];
  private readonly files: Set<string>;
  private readonly names: Set<string>;
  private readonly roots: string[];
  constructor(rules = secretRules()) {
    const both = (p: string) => [...new Set([resolve(p), realpathLoose(p)])];
    this.dirs = rules.dirs.flatMap(both);
    this.files = new Set(rules.files.flatMap(both));
    this.names = new Set(rules.namesUnder.names);
    this.roots = rules.namesUnder.roots.flatMap(both);
  }
  /** Whether `p` (absolute) is a secret file, or inside a secret directory. */
  isSecret(p: string): boolean {
    for (const c of new Set([resolve(p), realpathLoose(p)])) {
      if (isEnvFile(basename(c))) return true;
      if (this.files.has(c)) return true;
      if (this.dirs.some((d) => within(c, d))) return true;
      if (this.names.has(basename(c)) && this.roots.some((r) => within(c, r))) return true;
    }
    return false;
  }
  /** Throw the refusal for a secret path. */
  check(p: string): void {
    if (this.isSecret(p)) throw new Error(SECRET_REFUSAL);
  }
}
