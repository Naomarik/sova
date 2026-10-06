// Scenario g's data and its pinned spec, with no side effects on import (agent-arm.mjs runs pi with the
// caller's real home, so it must not load the hermetic test environment that scenario-g.mjs loads).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DATA = JSON.parse(readFileSync(join(HERE, "data/comparisons.json"), "utf8"));
/** Source files the `where` rows read, archived from the pinned revision beside its spec. */
export const PINNED_SOURCES = ["server/chat-manager.ts", "shared/protocol.ts"];

/** `git archive <rev> .sova/spec` and PINNED_SOURCES (or just `paths`) from the checkout holding this harness, into `dest`. → dest */
export function extractPinned(dest, rev = DATA.pinned.rev, paths = [DATA.pinned.path, ...PINNED_SOURCES]) {
  const top = spawnSync("git", ["-C", HERE, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (top.status !== 0) throw new Error(`the harness is not in a Git checkout, so the pinned spec ${rev} can't be extracted`);
  const archive = spawnSync("git", ["-C", top.stdout.trim(), "archive", "--format=tar", rev, ...paths], { maxBuffer: 256 * 1024 * 1024 });
  if (archive.status !== 0) throw new Error(`git archive ${rev} ${DATA.pinned.path} failed: ${archive.stderr}`);
  const tar = spawnSync("tar", ["-x", "-C", dest], { input: archive.stdout });
  if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`);
  return dest;
}
