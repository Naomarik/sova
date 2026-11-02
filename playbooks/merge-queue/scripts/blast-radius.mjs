#!/usr/bin/env node
// Blast radius: which extra checks a branch's changed paths call for, each with its reason.
//
//   node blast-radius.mjs --base <rev> --tip <rev> [--repo <dir>] [--map <file>]
//   node blast-radius.mjs --changed <file of paths> [--map <file>]
//   git diff --name-only a...b | node blast-radius.mjs [--map <file>]
//
// Prints one JSON object: {"picks":[{"id","why","select"?}], "matched":{path:[rule index]}, "paths":n, "map"}.
// The map: --map, else the project's own .sova/playbooks/merge-queue/references/blast-radius.json
// (under --repo, default the current folder), else none (no picks: the project declared no map). It lists rules
// {paths:[glob], pick:{id, select?}, why}. A pick is listed once per id: the reasons of every rule
// that hit it are joined and their selections unioned. The output is a proposal for the merge thread,
// which reads the diff and may add or leave out picks before calling merge.extend; the queue's own
// required checks are never in it. Self-contained: no imports beyond node's own.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** A glob as a RegExp: `**` any depth (including none), `*` within one segment, `?` one character. */
export function globRe(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export function matches(globs, path) {
  return globs.some((g) => globRe(g).test(path));
}

/** The picks for `paths` under `map` ({rules}). */
export function blastRadius(paths, map) {
  const rules = Array.isArray(map?.rules) ? map.rules : [];
  const byId = new Map();
  const matched = {};
  rules.forEach((rule, i) => {
    const hits = paths.filter((p) => matches(rule.paths ?? [], p));
    if (!hits.length || !rule.pick?.id) return;
    for (const h of hits) (matched[h] ??= []).push(i);
    const why = `${rule.why} (${hits.slice(0, 3).join(", ")}${hits.length > 3 ? `, +${hits.length - 3} more` : ""})`;
    const prev = byId.get(rule.pick.id);
    if (!prev) {
      byId.set(rule.pick.id, { id: rule.pick.id, why, ...(rule.pick.select ? { select: [...rule.pick.select] } : {}) });
      return;
    }
    prev.why = `${prev.why}; ${why}`;
    if (rule.pick.select) prev.select = [...new Set([...(prev.select ?? []), ...rule.pick.select])];
  });
  return { picks: [...byId.values()], matched, paths: paths.length };
}

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function main(argv) {
  const repo = arg(argv, "--repo") ?? ".";
  const own = join(repo, ".sova", "playbooks", "merge-queue", "references", "blast-radius.json");
  const mapFile = arg(argv, "--map") ?? (existsSync(own) ? own : null);
  let map = { rules: [] };
  if (mapFile) {
    try {
      map = JSON.parse(readFileSync(mapFile, "utf8"));
    } catch (err) {
      process.stderr.write(`blast-radius: can't read the map ${mapFile}: ${err.message}\n`);
      return 2;
    }
  }
  let text;
  const base = arg(argv, "--base");
  const tip = arg(argv, "--tip");
  const changed = arg(argv, "--changed");
  if (base && tip) text = execFileSync("git", ["-C", repo, "diff", "--name-only", `${base}...${tip}`], { encoding: "utf8" });
  else if (changed) text = readFileSync(changed, "utf8");
  else text = readFileSync(0, "utf8");
  const paths = text.split("\n").map((l) => l.trim()).filter(Boolean);
  process.stdout.write(`${JSON.stringify({ ...blastRadius(paths, map), map: mapFile }, null, 2)}\n`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main(process.argv.slice(2));
