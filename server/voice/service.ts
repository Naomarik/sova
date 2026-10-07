// The voice service: one installer and one whisper-server supervisor per server process, and the
// routes over them (§chat.voice/transcribe, §chat.voice/runtime, §app.settings-dialog/voice).

import { existsSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { VoiceDeviceInfo, VoiceDeviceState, VoiceState, VoiceStatus, VoiceThisDevice, VoiceTranscript } from "../../shared/protocol";
import { Calibrator, CalibrationError, MAX_CLIP_BYTES } from "./calibration";
import { activeModel, dirBytes, ensureFile, freeBytes, modelPresent, readInstall, VoiceInstaller, voicePaths, type InstallRecord, type InstallerOptions, type VoicePaths } from "./install";
import { VoiceModels } from "./models";
import { HOTWORDS, VAD_MODEL } from "./pins";
import { packageCommand, systemProbe, voicePath, type Probe } from "./platform";
import { RuntimeError, WhisperRuntime, type RuntimeConfig, type RuntimeDeps } from "./runtime";
import { decodeFields, decodeFor, readSettings, updateSettings, validDeviceId } from "./settings";
import { cleanTranscript, hintWord, inspectWav } from "./wav";

/** About 6 minutes of 16 kHz 16-bit mono; the client caps a recording at 5. */
export const MAX_WAV_BYTES = 12 * 1024 * 1024;

/** A device's last-seen time is written at most this often from dictation. */
const SEEN_EVERY_MS = 10 * 60_000;

export interface VoiceServiceOptions {
  paths?: () => VoicePaths;
  probe?: () => Probe;
  steps?: InstallerOptions["steps"];
  idleMs?: number;
  healthTimeoutMs?: number;
  backoffMs?: number[];
  /** Tests: a stand-in self-test for model switches. */
  selfTest?: ConstructorParameters<typeof VoiceModels>[0]["selfTest"];
  /** Tests: how the speech server's child is started and reached (default: a real child on a free port). */
  runtime?: Pick<RuntimeDeps, "spawn" | "fetchImpl" | "port">;
}

/** Stand-ins for tests and hermetic runs, each a path used only when it exists. */
const fakeWhisper = () => {
  const f = process.env.SOVA_VOICE_WHISPER_BIN;
  return f && existsSync(f) ? f : null;
};
const fakeTranscribe = () => {
  const f = process.env.SOVA_VOICE_TRANSCRIBE_BIN;
  return f && existsSync(f) ? f : null;
};

export class VoiceService {
  readonly installer: VoiceInstaller;
  readonly runtime: WhisperRuntime;
  readonly models: VoiceModels;
  readonly calibrator: Calibrator;
  private readonly pathsOf: () => VoicePaths;
  /** Each device's last dictation folder hint, for its calibration sweep. */
  private readonly hints = new Map<string, string | null>();
  private readonly probeOf: () => Probe;

  constructor(o: VoiceServiceOptions = {}) {
    this.pathsOf = o.paths ?? (() => voicePaths());
    const probe = o.probe ?? (() => systemProbe());
    this.probeOf = probe;
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
      ...o.runtime,
      logFile: join(paths.logs, "whisper-server.log"),
      runtimeFile: paths.runtimeFile,
      idleMs: o.idleMs ?? envMs("SOVA_VOICE_IDLE_MS"),
      healthTimeoutMs: o.healthTimeoutMs,
      backoffMs: o.backoffMs,
      env: { ...process.env, PATH: voicePath() },
    });
    this.models = new VoiceModels({
      paths: this.pathsOf,
      whisper: () => this.whisperBinary(),
      setupRunning: () => this.installer.running(),
      sweepRunning: () => !!this.calibrator.running(),
      stopRuntime: () => this.runtime.stop(),
      resetRuntime: () => this.runtime.reset(),
      needsCompiler: () => this.needsCompiler(),
      transcribeBin: fakeTranscribe,
      selfTest: o.selfTest,
      log: (t) => this.installer.log(t),
    });
    this.calibrator = new Calibrator({
      calibrationDir: () => this.paths().calibration,
      settingsFile: () => this.paths().settingsFile,
      active: () => {
        const m = activeModel(this.paths());
        return { id: m.id, engine: m.engine, label: m.label };
      },
      cpu: () => this.runtimeConfig()?.cpu ?? true,
      ready: () => !!this.runtimeConfig(),
      busy: () => (this.installer.running() ? "Setup is running. Wait for it to finish." : this.models.running() ? "A model download or switch is running. Wait for it to finish." : null),
      ensureVad: async (signal) => {
        try {
          await ensureFile(VAD_MODEL, this.paths().vadFile, { signal, log: (t) => this.installer.log(t), progress: () => {} });
          return true;
        } catch {
          return false;
        }
      },
      vadReady: () => !!this.runtimeConfig()?.vadModel,
      hint: (device) => this.hints.get(device) ?? null,
      transcribe: (wav, req) => this.runtime.transcribe(wav, req),
      dictationWaiting: () => this.runtime.dictationWaiting(),
      restartEngine: () => this.runtime.restartWhenIdle(),
    });
  }

  paths(): VoicePaths {
    return this.pathsOf();
  }

  /** The installed whisper-server (or SOVA_VOICE_WHISPER_BIN) and whether it runs on the CPU. */
  private whisperBinary(): { binary: string; cpu: boolean } | null {
    const fake = fakeWhisper();
    if (fake) return { binary: fake, cpu: process.env.SOVA_VOICE_WHISPER_GPU !== "1" };
    const rec = this.installed();
    return rec ? { binary: join(this.paths().dir, rec.binary), cpu: rec.cpu } : null;
  }

  private needsCompiler(): { packages: string[]; command: string | null } | null {
    const p = this.probeOf();
    if (["cc", "gcc", "clang"].some((c) => p.which(c))) return null;
    return packageCommand(p.platform, this.installer.detection().packageManager, ["compiler"]);
  }

  /**
   * What the runtime runs: the active model on its engine — install.json's whisper-server or
   * Parakeet's compiled host — or the stand-ins SOVA_VOICE_WHISPER_BIN / SOVA_VOICE_TRANSCRIBE_BIN.
   * whisper gets `-vm` whenever the Silero file is here.
   */
  runtimeConfig(): RuntimeConfig | null {
    const paths = this.paths();
    const m = activeModel(paths);
    const whisper = this.whisperBinary();
    if (!whisper) return null;
    const fake = fakeWhisper();
    if (m.engine === "transcribe") {
      const binary = fakeTranscribe() ?? paths.transcribeHost;
      if (!existsSync(binary)) return null;
      return { engine: "transcribe", binary, model: process.env.SOVA_VOICE_MODEL || paths.modelFile, cpu: whisper.cpu };
    }
    const cfg: RuntimeConfig = { engine: "whisper", binary: whisper.binary, model: (fake && process.env.SOVA_VOICE_MODEL) || paths.modelFile, cpu: whisper.cpu };
    if (modelPresent(paths, VAD_MODEL)) cfg.vadModel = paths.vadFile;
    return cfg;
  }

  installed(): InstallRecord | null {
    return readInstall(this.paths());
  }

  status(since = 0, withSize = false, device?: Partial<VoiceDeviceInfo> | null): VoiceStatus {
    const det = this.installer.detection();
    const job = this.installer.job;
    const rec = this.installed();
    const fake = !!fakeWhisper();
    const paths = this.paths();
    const active = activeModel(paths);
    let state: VoiceState;
    if (det.unsupported && !fake) state = "unsupported";
    else if (this.installer.running()) state = "installing";
    else if (rec || fake) state = "ready";
    else if (job?.outcome === "needs-packages") state = "needs-packages";
    else if (job?.outcome === "failed") state = "failed";
    else state = "not-installed";
    const settings = readSettings(paths.settingsFile);
    const status: VoiceStatus = {
      state,
      platform: { os: det.os, arch: det.arch },
      gpu: { backend: det.backend },
      cpuPrebuilt: !!det.prebuilt,
      runtime: this.runtime.status(),
      model: { id: active.id, bytes: active.bytes },
      log: this.installer.logSince(since),
      models: this.models.states(),
      activeModel: active.id,
      devices: Object.entries(settings.devices).map(
        ([id, d]): VoiceDeviceState => ({ id, label: d.label, app: d.app, lastSeenAt: d.lastSeenAt, calibrated: Object.keys(d.perModel) }),
      ),
    };
    if (det.unsupported) status.reason = det.unsupported;
    if (det.distro) status.platform.distro = det.distro;
    if (det.packageManager) status.platform.packageManager = det.packageManager;
    if (det.device) status.gpu.device = det.device;
    if (state === "needs-packages" && this.installer.missing) status.missing = this.installer.missing;
    if (job) status.install = job;
    if (this.models.job) status.modelJob = this.models.job;
    if (rec) {
      status.installed = {
        backend: rec.backend,
        whisper: rec.whisper,
        model: active.id,
        selftestMs: rec.selftestMs,
        selftestText: rec.selftestText,
        installedAt: rec.installedAt,
      };
      if (rec.device) status.installed.device = rec.device;
    } else if (fake) {
      status.installed = { backend: "cpu", whisper: "stand-in", model: active.id, selftestMs: 0, selftestText: "", installedAt: 0 };
    }
    const sweep = this.calibrator.running();
    if (sweep) status.sweep = { device: sweep.device, deviceLabel: settings.devices[sweep.device]?.label ?? "", model: sweep.model };
    if (device?.id && validDeviceId(device.id)) {
      const d = settings.devices[device.id];
      const { settings: decode, record } = decodeFor(settings, device.id, active.id);
      const me: VoiceThisDevice = {
        id: device.id,
        label: d?.label || device.label || "",
        app: d?.app ?? device.app ?? false,
        known: !!d,
        settings: decode,
        source: record ? record.source : "default",
        canRevert: record?.previous !== undefined,
      };
      if (record?.calibration) me.calibration = record.calibration;
      status.device = me;
      status.calibration = this.calibrator.status(device.id);
    }
    if (withSize) {
      status.diskBytes = dirBytes(paths.dir);
      const free = freeBytes(paths.dir);
      if (free !== null) status.diskFree = free;
    }
    return status;
  }

  /** Uninstall: stop whisper and remove the voice folder. Refused while a job runs. */
  async uninstall(): Promise<{ ok: true; freed: number } | { ok: false; error: string }> {
    if (this.installer.running()) return { ok: false, error: "Setup is running. Cancel it first." };
    if (this.models.running()) return { ok: false, error: "A model download or switch is running. Cancel it first." };
    if (this.calibrator.running()) return { ok: false, error: "Calibration is running. Stop it first." };
    await this.runtime.stop();
    const dir = this.paths().dir;
    const freed = dirBytes(dir);
    rmSync(dir, { recursive: true, force: true });
    this.installer.job = null;
    this.installer.missing = null;
    this.models.job = null;
    this.runtime.reset();
    return { ok: true, freed };
  }

  /** One dictation clip, decoded with the device's saved settings for the active model (or the defaults). */
  async transcribe(wav: Uint8Array, hint: string | null, device?: string | null): Promise<VoiceTranscript> {
    const info = inspectWav(wav);
    if ("error" in info) throw new VoiceHttpError(400, info.error);
    await this.models.switching();
    const cfg = this.runtimeConfig();
    const paths = this.paths();
    const settings = readSettings(paths.settingsFile);
    const id = device && validDeviceId(device) ? device : null;
    if (id) this.hints.set(id, hint);
    const d = id ? settings.devices[id] : undefined;
    if (id && d && Date.now() - d.lastSeenAt > SEEN_EVERY_MS) {
      updateSettings(paths.settingsFile, (s) => {
        const cur = s.devices[id];
        if (cur) cur.lastSeenAt = Date.now();
      });
    }
    const fields = cfg?.engine === "transcribe" ? {} : decodeFields(decodeFor(settings, id, activeModel(paths).id).settings, { hint, vadModel: !!cfg?.vadModel });
    const out = await this.runtime.transcribe(wav, { fields, lane: "dictation" });
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
    singleton.models.resume();
  }
  return singleton;
}

/** Shutdown: stop whisper-server, cancel a job (its steps resume next time). */
export async function stopVoice(): Promise<void> {
  if (!singleton) return;
  singleton.installer.cancel();
  singleton.models.cancel({ keepMarker: true });
  const sweep = singleton.calibrator.running();
  if (sweep) singleton.calibrator.stop(sweep.device);
  await Promise.race([singleton.runtime.stop(), new Promise((r) => setTimeout(r, 2500))]);
}
process.on("exit", () => singleton?.runtime.killNow());

type AnyHono = Hono<any>;

/** The requesting device from the query: `device`, and optionally `label` and `app`. */
function queryDevice(q: (name: string) => string | undefined): (Partial<VoiceDeviceInfo> & { id: string }) | null {
  const id = q("device");
  if (!id || !validDeviceId(id)) return null;
  const out: Partial<VoiceDeviceInfo> & { id: string } = { id };
  const label = q("label");
  if (label) out.label = label.slice(0, 80);
  const app = q("app");
  if (app !== undefined) out.app = app === "1" || app === "true";
  return out;
}

async function jsonBody(c: { req: { json(): Promise<unknown> } }): Promise<Record<string, unknown>> {
  try {
    const b = await c.req.json();
    return b && typeof b === "object" ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The device a POST names: its body's `device` object, else the query. */
function bodyDevice(body: Record<string, unknown>, q: (name: string) => string | undefined): (Partial<VoiceDeviceInfo> & { id: string }) | null {
  const d = body.device as Partial<VoiceDeviceInfo> | undefined;
  const fromQuery = queryDevice(q);
  if (d && typeof d === "object" && validDeviceId(d.id)) {
    const out: Partial<VoiceDeviceInfo> & { id: string } = { id: d.id };
    if (typeof d.label === "string") out.label = d.label.slice(0, 80);
    if (typeof d.app === "boolean") out.app = d.app;
    return out;
  }
  return fromQuery;
}

const NO_DEVICE = { error: "A voice device id is required (?device=<id>)." };

export function registerVoiceRoutes(app: AnyHono, service: () => VoiceService = voiceService): void {
  app.get("/api/voice", (c) => {
    const since = Number(c.req.query("since") ?? 0);
    return c.json(service().status(Number.isFinite(since) ? since : 0, c.req.query("size") === "1", queryDevice((n) => c.req.query(n))));
  });

  app.post("/api/voice/install", async (c) => {
    let body: { backend?: unknown; repair?: unknown } = {};
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      // no body: GPU, not a repair
    }
    const s = service();
    if (s.models.running()) return c.json({ error: "A model download or switch is running. Wait for it to finish." }, 409);
    const mode = body.backend === "cpu" ? "cpu" : "gpu";
    const started = s.installer.start(mode, body.repair === true);
    if (!started.ok) return c.json({ error: started.error }, 409);
    return c.json(s.status(), 202);
  });

  app.post("/api/voice/repair", (c) => {
    const s = service();
    if (s.models.running()) return c.json({ error: "A model download or switch is running. Wait for it to finish." }, 409);
    if (s.calibrator.running()) return c.json({ error: "Calibration is running. Stop it first." }, 409);
    const rec = s.installed();
    const started = s.installer.start(rec?.cpu ? "cpu" : "gpu", true);
    if (!started.ok) return c.json({ error: started.error }, 409);
    return c.json(s.status(), 202);
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
        return c.json(await s.transcribe(wav, hintWord(c.req.query("hint") ? basename(c.req.query("hint")!) : undefined, HOTWORDS), c.req.query("device")));
      } catch (err) {
        if (err instanceof VoiceHttpError || err instanceof RuntimeError) return c.json({ error: err.message }, err.status);
        throw err;
      }
    },
  );

  // ---- models (§app.settings-dialog/voice-models) ----

  app.post("/api/voice/models/cancel", (c) => {
    service().models.cancel();
    return c.json(service().status());
  });

  app.post("/api/voice/models/:id/download", (c) => {
    const s = service();
    const out = s.models.download(c.req.param("id"));
    if (!out.ok) return c.json({ error: out.error }, 409);
    return c.json(s.status(), 202);
  });

  app.post("/api/voice/models/:id/use", (c) => {
    const s = service();
    const out = s.models.use(c.req.param("id"));
    if (!out.ok) return c.json({ error: out.error }, 409);
    return c.json(s.status(), 202);
  });

  app.delete("/api/voice/models/:id", (c) => {
    const out = service().models.delete(c.req.param("id"));
    if (!out.ok) return c.json({ error: out.error }, 409);
    return c.json({ freed: out.freed });
  });

  // ---- calibration (§app.settings-dialog/voice-calibration) ----

  const calib = async (fn: () => void | Promise<void>, status: 200 | 202 = 200, device?: Partial<VoiceDeviceInfo> | null): Promise<Response> => {
    try {
      await fn();
    } catch (err) {
      if (err instanceof CalibrationError) return Response.json({ error: err.message }, { status: err.status });
      throw err;
    }
    return Response.json(service().status(0, false, device), { status });
  };

  app.put(
    "/api/voice/calibration/clips/:n",
    bodyLimit({
      maxSize: MAX_CLIP_BYTES,
      onError: () => new Response(JSON.stringify({ error: "The clip is over the 3 MB limit." }), { status: 413, headers: { "Content-Type": "application/json" } }),
    }),
    async (c) => {
      const device = queryDevice((n) => c.req.query(n));
      if (!device) return c.json(NO_DEVICE, 400);
      const wav = new Uint8Array(await c.req.arrayBuffer());
      return calib(() => {
        service().calibrator.putClip(device.id, Number(c.req.param("n")), wav);
        service().calibrator.touchDevice(device);
      }, 200, device);
    },
  );

  app.delete("/api/voice/calibration/clips/:n", (c) => {
    const device = queryDevice((n) => c.req.query(n));
    if (!device) return c.json(NO_DEVICE, 400);
    return calib(() => service().calibrator.deleteClip(device.id, Number(c.req.param("n"))), 200, device);
  });

  app.delete("/api/voice/calibration/clips", (c) => {
    const device = queryDevice((n) => c.req.query(n));
    if (!device) return c.json(NO_DEVICE, 400);
    return calib(() => service().calibrator.deleteAll(device.id), 200, device);
  });

  app.post("/api/voice/calibration/run", async (c) => {
    const device = bodyDevice(await jsonBody(c), (n) => c.req.query(n));
    if (!device) return c.json(NO_DEVICE, 400);
    return calib(() => void service().calibrator.start(device), 202, device);
  });

  app.post("/api/voice/calibration/stop", async (c) => {
    const device = bodyDevice(await jsonBody(c), (n) => c.req.query(n));
    if (!device) return c.json(NO_DEVICE, 400);
    service().calibrator.stop(device.id);
    await Promise.race([service().calibrator.whenDone(), new Promise((r) => setTimeout(r, 2000))]);
    return c.json(service().status(0, false, device));
  });

  app.post("/api/voice/calibration/apply", async (c) => {
    const body = await jsonBody(c);
    const device = bodyDevice(body, (n) => c.req.query(n));
    if (!device) return c.json(NO_DEVICE, 400);
    if (typeof body.key !== "string") return c.json({ error: "Name the results row to use (key)." }, 400);
    return calib(() => service().calibrator.apply(device.id, body.key as string), 200, device);
  });

  app.post("/api/voice/calibration/revert", async (c) => {
    const device = bodyDevice(await jsonBody(c), (n) => c.req.query(n));
    if (!device) return c.json(NO_DEVICE, 400);
    return calib(() => service().calibrator.revert(device.id), 200, device);
  });

  app.delete("/api/voice/devices/:id", (c) => {
    const id = c.req.param("id");
    if (!validDeviceId(id)) return c.json({ error: "That isn't a voice device id." }, 400);
    return calib(() => service().calibrator.forget(id), 200, queryDevice((n) => c.req.query(n)));
  });
}
