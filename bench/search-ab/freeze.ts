// freeze: the manifest of the frozen copy, its offline listing and the project list (plan.md, The
// dataset). Reads only the copy; writes only the private folder (and removes the empty `{}` stubs
// the pi SDK leaves in the copy's root when the listing loads it).
//
//   bun bench/search-ab/freeze.ts [--copy <agent dir>] [--private <dir>] [--copied-at <iso>]
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { copyDir, idOfFile, opt, OVERSEER_DIR, privateDir, ROOT, sha256, writeJson } from "./common";

const args = process.argv.slice(2);
const COPY = copyDir(args);
const PRIV = privateDir(args);
process.env.PI_CODING_AGENT_DIR = COPY; // before sessions-index computes its paths

/** Every session file of the copy: the pi sessions dir (no live/), project and organization chats. */
export function copyFiles(copy: string): string[] {
  const out: string[] = [];
  const jsonlIn = (d: string) => {
    try {
      for (const f of readdirSync(d)) if (f.endsWith(".jsonl")) out.push(join(d, f));
    } catch {}
  };
  for (const d of readdirSync(join(copy, "sessions"), { withFileTypes: true })) if (d.isDirectory() && d.name !== "live") jsonlIn(join(copy, "sessions", d.name));
  for (const root of ["projects", "workspaces"]) {
    const base = join(copy, "sova", root);
    let names: string[] = [];
    try {
      names = readdirSync(base);
    } catch {}
    for (const n of names) jsonlIn(join(base, n, "sessions"));
  }
  return out.sort();
}

const LISTS = ["archived-sessions.json", "session-titles.json", "overseer-state.json", "web-sessions.json"];

async function main(): Promise<void> {
  const t0 = Date.now();
  const files = copyFiles(COPY);
  const copiedAt = opt(args, "copied-at") ?? readFileSync(join(ROOT, ".cache", "search-ab", "copytime"), "utf8").split("\n")[0]!.trim();
  const entries = files.map((p) => {
    const st = statSync(p);
    return { rel: relative(COPY, p), size: st.size, mtimeMs: Math.round(st.mtimeMs), sha256: sha256(readFileSync(p)) };
  });
  for (const l of LISTS) {
    const p = join(COPY, "sova", l);
    const st = statSync(p);
    entries.push({ rel: relative(COPY, p), size: st.size, mtimeMs: Math.round(st.mtimeMs), sha256: sha256(readFileSync(p)) });
  }
  const datasetHash = sha256(entries.map((e) => `${e.rel}\t${e.size}\t${e.sha256}`).sort().join("\n"));
  const bytes = entries.reduce((a, e) => a + e.size, 0);
  writeJson(join(PRIV, "manifest.json"), { copiedAt, frozenAt: new Date().toISOString(), datasetHash, files: entries.length, sessions: files.length, bytes, entries });
  console.log(`manifest: ${entries.length} files (${files.length} sessions), ${(bytes / 1e9).toFixed(2)} GB, dataset ${datasetHash.slice(0, 12)} (${Date.now() - t0} ms)`);

  // The listing, by Sova's own code over the copy.
  const { listSessions } = await import("../../server/sessions-index");
  const { WorkerSessions } = await import("../../server/worker-sessions");
  const rows = await listSessions();
  for (const stub of ["auth.json", "models-store.json"]) {
    const p = join(COPY, stub);
    try {
      if (readFileSync(p, "utf8").trim() === "{}") rmSync(p);
    } catch {}
  }
  // Worker refs by absolute path name the REAL folder; map them by file name (plan.md, The listing).
  const byName = new Map(files.map((p) => [basename(p), p]));
  const byId = new Map(files.map((p) => [idOfFile(basename(p)), p]));
  const ws = new WorkerSessions({ idOf: (p) => idOfFile(basename(p)), live: () => [] });
  await ws.refresh(files);
  const workerPaths = new Set<string>();
  for (const [p, e] of ws.entries) {
    if (e.self) workerPaths.add(p);
    for (const r of e.refs) {
      const hit = r.includes("/") ? byName.get(basename(r)) : byId.get(r);
      if (hit) workerPaths.add(hit);
    }
  }
  // Projects: the newest sova_projects result in the Overseer's own logs (id, name, root).
  const projects = new Map<string, Project>();
  for (const f of files.filter((p) => relative(COPY, p).startsWith(`sessions/${OVERSEER_DIR}/`)).sort()) {
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (!line.includes('"toolName":"sova_projects"')) continue;
      const text: string = JSON.parse(line).message?.content?.[0]?.text ?? "";
      for (const m of text.matchAll(/^- (.+?) \((prj_[a-z0-9]+)\) · in (no organization|.+? \((org_[a-z0-9]+)\)) · root (\S+)$/gm))
        projects.set(m[2]!, { id: m[2]!, name: m[1]!, root: m[5]!, ...(m[4] ? { orgId: m[4] } : {}) });
    }
  }
  writeJson(join(PRIV, "projects.json"), [...projects.values()]);
  console.log(`projects: ${projects.size}`);
  const listed = new Map(rows.map((r) => [r.path, r]));
  const out = [];
  const skip: Record<string, number> = {};
  for (const p of files) {
    const r = listed.get(p);
    const rel = relative(COPY, p);
    const build = r ? buildOf(r.cwd, [...projects.values()]) : null;
    const why =
      rel.startsWith("sova/projects/") ? "project-chat"
      : rel.startsWith("sova/workspaces/") ? "org-chat"
      : r?.overseer || rel.startsWith(`sessions/${OVERSEER_DIR}/`) ? "overseer"
      : r?.projectOverseer ? "project-overseer"
      : r?.org ? "org"
      : r?.baton ? "baton"
      : r?.workerSession || workerPaths.has(p) ? "worker"
      : build?.orgId ? "org-build"
      : null;
    if (why) skip[why] = (skip[why] ?? 0) + 1;
    out.push({
      id: idOfFile(basename(p)),
      rel,
      listed: !!r,
      cwd: r?.cwd ?? "",
      project: r?.project?.projectId ?? build?.id ?? null,
      createdAt: r?.createdAt ?? null,
      lastActiveAt: r?.lastActiveAt ?? null,
      title: r?.title ?? null,
      originalTitle: r?.originalTitle ?? null,
      outlineGist: r?.outlineGist ?? null,
      outlineNow: r?.outlineNow ?? null,
      outlineTopics: r?.outlineTopics ?? null,
      outlineAt: r?.outlineAt ?? null,
      archived: !!r?.archived,
      skipped: why,
    });
  }
  writeJson(join(PRIV, "listing.json"), { frozenAt: new Date().toISOString(), rows: out });
  console.log(`listing: ${rows.length} listed of ${files.length} files; skipped from the overview: ${JSON.stringify(skip)}`);

  process.exit(0);
}

export interface Project {
  id: string;
  name: string;
  root: string;
  orgId?: string;
}

/** The project whose build `cwd` is, by Sova's worktree naming (`<root's parent>/.worktrees/<root's
    name>-…`), or null. Offline stand-in for the engine's coding builds (plan.md, The listing). */
export function buildOf(cwd: string, projects: readonly Project[]): Project | null {
  for (const p of projects) {
    const root = p.root.replace(/\/+$/, "");
    const at = root.lastIndexOf("/");
    if (cwd.toLowerCase().startsWith(`${root.slice(0, at)}/.worktrees/${root.slice(at + 1)}-`.toLowerCase())) return p;
  }
  return null;
}

if (import.meta.main) await main();
