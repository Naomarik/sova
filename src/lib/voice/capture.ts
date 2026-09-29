// Mic capture for dictation (§chat.voice/capture, §chat.voice/mobile-lifecycle). `startCapture`
// must run synchronously inside the press: it creates the AudioContext there, because iOS leaves
// one created after an await suspended. Raw PCM through an AudioWorklet (a ScriptProcessorNode
// where there is none), never MediaRecorder: iOS records only AAC, which whisper can't read.

import { joinBatches, resampleTo16k, encodeWav, levelOf } from "./wav";

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

export function captureSupported(): { secure: boolean; getUserMedia: boolean; audioContext: boolean } {
  const w = window as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
  return {
    secure: window.isSecureContext,
    getUserMedia: !!navigator.mediaDevices?.getUserMedia,
    audioContext: !!(w.AudioContext ?? w.webkitAudioContext),
  };
}

/** Call synchronously in the press handler. Resolves once audio flows; rejects with getUserMedia's error. */
export function startCapture(ev: CaptureEvents): Promise<Recorder> {
  const w = window as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
  const Ctx = (w.AudioContext ?? w.webkitAudioContext)!;
  const ctx = new Ctx();
  return begin(ctx, ev).catch((err) => {
    void ctx.close().catch(() => {});
    throw err;
  });
}

async function begin(ctx: AudioContext, ev: CaptureEvents): Promise<Recorder> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const stopTracks = () => stream.getTracks().forEach((t) => t.stop());
  try {
    await ctx.resume().catch(() => {});
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
      await ctx.audioWorklet.addModule("/voice-capture-worklet.js");
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
        await flush();
        stopTracks();
        void ctx.close().catch(() => {});
        const pcm = await resampleTo16k(joinBatches(batches), rate);
        return { wav: encodeWav(pcm), sec: pcm.length / 16000, peakRms: peak };
      },
    };
  } catch (err) {
    stopTracks();
    throw err;
  }
}
