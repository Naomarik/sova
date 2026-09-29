// The model catalog on this host (§app.settings-dialog/voice-models): each entry's state, and the
// jobs over it — download (an import first, then a resumable download, sha256-verified), switch
// (the self-test on the new model decides; a failure keeps the old one) and delete. One job at a
// time, under the same lock as setup, so the CLI and a server never fetch into one folder at once.

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { VoiceModelJob, VoiceModelState } from "../../shared/protocol";
import { acquireLock, activeModel, ensureFile, ensureTranscribeEngine, modelFileOf, modelPresent, releaseLock, runtimeConfigFor, selfTest, transcribeSupported, type SelftestResult, type VoicePaths } from "./install";
import { CATALOG, catalogModel, TRANSCRIBE_CPP, type CatalogModel } from "./pins";
import { readSettings, updateSettings } from "./settings";

export interface VoiceModelsOptions {
  paths: () => VoicePaths;
  /** The installed whisper-server and whether it's a CPU install; null before setup. */
  whisper: () => { binary: string; cpu: boolean } | null;
  /** Setup (or a repair) is running: model jobs wait for it. */
  setupRunning: () => boolean;
  /** A calibration sweep is running: a switch waits for it. */
  sweepRunning: () => boolean;
  /** Stop the dictation server before a switch tests the new model, and forget its crashes after. */
  stopRuntime: () => Promise<void>;
  resetRuntime: () => void;
  /** What's missing to compile Parakeet's host (a C compiler), or null when nothing is. */
  needsCompiler: () => { packages: string[]; command: string | null } | null;
  /** SOVA_VOICE_TRANSCRIBE_BIN: a stand-in for the compiled host, when set. */
  transcribeBin?: () => string | null;
  /** Tests: stand-in self-test. */
  selfTest?: typeof selfTest;
  log?: (text: string) => void;
}

export class VoiceModels {
  job: VoiceModelJob | null = null;
  private abort: AbortController | null = null;
  private done: Promise<void> | null = null;
  /** The model a failed job was for, and why (shown on its row until its next job). */
  private failed = new Map<string, string>();

  constructor(private readonly o: VoiceModelsOptions) {}

  running(): boolean {
    return !!this.job && !this.job.outcome;
  }

  /** Resolves when no switch is under way: dictation waits on it rather than loading the old model. */
  switching(): Promise<void> {
    return this.job?.kind === "switch" && !this.job.outcome && this.done ? this.done : Promise.resolve();
  }

  whenDone(): Promise<void> {
    return this.done ?? Promise.resolve();
  }

  /** Whether a catalog entry can run here now: its file, and for Parakeet the engine too. */
  ready(m: CatalogModel): boolean {
    const paths = this.o.paths();
    return modelPresent(paths, m) && (m.engine !== "transcribe" || this.engineReady());
  }

  /** Parakeet's host is compiled, or a stand-in is set. */
  engineReady(): boolean {
    return !!this.o.transcribeBin?.() || existsSync(this.o.paths().transcribeHost);
  }

  states(): VoiceModelState[] {
    const paths = this.o.paths();
    const active = activeModel(paths).id;
    const records = readSettings(paths.settingsFile).models;
    const job = this.running() ? this.job : null;
    return CATALOG.filter((m) => m.engine !== "transcribe" || transcribeSupported()).map((m) => {
      const st: VoiceModelState = {
        id: m.id,
        label: m.label,
        quant: m.quant,
        bytes: m.bytes,
        languages: m.languages,
        engine: m.engine,
        state: "absent",
        active: m.id === active,
        tunable: m.engine === "whisper",
      };
      if (m.default) st.recommended = true;
      const engineMissing = m.engine === "transcribe" && !this.engineReady();
      if (engineMissing) st.engineBytes = TRANSCRIBE_CPP.bytes;
      const missing = engineMissing ? this.o.needsCompiler() : null;
      if (job && job.kind === "download" && job.model === m.id) {
        st.state = job.step === "import" || job.step === "verify" ? "verifying" : "downloading";
        if (job.progress) st.progress = job.progress;
      } else if (this.ready(m)) {
        st.state = "ready";
      } else if (missing) {
        st.state = "needs-packages";
        st.missing = missing;
      } else if (this.failed.has(m.id)) {
        st.state = "failed";
        st.error = this.failed.get(m.id)!;
      }
      const rec = records[m.id];
      if (rec?.importedFrom) st.importedFrom = rec.importedFrom;
      if (rec?.selftestMs !== undefined) st.selftestMs = rec.selftestMs;
      if (rec?.selftestText !== undefined) st.selftestText = rec.selftestText;
      if (st.state !== "failed" && this.job?.outcome === "failed" && this.job.model === m.id && this.job.kind === "switch" && this.job.error) st.error = this.job.error;
      return st;
    });
  }

  private refuse(): string | null {
    if (this.running()) return this.job!.kind === "switch" ? "A model switch is running." : "Another download is running.";
    if (this.o.setupRunning()) return "Setup is running. Wait for it to finish.";
    return null;
  }

  /** Start a download job (import, download, verify; Parakeet's engine first when it's missing). */
  download(id: string): { ok: true; job: VoiceModelJob } | { ok: false; error: string } {
    const m = catalogModel(id);
    if (!m) return { ok: false, error: `No model called ${id}.` };
    if (m.engine === "transcribe" && !transcribeSupported()) return { ok: false, error: "transcribe.cpp has a Linux x86_64 build only." };
    const why = this.refuse();
    if (why) return { ok: false, error: why };
    if (m.engine === "transcribe" && !this.engineReady() && this.o.needsCompiler()) return { ok: false, error: "Parakeet needs a C compiler to set up transcribe.cpp. Install it, then Check Again." };
    return this.start(m, "download", async (job, signal) => {
      const paths = this.o.paths();
      const ctx = {
        signal,
        log: (t: string) => this.o.log?.(t),
        progress: (done: number, total: number) => {
          job.progress = { done, total };
        },
        phase: (p: "import" | "download" | "verify") => {
          job.step = p;
          delete job.progress;
        },
      };
      if (m.engine === "transcribe" && !this.engineReady()) {
        job.step = "engine";
        await ensureTranscribeEngine(paths, ctx);
      }
      job.step = "download";
      delete job.progress;
      const got = await ensureFile(m, modelFileOf(paths, m), ctx);
      updateSettings(paths.settingsFile, (s) => {
        const rec = (s.models[m.id] ??= {});
        if (got.importedFrom) rec.importedFrom = got.importedFrom;
        else if (got.result === "done") delete rec.importedFrom;
      });
    });
  }

  /** Switch the host's model: stop dictation's server, self-test the new model, and only then make it active. */
  use(id: string): { ok: true; job: VoiceModelJob } | { ok: false; error: string } {
    const m = catalogModel(id);
    if (!m) return { ok: false, error: `No model called ${id}.` };
    const why = this.refuse();
    if (why) return { ok: false, error: why };
    if (this.o.sweepRunning()) return { ok: false, error: "Calibration is running. Stop it or wait for it to finish." };
    if (!this.ready(m)) return { ok: false, error: `${m.label} ${m.quant} isn't downloaded.` };
    const whisper = this.o.whisper();
    if (!whisper) return { ok: false, error: "Voice isn't set up on this host." };
    const paths = this.o.paths();
    const from = activeModel(paths);
    return this.start(m, "switch", async (job, signal) => {
      job.step = "selftest";
      await this.o.stopRuntime();
      const cfg = runtimeConfigFor(paths, m, whisper.binary, whisper.cpu);
      const stand = m.engine === "transcribe" ? this.o.transcribeBin?.() : null;
      if (stand) cfg.binary = stand;
      let st: SelftestResult;
      try {
        st = await (this.o.selfTest ?? selfTest)(cfg, paths, signal, (t) => this.o.log?.(t));
      } catch (err) {
        if (signal.aborted) throw err;
        const heard = /heard “(.*)”/.exec((err as Error).message)?.[1];
        throw new Error(
          heard !== undefined
            ? `${m.label} ${m.quant} didn't pass the self-test (heard “${heard}”). Still using ${from.label} ${from.quant}.`
            : `${m.label} ${m.quant} didn't start: ${(err as Error).message}. Still using ${from.label} ${from.quant}.`,
        );
      }
      job.step = "switch";
      updateSettings(paths.settingsFile, (s) => {
        s.activeModel = m.id;
        const rec = (s.models[m.id] ??= {});
        rec.selftestMs = st.ms;
        rec.selftestText = st.text;
        rec.selftestAt = Date.now();
      });
      this.o.resetRuntime();
    });
  }

  /** Cancel the running download. Shutdown keeps its marker, so the next server resumes it. */
  cancel(o: { keepMarker?: boolean } = {}): boolean {
    if (!this.running() || this.job!.kind !== "download") return false;
    if (o.keepMarker) this.keepMarker = true;
    this.abort?.abort(new Error("Cancelled"));
    return true;
  }

  /** A download a previous server was running when it stopped: start it again (its .part resumes). */
  resume(): void {
    let id: string | undefined;
    try {
      id = (JSON.parse(readFileSync(this.markerFile(), "utf8")) as { model?: string }).model;
    } catch {
      return;
    }
    const m = id ? catalogModel(id) : undefined;
    if (!m || this.ready(m)) {
      rmSync(this.markerFile(), { force: true });
      return;
    }
    this.download(m.id);
  }

  private keepMarker = false;
  private markerFile(): string {
    return join(this.o.paths().dir, "model-job.json");
  }

  /** Delete a downloaded model's file. Its calibration results stay, for a later download. */
  delete(id: string): { ok: true; freed: number } | { ok: false; error: string } {
    const m = catalogModel(id);
    if (!m) return { ok: false, error: `No model called ${id}.` };
    const paths = this.o.paths();
    if (activeModel(paths).id === m.id) return { ok: false, error: "Switch to another model first." };
    if (this.running() && this.job!.model === m.id) return { ok: false, error: "It's downloading. Cancel the download first." };
    const file = modelFileOf(paths, m);
    let freed = 0;
    for (const f of [file, `${file}.part`]) {
      try {
        freed += statSync(f).size;
      } catch {
        // not there
      }
      rmSync(f, { force: true });
    }
    this.failed.delete(m.id);
    updateSettings(paths.settingsFile, (s) => {
      delete s.models[m.id];
    });
    return { ok: true, freed };
  }

  private start(m: CatalogModel, kind: VoiceModelJob["kind"], body: (job: VoiceModelJob, signal: AbortSignal) => Promise<void>): { ok: true; job: VoiceModelJob } | { ok: false; error: string } {
    const paths = this.o.paths();
    const lock = acquireLock(paths);
    if (lock) return { ok: false, error: lock };
    const job: VoiceModelJob = { id: randomUUID(), model: m.id, kind, step: kind === "switch" ? "selftest" : "download", startedAt: Date.now() };
    this.job = job;
    this.failed.delete(m.id);
    this.keepMarker = false;
    if (kind === "download") writeFileSync(this.markerFile(), JSON.stringify({ model: m.id, at: Date.now() }));
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.done = body(job, signal).then(
      () => {
        job.outcome = "ok";
      },
      (err: unknown) => {
        if (signal.aborted) {
          job.outcome = "cancelled";
          return;
        }
        job.outcome = "failed";
        job.error = sentence((err as Error).message || String(err));
        if (kind === "download") this.failed.set(m.id, job.error);
        this.o.log?.(`  failed: ${job.error}`);
      },
    ).finally(() => {
      delete job.progress;
      job.finishedAt = Date.now();
      if (kind === "download" && !this.keepMarker) rmSync(this.markerFile(), { force: true });
      releaseLock(paths);
    });
    return { ok: true, job };
  }
}

const sentence = (s: string) => {
  const t = s.replace(/\s+/g, " ").trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
};
