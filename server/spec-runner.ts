// The one way Sova runs the spec tools it ships (`sova-spec.mjs`, read-only): a child process with an
// argument list, never a shell, `--json`, bounded by a timeout. Shared by the main-line look-up
// (server/spec-lookup.ts) and the coding chats' `spec` tool (server/spec-coding-tool.ts). Node builtins
// only: a chat process and a worker load it too.
import { execFile } from "node:child_process";
import { join } from "node:path";

export const SPEC_TOOL = join(import.meta.dirname, "..", "pi-config", "extensions", "spec", "core", "sova-spec.mjs");
const TOOL_TIMEOUT_MS = 10_000;

export type SpecToolRunner = (specRoot: string, args: string[]) => Promise<Record<string, any>>;
let runnerForTest: SpecToolRunner | null = null;
export function setSpecToolForTest(f: SpecToolRunner | null): void {
  runnerForTest = f;
}

/** `sova-spec.mjs <args> --root <specRoot> --json`, argv only. */
export function runSpecTool(specRoot: string, args: string[]): Promise<Record<string, any>> {
  if (runnerForTest) return runnerForTest(specRoot, args);
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [SPEC_TOOL, ...args, "--root", specRoot, "--json"], { timeout: TOOL_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, NO_COLOR: "1" } }, (err, stdout) => {
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`the spec tool failed${err ? `: ${err.message.split("\n")[0]}` : ""}`));
      }
    });
  });
}
