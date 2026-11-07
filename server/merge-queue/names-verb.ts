/**
 * merge.names: the private-names interview's writes, Sova's own (the merge thread's sandbox can't write the state root,
 * nor read claude-accounts/, which the discovery scans for login emails). It runs the method's discover-names.mjs on the
 * project's names file, the one the queue keeps (ProjectQueue.names()), never a path the thread picks.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MergeNamesReport } from "../../shared/merge-queue";
import { runProc } from "./copy";

export interface NamesQueue {
  readonly root: string;
  readonly target: string;
  names(): { file: string; exists: boolean };
}

/** Run the names step for `q`. `script`: discover-names.mjs. Throws with the script's own words on a failure. */
export async function namesStep(q: NamesQueue, action: "discover" | "add" | "show", text: string | undefined, script: string, run = runProc): Promise<MergeNamesReport> {
  const file = q.names().file;
  const argv = [process.execPath, script, "--file", file, "--target", q.target, "--repo", q.root];
  let scratch: string | null = null;
  try {
    if (action === "show") argv.push("--show");
    if (action === "add") {
      scratch = mkdtempSync(join(tmpdir(), "sova-names-"));
      const list = join(scratch, "names.txt");
      writeFileSync(list, `${(text ?? "").trim()}\n`, { mode: 0o600 });
      argv.push("--add-file", list);
    }
    const r = await run(argv, { cwd: q.root, env: process.env as Record<string, string>, timeoutMs: 120_000 });
    if (r.code !== 0) throw new Error(`the names step failed: ${r.out.trim().split("\n").slice(-3).join(" ") || `exit ${r.code}`}`);
    const out = r.out.trim();
    const count = Number(/(\d+)\s+name/.exec(out)?.[1] ?? Number.NaN);
    return { action, summary: action === "show" ? "the list is below: show it only in this chat, only when the user asks for it" : out.slice(0, 4000), ...(Number.isFinite(count) ? { count } : {}), ...(action === "show" ? { list: out } : {}) };
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}
