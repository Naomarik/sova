#!/usr/bin/env node
// The deploy runner (§app.project-services/deploy-run): what a deploy's transient unit runs, so the
// deploy outlives a restart of the Sova server that started it. Node builtins only (Bun runs it too).
//
//   <node|bun> deploy-runner.mjs <job.json>
//
// The job (written by server/project-services/deploy.ts) names the record to keep, the log to write,
// the per-target lock to hold, a secrets file (0600) it reads once and deletes, the fresh checkout to run
// in, and the steps (argv, never a shell) and verify. Each step's output goes to the log with every
// secret value replaced by [redacted:<NAME>]; the first step that fails stops the deploy. The record says
// what happened after each step, and at the end the lock is released.

import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

const job = JSON.parse(readFileSync(process.argv[2], "utf8"));

let secrets = {};
try {
  secrets = JSON.parse(readFileSync(job.secretsFile, "utf8")).values ?? {};
} catch {}
rmSync(job.secretsFile, { force: true });
const hidden = Object.entries(secrets)
  .filter(([, v]) => typeof v === "string" && v.length >= 4)
  .sort((a, b) => b[1].length - a[1].length);
export const redact = (s) => hidden.reduce((t, [k, v]) => t.split(v).join(`[redacted:${k}]`), s);

const readRecord = () => JSON.parse(readFileSync(job.recordFile, "utf8"));
function writeRecord(patch) {
  const r = { ...readRecord(), ...patch };
  const tmp = `${job.recordFile}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(r, null, 2)}\n`);
  renameSync(tmp, job.recordFile);
  return r;
}
const log = (key, text) => appendFileSync(job.logFile, `${JSON.stringify({ t: new Date().toISOString(), step: key, text: redact(text) })}\n`);

// Hold the target's lock as this process: a Sova restart then still reads it as held.
writeFileSync(job.lockFile, String(process.pid));
writeRecord({ pid: process.pid });

function runStep(step) {
  return new Promise((done) => {
    const t0 = Date.now();
    let child;
    try {
      child = spawn(step.argv[0], step.argv.slice(1), { cwd: job.cwd, env: { ...job.env, ...secrets }, stdio: ["ignore", "pipe", "pipe"], detached: true });
    } catch (err) {
      log(step.key, `cannot start ${step.argv[0]}: ${err.message}`);
      return done({ key: step.key, exit: null, ms: Date.now() - t0 });
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }, step.timeoutSec * 1000);
    for (const stream of [child.stdout, child.stderr]) {
      let buf = "";
      stream.on("data", (c) => {
        buf += c.toString("utf8");
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const l of lines) log(step.key, l);
      });
      stream.on("end", () => buf && log(step.key, buf));
    }
    child.once("error", (err) => {
      clearTimeout(timer);
      log(step.key, `cannot start ${step.argv[0]}: ${err.message}`);
      done({ key: step.key, exit: null, ms: Date.now() - t0 });
    });
    child.once("close", (code, sig) => {
      clearTimeout(timer);
      done({ key: step.key, exit: code ?? (sig ? 128 : null), ms: Date.now() - t0, ...(timedOut ? { timedOut } : {}) });
    });
  });
}

async function verify(v) {
  const until = Date.now() + v.timeoutSec * 1000;
  let last = { status: null, detail: "" };
  while (Date.now() < until) {
    try {
      const r = await fetch(v.url, { redirect: "manual", signal: AbortSignal.timeout(Math.max(1000, Math.min(10_000, until - Date.now()))) });
      last = { status: r.status, detail: `answered ${r.status}` };
      if (r.status === v.expect) return { url: v.url, status: r.status, ok: true, detail: `${v.url} answered ${r.status}` };
    } catch (err) {
      last = { status: null, detail: `did not answer (${err?.cause?.code ?? err?.name ?? "error"})` };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { url: v.url, status: last.status, ok: false, detail: `${v.url} ${last.detail || "did not answer"}, expected ${v.expect}` };
}

async function main() {
  const steps = [];
  for (const step of job.steps) {
    log(step.key, `$ ${step.argv.join(" ")}`);
    const r = await runStep(step);
    steps.push(r);
    writeRecord({ steps });
    if (r.exit !== 0) {
      const why = r.timedOut ? `${r.key} timed out after ${step.timeoutSec}s` : r.exit === null ? `${r.key} could not start` : `${r.key} exited with ${r.exit}`;
      return writeRecord({ state: "failed", detail: why, endedAt: new Date().toISOString() });
    }
  }
  if (job.verify) {
    log("verify", `GET ${job.verify.url} (expect ${job.verify.expect})`);
    const v = await verify(job.verify);
    log("verify", v.detail);
    return writeRecord({ verify: v, state: v.ok ? "succeeded" : "verify-failed", ...(v.ok ? {} : { detail: v.detail }), endedAt: new Date().toISOString() });
  }
  return writeRecord({ state: "succeeded", endedAt: new Date().toISOString() });
}

try {
  await main();
} catch (err) {
  try {
    writeRecord({ state: "failed", detail: `the runner stopped: ${err?.message ?? err}`, endedAt: new Date().toISOString() });
  } catch {}
} finally {
  try {
    if (readFileSync(job.lockFile, "utf8").trim() === String(process.pid)) rmSync(job.lockFile, { force: true });
  } catch {}
}
