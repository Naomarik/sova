// `pnpm run voice:install [install|status|repair|uninstall] [--cpu] [--yes] [--dir <path>]` — the
// voice setup job (server/voice/install.ts) with a console reporter, for a headless or SSH-only
// host (§app.settings-dialog/voice). The same folder the server uses: <agent dir>/sova/voice, or
// SOVA_VOICE_DIR, or --dir. Refuses while another process holds the setup lock.

import { rmSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { dirBytes, lockHolder, readInstall, STEP_LABELS, VoiceInstaller, voicePaths } from "../server/voice/install";
import { detect, missingFor, packageCommand, planFor, systemProbe } from "../server/voice/platform";
import { MODEL } from "../server/voice/pins";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const dirAt = args.indexOf("--dir");
const dir = dirAt >= 0 ? args[dirAt + 1] : undefined;
const command = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--dir") ?? "install";
const paths = voicePaths(dir);
const mb = (n: number) => `${(n / 1e6).toFixed(0)} MB`;

function status(): number {
  const det = detect(systemProbe());
  const rec = readInstall(paths);
  console.log(`voice folder: ${paths.dir}`);
  console.log(`host:         ${det.os} ${det.arch}${det.distro ? ` (${det.distro})` : ""}, package manager ${det.packageManager ?? "unknown"}`);
  if (det.unsupported) {
    console.log(`unsupported:  ${det.unsupported}`);
    return 1;
  }
  console.log(`GPU backend:  ${det.backend}${det.device ? ` · ${det.device}` : ""}${det.prebuilt ? ` (prebuilt CPU binary available: ${det.prebuilt})` : ""}`);
  const plan = planFor(det, flag("--cpu") ? "cpu" : "gpu");
  const needs = missingFor(systemProbe(), plan);
  if (needs.length) {
    const pc = packageCommand(process.platform, det.packageManager, needs);
    console.log(`missing:      ${pc.packages.join(", ")}`);
    if (pc.command) console.log(`install with: ${pc.command}`);
  }
  if (rec) {
    console.log(`installed:    ${rec.backend}${rec.device ? ` · ${rec.device}` : ""}, whisper.cpp ${rec.whisper}, ${rec.model}, self-test ${(rec.selftestMs / 1000).toFixed(1)} s (“${rec.selftestText}”)`);
    console.log(`disk:         ${mb(dirBytes(paths.dir))}`);
  } else {
    console.log("installed:    no");
  }
  const holder = lockHolder(paths);
  if (holder) console.log(`setup running in pid ${holder}`);
  return 0;
}

async function confirm(q: string): Promise<boolean> {
  if (flag("--yes")) return true;
  if (!process.stdin.isTTY) {
    console.error(`${q} Pass --yes to confirm without a terminal.`);
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(`${q} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(a.trim());
}

async function run(repair: boolean): Promise<number> {
  const holder = lockHolder(paths);
  if (holder) {
    console.error(`Another process (pid ${holder}) is setting up voice in ${paths.dir}. Wait for it, or cancel it in Settings → Voice.`);
    return 1;
  }
  if (!repair && !readInstall(paths) && !(await confirm(`Set up voice in ${paths.dir}: build whisper.cpp and download the ${mb(MODEL.bytes)} model?`))) return 1;
  const inst = new VoiceInstaller({ paths: () => paths, probe: () => systemProbe(), echo: (line) => console.log(line) });
  const started = inst.start(flag("--cpu") ? "cpu" : "gpu", repair);
  if (!started.ok) {
    console.error(started.error);
    return 1;
  }
  const onSig = () => {
    console.log("\nCancelling…");
    inst.cancel();
  };
  process.once("SIGINT", onSig);
  let last = "";
  const tick = setInterval(() => {
    const running = inst.job?.steps.find((s) => s.state === "running");
    const p = running?.progress;
    if (!running || !p) return;
    const line = `  ${STEP_LABELS[running.id]}: ${p.unit === "bytes" ? `${mb(p.done)}${p.total ? ` of ${mb(p.total)}` : ""}` : `${p.done}%`}`;
    if (line !== last && process.stdout.isTTY) process.stdout.write(`${line}\r`);
    last = line;
  }, 1000);
  await started.finished;
  clearInterval(tick);
  process.off("SIGINT", onSig);
  const job = inst.job!;
  if (job.outcome === "needs-packages" && inst.missing) {
    console.log(`\nThis host needs: ${inst.missing.packages.join(", ")}.`);
    if (inst.missing.command) console.log(`Run this, then run voice:install again:\n\n  ${inst.missing.command}\n`);
    if (!flag("--cpu") && detect(systemProbe()).prebuilt) console.log("Or use the prebuilt CPU binary: pnpm run voice:install --cpu");
    return 2;
  }
  return job.outcome === "ok" ? 0 : 1;
}

async function main(): Promise<number> {
  switch (command) {
    case "status":
      return status();
    case "install":
      return run(false);
    case "repair":
      return run(true);
    case "uninstall": {
      const holder = lockHolder(paths);
      if (holder) {
        console.error(`Setup is running in pid ${holder}. Cancel it first.`);
        return 1;
      }
      const size = dirBytes(paths.dir);
      if (!(await confirm(`Remove ${paths.dir} (${mb(size)}): whisper.cpp, the model and the logs? System packages stay installed.`))) return 1;
      rmSync(paths.dir, { recursive: true, force: true });
      console.log(`Removed ${paths.dir} (${mb(size)}). A running Sova server stops its whisper-server at its next idle unload or restart.`);
      return 0;
    }
    default:
      console.error("usage: pnpm run voice:install [install|status|repair|uninstall] [--cpu] [--yes] [--dir <path>]");
      return 64;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
