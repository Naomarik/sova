#!/usr/bin/env node
// One-command backup of this install's Sova state and conversations (docs: scripts/chat-homes/README.md):
//   node scripts/chat-homes/backup.mjs [--out <folder>] [--allow-running]
// Writes <out>/<timestamp>/ (default $XDG_STATE_HOME/sova/backups, else ~/.local/state/sova/backups):
//   agent.tar.gz   the agent dir (conversations, Sova's state, settings, logins), live records left out
//   homes.tar.gz   the chat homes, compressed ones included (when there are any)
//   shared.tar.gz  the older chats' shared folders (when there are any)
//   backup.json    where each came from, its sha256 and size, the Sova commit, and counts
// Every archive is listed back after writing. Refuses while a pi or Sova process runs on the agent dir
// (a backup taken mid-write may hold half a line), unless --allow-running.
import { chmodSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentDir, checkoutInfo, exists, homesRoot, liveProcesses, parseArgs, runningSova, sha256File, sharedBase, stateRootOf, tar } from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));

function countFiles(dir, test) {
  let n = 0;
  const visit = (d) => {
    let entries = [];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) visit(join(d, e.name));
      else if (test(e.name)) n++;
    }
  };
  visit(dir);
  return n;
}

export async function backup({ out, allowRunning = false, env = process.env, log = console.log } = {}) {
  const agent = agentDir(env);
  if (!exists(agent)) throw new Error(`No agent dir at ${agent}.`);
  const running = [...liveProcesses(agent).map((r) => `pi (pid ${r.pid})`), ...(await runningSova(agent))];
  if (running.length && !allowRunning) throw new Error(`Still running on ${agent}: ${running.join(", ")}. Stop it first, or pass --allow-running.`);
  const homes = homesRoot(agent, env);
  const shared = sharedBase(env);
  const base = out ?? join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "sova", "backups");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(base, stamp);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const parts = [];
  const pack = async (name, src, excludes = []) => {
    if (!exists(src)) return;
    const file = join(dir, name);
    tar(["-czf", file, ...excludes.flatMap((x) => ["--exclude", x]), "-C", dirname(src), basename(src)]);
    chmodSync(file, 0o600);
    const entries = tar(["-tzf", file]).toString().split("\n").filter(Boolean).length;
    parts.push({ name, from: src, sha256: await sha256File(file), size: statSync(file).size, entries });
  };
  await pack("agent.tar.gz", agent, [`${basename(agent)}/sessions/live`]);
  await pack("homes.tar.gz", homes);
  await pack("shared.tar.gz", shared);
  const manifest = {
    v: 1,
    createdAt: new Date().toISOString(),
    agentDir: agent,
    stateRoot: stateRootOf(agent),
    homesRoot: homes,
    sharedBase: shared,
    sova: checkoutInfo(here),
    counts: {
      conversations: countFiles(join(agent, "sessions"), (n) => n.endsWith(".jsonl")) + countFiles(homes, (n) => n.endsWith(".jsonl")),
      homes: exists(homes) ? readdirSync(homes, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).length : 0,
      compressed: countFiles(join(agent, "sessions"), (n) => n.endsWith(".jsonl.gz")) + countFiles(homes, (n) => n.endsWith(".tar.gz")),
    },
    parts,
  };
  writeFileSync(join(dir, "backup.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  log(`Backed up ${manifest.counts.conversations} conversations, ${manifest.counts.homes} chat homes and ${manifest.counts.compressed} compressed chats to:`);
  log(dir);
  return { dir, manifest };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const a = parseArgs(process.argv.slice(2), { out: "value", "allow-running": "flag" });
    await backup({ out: a.out, allowRunning: !!a["allow-running"] });
  } catch (err) {
    console.error(`backup: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
