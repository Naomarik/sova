// `pnpm run voice:install [install|status|repair|uninstall] [--cpu] [--yes] [--dir <path>]` — the
// voice setup job (server/voice/install.ts) with a console reporter, for a headless or SSH-only
// host (§app.settings-dialog/voice). The same folder the server uses: <agent dir>/sova/voice, or
// SOVA_VOICE_DIR, or --dir. Refuses while another process holds the setup lock.
//
// `pnpm run voice:install models [list | download <id>|--all | delete <id> | use <id> | test <id>|--all]`
// — the model catalog's jobs (§app.settings-dialog/voice-models) without a browser. `test` runs the
// self-test on each downloaded model without switching, and reports its time and GPU memory.

import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { activeModel, dirBytes, freeBytes, lockHolder, readInstall, runtimeConfigFor, selfTest, STEP_LABELS, VoiceInstaller, voicePaths } from "../server/voice/install";
import { VoiceModels } from "../server/voice/models";
import { detect, missingFor, packageCommand, planFor, systemProbe } from "../server/voice/platform";
import { CATALOG, catalogModel, MODEL } from "../server/voice/pins";
import { updateSettings } from "../server/voice/settings";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const dirAt = args.indexOf("--dir");
const dir = dirAt >= 0 ? args[dirAt + 1] : undefined;
const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--dir");
const command = positional[0] ?? "install";
const paths = voicePaths(dir);
const mb = (n: number) => `${(n / 1e6).toFixed(0)} MB`;

function status(): number {
  const det = detect(systemProbe());
  const rec = readInstall(paths);
  console.log(`voice folder: ${paths.dir}`);
  console.log(`model:        ${activeModel(paths).id}`);
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

// ---- models ------------------------------------------------------------------------------------

function modelsFor(): VoiceModels {
  const probe = systemProbe();
  return new VoiceModels({
    paths: () => paths,
    whisper: () => {
      const rec = readInstall(paths);
      return rec ? { binary: join(paths.dir, rec.binary), cpu: rec.cpu } : null;
    },
    setupRunning: () => false,
    sweepRunning: () => false,
    stopRuntime: async () => {},
    resetRuntime: () => {},
    needsCompiler: () => (["cc", "gcc", "clang"].some((c) => probe.which(c)) ? null : packageCommand(probe.platform, detect(probe).packageManager, ["compiler"])),
    log: (t) => console.log(t),
  });
}

/** GPU memory in use (bytes), summed over DRM devices that report it (AMD: VRAM plus GTT), or null. */
function gpuMemory(): number | null {
  let total = 0;
  let any = false;
  try {
    for (const card of readdirSync("/sys/class/drm")) {
      if (!/^card\d+$/.test(card)) continue;
      for (const f of ["mem_info_vram_used", "mem_info_gtt_used"]) {
        try {
          total += Number(readFileSync(`/sys/class/drm/${card}/device/${f}`, "utf8").trim());
          any = true;
        } catch {
          // not this driver
        }
      }
    }
  } catch {
    return null;
  }
  return any ? total : null;
}

async function waitJob(models: VoiceModels): Promise<boolean> {
  let last = "";
  const tick = setInterval(() => {
    const j = models.job;
    if (!j || j.outcome) return;
    const line = `  ${j.model}: ${j.step}${j.progress ? ` ${mb(j.progress.done)} of ${mb(j.progress.total)}` : ""}`;
    if (line !== last && process.stdout.isTTY) process.stdout.write(`${line}\r`);
    last = line;
  }, 1000);
  const onSig = () => {
    console.log("\nCancelling…");
    models.cancel();
  };
  process.once("SIGINT", onSig);
  await models.whenDone();
  clearInterval(tick);
  process.off("SIGINT", onSig);
  const j = models.job!;
  if (j.outcome !== "ok") console.error(`${j.model}: ${j.outcome}${j.error ? ` — ${j.error}` : ""}`);
  return j.outcome === "ok";
}

async function modelsCommand(): Promise<number> {
  const sub = positional[1] ?? "list";
  const id = positional[2];
  const models = modelsFor();
  const pick = () => (flag("--all") ? CATALOG.map((m) => m.id) : id ? [id] : []);
  switch (sub) {
    case "list": {
      for (const m of models.states()) {
        const extra = [m.importedFrom ? `imported from ${m.importedFrom}` : "", m.selftestMs !== undefined ? `self-test ${(m.selftestMs / 1000).toFixed(2)} s` : "", m.error ?? ""].filter(Boolean).join(", ");
        console.log(`${m.active ? "*" : " "} ${m.id.padEnd(28)} ${m.engine.padEnd(10)} ${mb(m.bytes).padStart(8)}  ${m.state}${extra ? `  (${extra})` : ""}`);
      }
      const free = freeBytes(paths.dir);
      console.log(`voice folder ${paths.dir}: ${mb(dirBytes(paths.dir))}${free !== null ? `, ${mb(free)} free` : ""}`);
      return 0;
    }
    case "download": {
      const ids = pick();
      if (!ids.length) break;
      let ok = true;
      for (const one of ids) {
        const m = catalogModel(one);
        if (m && models.ready(m)) {
          console.log(`${one}: already downloaded`);
          continue;
        }
        const started = models.download(one);
        if (!started.ok) {
          console.error(`${one}: ${started.error}`);
          ok = false;
          continue;
        }
        console.log(`${one}: downloading`);
        ok = (await waitJob(models)) && ok;
      }
      return ok ? 0 : 1;
    }
    case "delete": {
      if (!id) break;
      const out = models.delete(id);
      if (!out.ok) {
        console.error(out.error);
        return 1;
      }
      console.log(`Deleted ${id} (${mb(out.freed)}).`);
      return 0;
    }
    case "use": {
      if (!id) break;
      const started = models.use(id);
      if (!started.ok) {
        console.error(started.error);
        return 1;
      }
      const ok = await waitJob(models);
      if (ok) console.log(`${id} is now the active model. A running Sova server picks it up at its next start of whisper.`);
      return ok ? 0 : 1;
    }
    case "test": {
      const rec = readInstall(paths);
      if (!rec) {
        console.error("Voice isn't set up here: run voice:install first.");
        return 1;
      }
      let ok = true;
      for (const one of pick()) {
        const m = catalogModel(one);
        if (!m) {
          console.error(`${one}: not in the catalog`);
          ok = false;
          continue;
        }
        if (!models.ready(m)) {
          console.log(`${one}: not downloaded`);
          continue;
        }
        const cfg = runtimeConfigFor(paths, m, join(paths.dir, rec.binary), rec.cpu);
        const before = gpuMemory();
        let during: number | null = null;
        const t0 = Date.now();
        try {
          const st = await selfTest(cfg, paths, new AbortController().signal, () => {}, { onWarm: () => (during = gpuMemory()) });
          const wall = Date.now() - t0;
          const gpu = before !== null && during !== null ? `${Math.round((during - before) / 2 ** 20)} MiB GPU memory` : "GPU memory unknown";
          console.log(`${one}: ${mb(m.bytes)} · self-test ${st.ms} ms warm, ${st.firstMs} ms first · ${(wall / 1000).toFixed(1)} s from start to stop · ${gpu} · ${st.gpu ? `GPU${st.device ? ` ${st.device}` : ""}` : "CPU"} · heard “${st.text}”`);
          updateSettings(paths.settingsFile, (s) => {
            const r = (s.models[m.id] ??= {});
            r.selftestMs = st.ms;
            r.selftestText = st.text;
            r.selftestAt = Date.now();
          });
        } catch (err) {
          console.error(`${one}: ${(err as Error).message}`);
          ok = false;
        }
      }
      return ok ? 0 : 1;
    }
  }
  console.error("usage: pnpm run voice:install models [list | download <id>|--all | delete <id> | use <id> | test <id>|--all] [--dir <path>]");
  return 64;
}

async function main(): Promise<number> {
  switch (command) {
    case "models":
      return modelsCommand();
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
      console.error("usage: pnpm run voice:install [install|status|repair|uninstall|models …] [--cpu] [--yes] [--dir <path>]");
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
