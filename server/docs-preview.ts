import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DocsPreview } from "./ready-to-land";
import { draftsFingerprint } from "./spec-drafts-state";

/**
 * Sova's try of a head's drafts the way the landing will (§chat.worktrees/ready-to-land): readiness reads it for a
 * finished branch, and the merge queue for a branch sent back for its drafts (Land comes back at the same commit once
 * they read clean). One cache for both, per tree, head and drafts hash.
 */

const DRAFT_TOOL = join(dirname(fileURLToPath(import.meta.url)), "..", "pi-config", "extensions", "spec", "core", "sova-spec-draft.mjs");
const PREVIEW_TIMEOUT_MS = 60_000;
const previews = new Map<string, { result?: DocsPreview; waiters: (() => void)[] }>();

/** The draft tool's `land --commit <head>` without writing, in a process of its own (at most a minute), cached per
    tree, head, drafts hash and the drafts folder's content (notes included); a tool that fails or gives no answer is a problem, so a head never lands untried. */
export function previewDocs(dir: string, head: string, hash: string, done: () => void): DocsPreview | "pending" {
  // The drafts' hash leaves draft.json out (its notes and evidence): a fix that only records a note is tried again too.
  const key = `${dir}\n${head}\n${hash}\n${draftsFingerprint(dir) ?? ""}`;
  const hit = previews.get(key);
  if (hit?.result) return hit.result;
  if (hit) {
    hit.waiters.push(done);
    return "pending";
  }
  const entry: { result?: DocsPreview; waiters: (() => void)[] } = { waiters: [done] };
  previews.set(key, entry);
  if (previews.size > 300) previews.delete(previews.keys().next().value as string);
  execFile(process.execPath, [DRAFT_TOOL, "land", "--commit", head, "--by", "Sova's try at readiness", "--verification", "readiness preview", "--root", dir, "--json"],
    { timeout: PREVIEW_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, NO_COLOR: "1" } }, (err, stdout) => {
      entry.result = previewOf(String(stdout ?? ""), err);
      for (const w of entry.waiters.splice(0)) {
        try { w(); } catch {}
      }
    });
  return "pending";
}

/** land's JSON answer → what would land, or why not. */
export function previewOf(stdout: string, err?: unknown): DocsPreview {
  let j: { exit?: number; drafts?: { name?: string; added?: string[]; changed?: string[]; removed?: string[] }[]; findings?: { draft?: string | null; id?: string | null; code?: string; message?: string }[] } | null = null;
  try { j = JSON.parse(stdout); } catch {}
  if (!j || typeof j.exit !== "number") return { drafts: [], added: [], changed: [], problems: [`Sova couldn't try the drafts (${err instanceof Error ? err.message.split("\n")[0] : "the draft tool gave no answer"})`] };
  const drafts = (j.drafts ?? []).map((d) => String(d.name));
  const added = (j.drafts ?? []).flatMap((d) => d.added ?? []);
  const changed = (j.drafts ?? []).flatMap((d) => [...(d.changed ?? []), ...(d.removed ?? [])]);
  const problems = j.exit === 0 ? [] : (j.findings ?? []).map((f) => `${f.id ?? (f.draft ? `draft ${f.draft}` : f.code ?? "a draft")}${f.draft && f.id ? ` (draft ${f.draft})` : ""}: ${f.message ?? f.code ?? "refused"}`);
  return { drafts, added, changed, problems: j.exit !== 0 && !problems.length ? ["the draft tool refused the landing"] : problems };
}
