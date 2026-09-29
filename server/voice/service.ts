// The voice service: one installer and one whisper-server supervisor per server process, and the
// routes over them (§chat.voice/transcribe, §chat.voice/runtime, §app.settings-dialog/voice).

import { existsSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { VoiceState, VoiceStatus, VoiceTranscript } from "../../shared/protocol";
import { dirBytes, readInstall, VoiceInstaller, voicePaths, type InstallRecord, type InstallerOptions, type VoicePaths } from "./install";
import { HOTWORDS, MODEL } from "./pins";
import { systemProbe, voicePath, type Probe } from "./platform";
import { RuntimeError, WhisperRuntime, type RuntimeConfig } from "./runtime";
import { cleanTranscript, hintWord, inspectWav } from "./wav";

/** About 6 minutes of 16 kHz 16-bit mono; the client caps a recording at 5. */
export const MAX_WAV_BYTES = 12 * 1024 * 1024;

export interface VoiceServiceOptions {
  paths?: () => VoicePaths;
  probe?: () => Probe;
  steps?: InstallerOptions["steps"];
  idleMs?: number;
  healthTimeoutMs?: number;
  backoffMs?: number[];
}

export class VoiceService {
  readonly installer: VoiceInstaller;
  readonly runtime: WhisperRuntime;
  private readonly pathsOf: () => VoicePaths;

  constructor(o: VoiceServiceOptions = {}) {
    this.pathsOf = o.paths ?? (() => voicePaths());
    const probe = o.probe ?? (() => systemProbe());
    this.installer = new VoiceInstaller({
      paths: this.pathsOf,
      probe,
      steps: o.steps,
      onStart: () => this.runtime.stop(),
      onEnd: (job) => {
        if (job.outcome === "ok") this.runtime.reset();
      },
    });
    const paths = this.pathsOf();
    this.runtime = new WhisperRuntime(() => this.runtimeConfig(), {
      logFile: join(paths.logs, "whisper-server.log"),
      runtimeFile: paths.runtimeFile,
      idleMs: o.idleMs ?? envMs("SOVA_VOICE_IDLE_MS"),
      healthTimeoutMs: o.healthTimeoutMs,
      backoffMs: o.backoffMs,
      env: { ...process.env, PATH: voicePath() },
    });
  }

  paths(): VoicePaths {
    return this.pathsOf();
  }

  /** What the runtime runs: install.json's binary, or SOVA_VOICE_WHISPER_BIN (a test stand-in). */
  runtimeConfig(): RuntimeConfig | null {
    const fake = process.env.SOVA_VOICE_WHISPER_BIN;
    if (fake && existsSync(fake)) return { binary: fake, model: process.env.SOVA_VOICE_MODEL || this.paths().modelFile, cpu: true };
    const rec = this.installed();
    if (!rec) return null;
    return { binary: join(this.paths().dir, rec.binary), model: this.paths().modelFile, cpu: rec.cpu };
  }

  installed(): InstallRecord | null {
    return readInstall(this.paths());
  }

  status(since = 0, withSize = false): VoiceStatus {
    const det = this.installer.detection();
    const job = this.installer.job;
    const rec = this.installed();
    const fake = !!process.env.SOVA_VOICE_WHISPER_BIN && existsSync(process.env.SOVA_VOICE_WHISPER_BIN);
    let state: VoiceState;
    if (det.unsupported && !fake) state = "unsupported";
    else if (this.installer.running()) state = "installing";
    else if (rec || fake) state = "ready";
    else if (job?.outcome === "needs-packages") state = "needs-packages";
    else if (job?.outcome === "failed") state = "failed";
    else state = "not-installed";
    const status: VoiceStatus = {
      state,
      platform: { os: det.os, arch: det.arch },
      gpu: { backend: det.backend },
      cpuPrebuilt: !!det.prebuilt,
      runtime: this.runtime.status(),
      model: { id: MODEL.id, bytes: MODEL.bytes },
      log: this.installer.logSince(since),
    };
    if (det.unsupported) status.reason = det.unsupported;
    if (det.distro) status.platform.distro = det.distro;
    if (det.packageManager) status.platform.packageManager = det.packageManager;
    if (det.device) status.gpu.device = det.device;
    if (state === "needs-packages" && this.installer.missing) status.missing = this.installer.missing;
    if (job) status.install = job;
    if (rec) {
      status.installed = {
        backend: rec.backend,
        whisper: rec.whisper,
        model: rec.model,
        selftestMs: rec.selftestMs,
        selftestText: rec.selftestText,
        installedAt: rec.installedAt,
      };
      if (rec.device) status.installed.device = rec.device;
    } else if (fake) {
      status.installed = { backend: "cpu", whisper: "stand-in", model: MODEL.id, selftestMs: 0, selftestText: "", installedAt: 0 };
    }
    if (withSize) status.diskBytes = dirBytes(this.paths().dir);
    return status;
  }

  /** Uninstall: stop whisper and remove the voice folder. Refused while a job runs. */
  async uninstall(): Promise<{ ok: true; freed: number } | { ok: false; error: string }> {
    if (this.installer.running()) return { ok: false, error: "Setup is running. Cancel it first." };
    await this.runtime.stop();
    const dir = this.paths().dir;
    const freed = dirBytes(dir);
    rmSync(dir, { recursive: true, force: true });
    this.installer.job = null;
    this.installer.missing = null;
    this.runtime.reset();
    return { ok: true, freed };
  }

  async transcribe(wav: Uint8Array, hint: string | null): Promise<VoiceTranscript> {
    const info = inspectWav(wav);
    if ("error" in info) throw new VoiceHttpError(400, info.error);
    const prompt = `${[...HOTWORDS, ...(hint ? [hint] : [])].join(", ")}.`;
    const out = await this.runtime.transcribe(wav, prompt);
    return { text: cleanTranscript(out.text), ms: out.ms, audioSec: Math.round(info.audioSec * 100) / 100 };
  }
}

export class VoiceHttpError extends Error {
  constructor(
    readonly status: 400 | 409 | 413 | 503,
    message: string,
  ) {
    super(message);
  }
}

function envMs(name: string): number | undefined {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

let singleton: VoiceService | null = null;
/** The server's one voice service, created on first use (nothing voice runs at boot). */
export function voiceService(): VoiceService {
  if (!singleton) {
    singleton = new VoiceService();
    singleton.runtime.killOrphan();
  }
  return singleton;
}

/** Shutdown: stop whisper-server, cancel a job (its steps resume next time). */
export async function stopVoice(): Promise<void> {
  if (!singleton) return;
  singleton.installer.cancel();
  await Promise.race([singleton.runtime.stop(), new Promise((r) => setTimeout(r, 2500))]);
}
process.on("exit", () => singleton?.runtime.killNow());

type AnyHono = Hono<any>;

export function registerVoiceRoutes(app: AnyHono, service: () => VoiceService = voiceService): void {
  app.get("/api/voice", (c) => {
    const since = Number(c.req.query("since") ?? 0);
    return c.json(service().status(Number.isFinite(since) ? since : 0, c.req.query("size") === "1"));
  });

  app.post("/api/voice/install", async (c) => {
    let body: { backend?: unknown; repair?: unknown } = {};
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      // no body: GPU, not a repair
    }
    const mode = body.backend === "cpu" ? "cpu" : "gpu";
    const started = service().installer.start(mode, body.repair === true);
    if (!started.ok) return c.json({ error: started.error }, 409);
    return c.json(service().status(), 202);
  });

  app.post("/api/voice/repair", (c) => {
    const rec = service().installed();
    const started = service().installer.start(rec?.cpu ? "cpu" : "gpu", true);
    if (!started.ok) return c.json({ error: started.error }, 409);
    return c.json(service().status(), 202);
  });

  app.post("/api/voice/install/cancel", (c) => {
    service().installer.cancel();
    return c.json(service().status());
  });

  app.delete("/api/voice", async (c) => {
    const out = await service().uninstall();
    if (!out.ok) return c.json({ error: out.error }, 409);
    return c.json({ freed: out.freed });
  });

  app.post("/api/voice/warm", (c) => {
    const s = service();
    if (!s.runtimeConfig()) return c.json({ error: "Voice isn't set up on this host." }, 409);
    s.runtime.warm();
    return c.body(null, 204);
  });

  app.post(
    "/api/voice/transcribe",
    bodyLimit({
      maxSize: MAX_WAV_BYTES,
      onError: () => new Response(JSON.stringify({ error: "The recording is over the 12 MB limit (about 6 minutes)." }), { status: 413, headers: { "Content-Type": "application/json" } }),
    }),
    async (c) => {
      const s = service();
      if (!s.runtimeConfig()) return c.json({ error: "Voice isn't set up on this host." }, 409);
      const wav = new Uint8Array(await c.req.arrayBuffer());
      try {
        return c.json(await s.transcribe(wav, hintWord(c.req.query("hint") ? basename(c.req.query("hint")!) : undefined, HOTWORDS)));
      } catch (err) {
        if (err instanceof VoiceHttpError || err instanceof RuntimeError) return c.json({ error: err.message }, err.status);
        throw err;
      }
    },
  );
}
