import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { getPriority, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { attribute, SidMemory, type AttribProc } from "../resource-monitor-attrib";
import { classifyArgv, parseEnviron, parseStat } from "../resource-monitor-proc";
import { spawnTourCommand, killTourChild } from "./sandbox";

test("real lowered recording controller and descendant retain exact session and team attribution", { timeout: 15_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "tour-priority-"));
  const previous = process.env.SOVA_WORKER_NICE; process.env.SOVA_WORKER_NICE = "12";
  const file = join(root, "session.jsonl");
  const expectedNice = Math.max(getPriority(), 12);
  const inner = `console.log(JSON.stringify({pid:process.pid,nice:require('node:os').getPriority(),session:process.env.PI_SESSION_FILE,team:process.env.PI_SUBAGENTS_TEAM_MEMBER}));setTimeout(()=>{},5000)`;
  const outer = `console.log(JSON.stringify({pid:process.pid,nice:require('node:os').getPriority(),session:process.env.PI_SESSION_FILE,team:process.env.PI_SUBAGENTS_TEAM_MEMBER}));require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(inner)}],{stdio:['ignore','inherit','inherit']});setTimeout(()=>{},5000)`;
  const handle = await spawnTourCommand({ sessionId: "priority-fixture", sessionFile: file, cwd: root, agentDir: root, sandbox: { on: false }, worker: { id: "ag_fixture", teamId: "team_fixture" } }, [process.execPath, "-e", outer]);
  const records: { pid: number; nice: number; session: string; team: string }[] = [];
  try {
    const lines = createInterface({ input: handle.process.stdout! });
    const complete = new Promise<void>((resolve, reject) => {
      lines.on("line", line => { try { records.push(JSON.parse(line)); if (records.length === 2) resolve(); } catch (e) { reject(e); } });
      handle.process.once("error", reject); handle.process.once("exit", () => { if (records.length !== 2) reject(new Error("Attribution probe stopped early.")); });
    });
    await complete;
    for (const record of records) { assert.ok(record.nice >= expectedNice); assert.equal(record.session, file); assert.deepEqual(JSON.parse(record.team), { teamId: "team_fixture", workerId: "ag_fixture" }); }
    if (process.platform === "linux") {
      const procs = new Map<number, AttribProc>();
      for (const record of records) procs.set(record.pid, { stat: parseStat(readFileSync(`/proc/${record.pid}/stat`, "utf8"))!, argv: classifyArgv([process.execPath, "tour-fixture"]), env: parseEnviron(readFileSync(`/proc/${record.pid}/environ`, "utf8")) });
      const measured = attribute({ procs, serverPid: process.pid, hosted: [{ path: file, sessionId: "priority-fixture", workers: [{ id: "ag_fixture", teamId: "team_fixture" }], providerIds: [], toolInWindow: false }], sids: new SidMemory(new Set([process.pid])) });
      for (const record of records) assert.deepEqual(measured.owners.get(record.pid), { session: file, worker: "ag_fixture", via: "team-env" });
    }
    lines.close();
  } finally {
    const exited = once(handle.process, "exit").catch(() => {}); killTourChild(handle.process, "SIGKILL"); await exited; await handle.dispose();
    if (previous === undefined) delete process.env.SOVA_WORKER_NICE; else process.env.SOVA_WORKER_NICE = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
