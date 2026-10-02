#!/usr/bin/env node
// oneshot-general-projects: the one-time conversion of live org state to project-layer ids (General
// Projects, slice A). THROWAWAY: run once with sova-runtime stopped, never wired into the server, deleted
// after the live run together with backup/restore-general-projects.mjs and general-projects-state.mjs.
//
//   node scripts/oneshot-general-projects.mjs --backup <backup dir> [--agent-dir <dir>] [--write] [--unit <unit>] [--port <live port>]
//
// 1. Refuses while Sova runs, when any journal dir is non-empty, or when an old and a new name exist side
//    by side (a half-converted state: restore the backup instead).
// 2. Backup: --backup names a backup-general-projects.mjs backup that must equal the current files, checked
//    SHA-256 for every file (so the backup is known and current). Not needed when there is nothing to do.
// 3. Renames the project, watch and build snapshots to `project/<p>`, `watch/<p>`, `build/<p>/<s>`, and
//    replaces the exact strings `project/<o>/<p>`, `watch/<o>/<p>`, `build/<o>/<p>/` in every .edn and every
//    log .jsonl of the org (workspace statecharts/ and <stateRoot>/statecharts/<o>/).
// 4. Removes the exact token `:org-id "<o>", ` from the project, watch and build snapshots.
// 5. Strips `orgId` from preview-links.json's records.
// 6. Commits each workspace: first whatever was uncommitted before ("Workspace changes before general
//    projects"), then the conversion ("General projects: project-layer ids").
// Without --write it prints the plan and changes nothing. A second run finds nothing to do and changes nothing.

import { chmodSync, existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { agentDirOf, assertStopped, git, manifestDiff, manifestOf, orgsOf, parseArgs, SOVA_IDENTITY, UNIT, LIVE_PORT } from "./general-projects-state.mjs";

const PROJECT_CHARTS = ["project", "watch", "build"];
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The sid a project-layer sid of org `o` becomes, or null when it isn't one. */
function newSid(sid, o) {
  const m = new RegExp(`^(project|watch|build)/${escape(o)}/(prj_[a-z0-9]+(?:/.*)?)$`).exec(sid);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** `text` with org `o`'s project-layer sids rewritten (the exact strings of notes §6.3). */
function rewriteSids(text, o) {
  const O = escape(o);
  return text
    .replace(new RegExp(`(?<![A-Za-z0-9_-])(project|watch)/${O}/(prj_[a-z0-9]+)(?![A-Za-z0-9_])`, "g"), "$1/$2")
    .replace(new RegExp(`(?<![A-Za-z0-9_-])build/${O}/(prj_[a-z0-9]+)/`, "g"), "build/$1/");
}

const ORG_TOKEN = (o) => `:org-id "${o}", `;

function filesUnder(dir, keep) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p, keep));
    else if (keep(e.name)) out.push(p);
  }
  return out.sort();
}

function writeKeepingMode(file, text) {
  const mode = statSync(file).mode & 0o777;
  const tmp = `${file}.oneshot-${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, file);
}

/** Everything the conversion would do, computed without writing. Throws a refusal. */
function plan(agentDir) {
  const stateRoot = join(agentDir, "sova");
  const orgs = orgsOf(stateRoot);
  const renames = []; // {from, to}
  const edits = new Map(); // file → new text
  const problems = [];

  const local = join(stateRoot, "statecharts");
  if (existsSync(local))
    for (const d of readdirSync(local, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const j = join(local, d.name, "journal");
      if (existsSync(j) && readdirSync(j).length) problems.push(`${j} is not empty: start and stop Sova once so it replays, then rerun`);
    }

  for (const { id: o, dir: ws } of orgs) {
    const roots = [join(ws, "statecharts"), join(local, o)];
    // 3. renames (and refuse old+new side by side)
    for (const root of roots)
      for (const chart of PROJECT_CHARTS) {
        const cdir = join(root, chart);
        if (!existsSync(cdir)) continue;
        for (const f of readdirSync(cdir)) {
          if (!f.endsWith(".edn")) continue;
          const sid = decodeURIComponent(f.slice(0, -4));
          const to = newSid(sid, o);
          if (!to) continue;
          const target = join(cdir, `${encodeURIComponent(to)}.edn`);
          if (existsSync(target)) problems.push(`both ${sid} and ${to} exist in ${cdir}: half converted? Restore the backup and rerun`);
          else renames.push({ from: join(cdir, f), to: target });
        }
      }
    // 3. sid strings in every .edn and log .jsonl; 4. the org token in project-layer snapshots
    for (const root of roots)
      for (const file of filesUnder(root, (n) => n.endsWith(".edn") || n.endsWith(".jsonl"))) {
        if (file.includes("/journal/")) continue;
        const before = readFileSync(file, "utf8");
        let after = rewriteSids(before, o);
        const chart = file.slice(root.length + 1).split("/")[0];
        if (PROJECT_CHARTS.includes(chart) && file.endsWith(".edn")) {
          after = after.split(ORG_TOKEN(o)).join("");
          if (after.includes(`:org-id "${o}"`)) problems.push(`${file} keeps an :org-id "${o}" that isn't followed by ", ": convert it by hand or extend this script`);
        }
        if (after !== before) edits.set(file, after);
      }
  }

  // 5. preview-links.json
  const links = join(stateRoot, "preview-links.json");
  if (existsSync(links)) {
    const store = JSON.parse(readFileSync(links, "utf8"));
    const records = Array.isArray(store.links) ? store.links.filter((l) => l && typeof l === "object" && "orgId" in l) : [];
    for (const l of records) delete l.orgId;
    if (records.length) edits.set(links, `${JSON.stringify(store, null, 2)}\n`);
  }
  return { orgs, renames, edits, problems };
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { "agent-dir": "value", backup: "value", write: "flag", unit: "value", port: "value" });
  const agentDir = agentDirOf(args);
  await assertStopped(agentDir, { unit: args.unit ?? UNIT, port: args.port ? Number(args.port) : LIVE_PORT });
  const p = plan(agentDir);
  if (p.problems.length) throw new Error(`refused:\n  ${p.problems.join("\n  ")}`);
  const dirty = p.orgs.filter((o) => git(o.dir, ["--no-optional-locks", "status", "--porcelain"]).length > 0);
  if (!p.renames.length && !p.edits.size) {
    console.log(`nothing to convert in ${agentDir}: already done.${dirty.length ? ` (uncommitted workspace changes left alone: ${dirty.map((o) => o.dir).join(", ")})` : ""}`);
    return;
  }

  // 2. a known, current backup
  if (!args.backup) throw new Error("--backup <dir> is required: take one with scripts/backup-general-projects.mjs first");
  const manifest = JSON.parse(readFileSync(join(resolve(args.backup), "manifest.json"), "utf8"));
  if (manifest.kind !== "pre-general-projects" || manifest.agentDir !== agentDir) throw new Error(`${args.backup} is not a pre-general-projects backup of ${agentDir}`);
  const diff = manifestDiff(manifest.files, manifestOf(manifest.roots));
  if (diff.length) throw new Error(`the files differ from the backup ${args.backup}. If an earlier run stopped part-way, restore that backup first; otherwise take a new one:\n  ${diff.join("\n  ")}`);

  console.log(`convert ${agentDir} (backup ${resolve(args.backup)} matches the current files)`);
  for (const r of p.renames) console.log(`  rename ${r.from.split("/").slice(-2).join("/")} → ${r.to.split("/").pop()}`);
  for (const f of p.edits.keys()) console.log(`  edit   ${f}`);
  if (!args.write) {
    console.log("dry run: nothing changed. Rerun with --write.");
    return;
  }

  const commit = (dir, message) => {
    git(dir, ["add", "-A"]);
    if (git(dir, ["--no-optional-locks", "status", "--porcelain"]).length) git(dir, ["-c", "commit.gpgsign=false", "-c", "gc.auto=0", "-c", "maintenance.auto=false", "commit", "-q", "--no-verify", "-m", message], SOVA_IDENTITY);
  };
  for (const o of dirty) commit(o.dir, "Workspace changes before general projects");
  // Edits first, at their old paths, then the renames: a crash in between leaves a state the side-by-side
  // check doesn't catch, so the backup stays the way back.
  for (const [file, text] of p.edits) writeKeepingMode(file, text);
  for (const r of p.renames) renameSync(r.from, r.to);
  for (const o of p.orgs) commit(o.dir, "General projects: project-layer ids");
  const again = plan(agentDir);
  if (again.renames.length || again.edits.size || again.problems.length) throw new Error("converted, but a second look still finds work: inspect before starting Sova");
  console.log(`converted: ${p.renames.length} snapshots renamed, ${p.edits.size} files edited, workspaces committed`);
}

main().catch((err) => {
  console.error(`oneshot-general-projects: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
