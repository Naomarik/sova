import { readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { keepSecrets } from "../overseer-deny";
import { agentRoot, stateRoot } from "../state-root";
import { defaultSenderHome, piDefaultSenderHome, readOutreach } from "./settings";

/**
 * The sender's credentials are secret (§app.outreach/secrets): the directories and files the
 * Overseer's file tools deny (server/overseer-deny.ts reads these at every tool call, so a path is
 * covered from the next call after it is configured), and whether sandboxed agents are kept out.
 */

/** Directories: the default sender home, pi's default one, the configured auth dir. */
export function outreachSecretDirs(agentDir = agentRoot(), home = homedir()): string[] {
  const dirs = [defaultSenderHome(), join(home, ".pi", "agent", "sova", "whatsapp"), join(agentDir, "sova", "whatsapp"), piDefaultSenderHome()];
  const f = readOutreach();
  for (const d of [f.authDir, f.senderAuthDir]) if (d) dirs.push(d);
  return [...new Set(dirs.map((d) => resolve(d)))];
}

/** Files: this host's outreach setting and its receipts. */
export const outreachSecretFiles = (state = stateRoot()): string[] => [join(state, "outreach.json"), join(state, "outreach-receipts.json")];

// The Overseer's file tools deny them (server/overseer-deny.ts); the project layer never imports outreach.
keepSecrets({ files: outreachSecretFiles, dirs: outreachSecretDirs });

const within = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);

/** The sandbox policy's hidden paths as they resolve here ($AGENT_DIR and ~ expanded). */
function sandboxHidden(agentDir = agentRoot(), home = homedir()): string[] | null {
  const os = platform() === "darwin" ? "darwin" : "linux";
  for (const f of [join(agentDir, "sandbox-policy", os, "policy.json"), join(agentDir, "sandbox-policy", "policy.json")]) {
    try {
      const raw = JSON.parse(readFileSync(f, "utf8")) as { hidden?: unknown };
      if (!Array.isArray(raw.hidden)) continue;
      return raw.hidden
        .filter((h): h is string => typeof h === "string")
        .map((h) => resolve(h.replace(/^\$AGENT_DIR/, agentDir).replace(/^~(?=\/|$)/, home)));
    } catch {
      // next candidate
    }
  }
  return null;
}

/** A warning when the sender's auth directory is not hidden from sandboxed agents; null when it is, or unknown. */
export function sandboxWarning(authDir: string | undefined = readOutreach().senderAuthDir ?? readOutreach().authDir): string | null {
  const dir = resolve(authDir ?? join(defaultSenderHome(), "auth"));
  const hidden = sandboxHidden();
  if (!hidden) return null;
  if (hidden.some((h) => within(dir, h) || within(dirname(dir), h))) return null;
  return `Sandboxed agents can still read ${dir}: add it to "hidden" in the sandbox policy. Only the Overseer's file tools are kept out of it now.`;
}
