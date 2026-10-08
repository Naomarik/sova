// 16 kHz mono 16-bit WAV from captured Float32 batches (§chat.voice/capture). The encoder and the
// level math are pure; `resampleTo16k` needs the browser's OfflineAudioContext, which low-passes
// on the way down (a naive decimation would alias).

export const TARGET_RATE = 16000;

/** Float32 samples in [-1, 1] → a 16-bit PCM mono WAV. */
export function encodeWav(samples: Float32Array, rate = TARGET_RATE): Uint8Array {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  w(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  w(8, "WAVE");
  w(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

/** Concatenated batches. */
export function joinBatches(batches: Float32Array[]): Float32Array {
  const n = batches.reduce((a, c) => a + c.length, 0);
  const out = new Float32Array(n);
  let o = 0;
  for (const c of batches) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** The clip without the knock of the finger tapping Stop, which a phone's raw mic picks up through
    its body: the first burst at or after `stopAt` (the sample count when Stop was pressed) — a 10 ms
    frame above −45 dBFS and 15 dB over the median of the 100 ms before it, staying that loud for at
    most 80 ms (speech runs longer) — and everything after it go, with a 5 ms fade so the cut doesn't
    click. With no such burst the clip comes back whole. */
export function trimTapNoise(samples: Float32Array, rate: number, stopAt: number): Float32Array {
  const F = Math.max(1, Math.round(rate / 100));
  const count = Math.floor(samples.length / F);
  const db: number[] = [];
  for (let k = 0; k < count; k++) {
    let s = 0;
    for (let i = k * F; i < (k + 1) * F; i++) s += samples[i]! ** 2;
    db.push(10 * Math.log10(s / F + 1e-12));
  }
  for (let k = Math.max(10, Math.ceil(stopAt / F)); k < count; k++) {
    const before = db.slice(k - 10, k).sort((a, b) => a - b);
    const bar = (before[4]! + before[5]!) / 2 + 15;
    if (db[k]! <= -45 || db[k]! < bar) continue;
    let end = k;
    while (end < count && db[end]! >= bar) end++;
    if (end - k > 8) {
      k = end; // a word, not a knock: look past it
      continue;
    }
    const out = samples.slice(0, k * F);
    const fade = Math.min(out.length, Math.round(rate / 200));
    for (let i = 0; i < fade; i++) out[out.length - 1 - i] = out[out.length - 1 - i]! * (i / fade);
    return out;
  }
  return samples;
}

/** A batch RMS as the meter's 0–100: a speaking voice sits around 30–70, silence under 5. */
export const levelOf = (rms: number): number => Math.max(0, Math.min(100, Math.round(Math.sqrt(Math.max(0, rms)) * 220)));

/** The RMS a clip's loudest batch must pass to count as speech (§chat.voice/states "Nothing heard"). */
export const SPEECH_RMS = 0.008;

export async function resampleTo16k(samples: Float32Array, rate: number): Promise<Float32Array> {
  if (!samples.length || rate === TARGET_RATE) return samples;
  const buf = new AudioBuffer({ length: samples.length, sampleRate: rate, numberOfChannels: 1 });
  buf.getChannelData(0).set(samples);
  const off = new OfflineAudioContext(1, Math.ceil((samples.length * TARGET_RATE) / rate), TARGET_RATE);
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(off.destination);
  src.start();
  return (await off.startRendering()).getChannelData(0).slice();
}
