// Test-only, imported for its side effect, and FIRST: makes a throwaway agent dir in the OS temp dir and
// points PI_CODING_AGENT_DIR at it before any product module the test imports next is evaluated (ES
// modules evaluate in import order), so a path a module fixes at load (paths.ts SESSIONS_DIR) is the
// scratch one too, however the file was started. Never imported by product code.
//
//   import { scratchAgentDir, dropScratchAgentDir } from "../testing/scratch-agent-dir"; // first import
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The throwaway agent dir (canonical), with its `sova/` and `sessions/` folders made. */
export const scratchAgentDir = realpathSync(mkdtempSync(join(tmpdir(), "sova-agent-")));
mkdirSync(join(scratchAgentDir, "sova"), { recursive: true });
mkdirSync(join(scratchAgentDir, "sessions"), { recursive: true });
process.env.PI_CODING_AGENT_DIR = scratchAgentDir;

/** Removes the scratch agent dir; call it from the test's `after`. */
export function dropScratchAgentDir(): void {
  rmSync(scratchAgentDir, { recursive: true, force: true });
}
