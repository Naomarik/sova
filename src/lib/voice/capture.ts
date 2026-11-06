// Mic capture for dictation (§chat.voice/capture, §chat.voice/mobile-lifecycle). `startCapture`
// must run synchronously inside the press: it creates the AudioContext there, because iOS leaves
// one created after an await suspended. Raw PCM through an AudioWorklet (a ScriptProcessorNode
// where there is none), never MediaRecorder: iOS records only AAC, which whisper can't read.

import { joinBatches, resampleTo16k, encodeWav, levelOf, trimTapNoise } from "./wav";

export interface Clip {
  wav: Uint8Array;
  /** Seconds of audio. */
  sec: number;
  /** The loudest batch's RMS: under SPEECH_RMS, nothing was said. */
  peakRms: number;
}

export interface Recorder {
  /** Flush, release the mic, and encode what was captured as a 16 kHz WAV. */
  stop(): Promise<Clip>;
  /** Release the mic and drop the audio. */
  cancel(): void;
  /** Seconds captured so far. */
  seconds(): number;
}

export interface CaptureEvents {
  onLevel(level: number): void;
  /** The page went to the background, the track ended or muted, or the context was interrupted. */
  onInterrupt(): void;
}

type Ctor = typeof AudioContext;

/** How long stop keeps recording. */
const POST_ROLL_MS = 350;

/** How long the mic may take to start while no one is being asked anything (§chat.voice/capture). */
export const MIC_START_LIMIT_MS = 10_000;

/** The mic didn't start within its limit. Its `name` picks the strip's sentence (format.ts). */
export class MicStartTimeout extends Error {
  override name = "MicStartTimeout";
  constructor() {
    super("The microphone didn't start in time");
  }
}

export function captureSupported(): { secure: boolean; getUserMedia: boolean; audioContext: boolean } {
  const w = window as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
  return {
    secure: window.isSecureContext,
    getUserMedia: !!navigator.mediaDevices?.getUserMedia,
    audioContext: !!(w.AudioContext ?? w.webkitAudioContext),
  };
}

/** Call synchronously in the press handler. Resolves once audio flows; rejects with getUserMedia's
    error, or MicStartTimeout when a step outlasts its limit. */
export function startCapture(ev: CaptureEvents, limitMs: number = MIC_START_LIMIT_MS): Promise<Recorder> {
  const w = window as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
  const Ctx = (w.AudioContext ?? w.webkitAudioContext)!;
  const ctx = new Ctx();
  return begin(ctx, ev, limitMs).catch((err) => {
    void ctx.close().catch(() => {});
    throw err;
  });
}

/** The site's mic permission, or null where the browser can't say. */
async function micPermission(): Promise<PermissionStatus | null> {
  try {
    return await navigator.permissions.query({ name: "microphone" as PermissionName });
  } catch {
    return null;
  }
}

/**
 * Asks for the mic at once, in the press, and reads the permission beside it. The limit runs only
 * while the permission reads `granted`: a person answering the browser's question is never cut
 * off, and it starts over when they answer Allow. A stream that arrives after the limit is released.
 */
function openMic(limitMs: number): Promise<MediaStream> {
  // Raw: the browser's noise suppression and gain control smear consonants and, on top of a
  // system noise gate, cut words; the speech models are trained on unprocessed audio.
  const asked = navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  return new Promise((resolve, reject) => {
    let over = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let permission: PermissionStatus | null = null;
    const follow = () => {
      clearTimeout(timer);
      timer = undefined;
      if (permission?.state !== "granted") return;
      timer = setTimeout(() => {
        end();
        reject(new MicStartTimeout());
      }, limitMs);
    };
    const end = () => {
      over = true;
      clearTimeout(timer);
      permission?.removeEventListener("change", follow);
    };
    asked.then(
      (stream) => {
        if (over) return stream.getTracks().forEach((t) => t.stop());
        end();
        resolve(stream);
      },
      (err) => {
        if (over) return;
        end();
        reject(err);
      },
    );
    void micPermission().then((status) => {
      if (over || !status) return;
      permission = status;
      status.addEventListener("change", follow);
      follow();
    });
  });
}

/** One limit shared by the steps after the stream arrives. */
function stepLimit(limitMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new MicStartTimeout()), limitMs);
  });
  expired.catch(() => {}); // it may expire between steps, with nothing racing it yet
  return {
    within: <T,>(step: Promise<T>): Promise<T> => Promise.race([step, expired]),
    end: () => clearTimeout(timer),
  };
}

async function begin(ctx: AudioContext, ev: CaptureEvents, limitMs: number): Promise<Recorder> {
  const stream = await openMic(limitMs);
  const stopTracks = () => stream.getTracks().forEach((t) => t.stop());
  const steps = stepLimit(limitMs);
  try {
    await steps.within(ctx.resume().catch(() => {}));
    const batches: Float32Array[] = [];
    let frames = 0;
    let peak = 0;
    const onBatch = (pcm: Float32Array, rms: number) => {
      batches.push(pcm);
      frames += pcm.length;
      if (rms > peak) peak = rms;
      ev.onLevel(levelOf(rms));
    };
    const source = ctx.createMediaStreamSource(stream);
    let node: AudioNode;
    let flush: () => Promise<void>;
    if (ctx.audioWorklet && typeof AudioWorkletNode !== "undefined") {
      await steps.within(ctx.audioWorklet.addModule("/voice-capture-worklet.js"));
      const wn = new AudioWorkletNode(ctx, "voice-capture", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: "explicit" });
      let flushed: (() => void) | null = null;
      wn.port.onmessage = ({ data }: MessageEvent<{ pcm?: Float32Array; rms?: number; flushed?: boolean }>) => {
        if (data.pcm) onBatch(data.pcm, data.rms ?? 0);
        if (data.flushed) flushed?.();
      };
      flush = () =>
        new Promise<void>((r) => {
          flushed = r;
          wn.port.postMessage("flush");
          setTimeout(r, 300); // a suspended context never answers
        });
      node = wn;
    } else {
      const sp = ctx.createScriptProcessor(4096, 1, 1);
      sp.onaudioprocess = (e) => {
        const d = e.inputBuffer.getChannelData(0).slice();
        let s = 0;
        for (let i = 0; i < d.length; i++) s += d[i]! * d[i]!;
        onBatch(d, Math.sqrt(s / (d.length || 1)));
      };
      flush = async () => {};
      node = sp;
    }
    // Through a silent gain to the destination: some engines don't pull a node that goes nowhere.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    source.connect(node);
    node.connect(mute);
    mute.connect(ctx.destination);

    let over = false;
    const interrupt = () => {
      if (!over) ev.onInterrupt();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") interrupt();
    };
    const onState = () => {
      const st = ctx.state as string;
      if (st === "interrupted" || st === "suspended") interrupt();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", interrupt);
    ctx.addEventListener("statechange", onState);
    for (const t of stream.getAudioTracks()) {
      t.addEventListener("ended", interrupt);
      t.addEventListener("mute", interrupt);
    }
    const detach = () => {
      over = true;
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", interrupt);
      ctx.removeEventListener("statechange", onState);
      for (const t of stream.getAudioTracks()) {
        t.removeEventListener("ended", interrupt);
        t.removeEventListener("mute", interrupt);
      }
    };
    const rate = ctx.sampleRate;
    return {
      seconds: () => frames / rate,
      cancel() {
        detach();
        stopTracks();
        void ctx.close().catch(() => {});
      },
      async stop() {
        detach();
        const stopAt = frames;
        // Post-roll: a stop tapped on the last syllable would cut it.
        await new Promise((r) => setTimeout(r, POST_ROLL_MS));
        await flush();
        stopTracks();
        void ctx.close().catch(() => {});
        const pcm = await resampleTo16k(trimTapNoise(joinBatches(batches), rate, stopAt), rate);
        return { wav: encodeWav(pcm), sec: pcm.length / 16000, peakRms: peak };
      },
    };
  } catch (err) {
    stopTracks();
    throw err;
  } finally {
    steps.end();
  }
}
