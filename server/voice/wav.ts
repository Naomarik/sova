// What POST /api/voice/transcribe accepts (§chat.voice/transcribe) and what it hands back: a
// 16 kHz 16-bit PCM mono RIFF/WAVE body in, whisper's text with its non-speech markers out.

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bits: number;
  dataBytes: number;
  /** Where the samples start in the body. */
  dataOffset: number;
  audioSec: number;
}

/** The header of a WAV body, or a sentence saying why it isn't one we take. */
export function inspectWav(buf: Uint8Array): WavInfo | { error: string } {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.length < 44 || b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WAVE") {
    return { error: "The body isn't a RIFF/WAVE file." };
  }
  let off = 12;
  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | null = null;
  while (off + 8 <= b.length) {
    const id = b.toString("ascii", off, off + 4);
    const size = b.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ") {
      if (body + 16 > b.length) return { error: "The WAV fmt chunk is cut short." };
      fmt = { format: b.readUInt16LE(body), channels: b.readUInt16LE(body + 2), sampleRate: b.readUInt32LE(body + 4), bits: b.readUInt16LE(body + 14) };
    } else if (id === "data") {
      if (!fmt) return { error: "The WAV has its data before its fmt chunk." };
      if (fmt.format !== 1 || fmt.bits !== 16) return { error: `The WAV must be 16-bit PCM (got format ${fmt.format}, ${fmt.bits}-bit).` };
      if (fmt.channels !== 1) return { error: `The WAV must be mono (got ${fmt.channels} channels).` };
      if (fmt.sampleRate !== 16000) return { error: `The WAV must be 16 kHz (got ${fmt.sampleRate} Hz).` };
      const dataBytes = Math.min(size, b.length - body);
      return { sampleRate: fmt.sampleRate, channels: fmt.channels, bits: fmt.bits, dataBytes, dataOffset: body, audioSec: dataBytes / (2 * fmt.sampleRate) };
    }
    off = body + size + (size & 1);
  }
  return { error: "The WAV has no data chunk." };
}

/** Why a calibration clip can't be scored fairly (§app.settings-dialog/voice-clip-check), or null.
    Levels are 20 ms frames' RMS; exact zeros only come from processing, never from a raw mic. */
export function clipProblem(buf: Uint8Array, info: WavInfo): string | null {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  const n = info.dataBytes >> 1;
  const x = (i: number) => b.readInt16LE(info.dataOffset + 2 * i) / 32768;
  const db = (from: number, to: number) => {
    let s = 0;
    for (let i = from; i < to; i++) s += x(i) ** 2;
    return 10 * Math.log10(s / Math.max(1, to - from) + 1e-12);
  };
  let full = 0;
  let zeros = 0;
  for (let i = 0; i < n; i++) {
    const v = Math.abs(x(i));
    if (v >= 32767 / 32768) full++;
    if (v === 0) zeros++;
  }
  if (full > n * 0.001) return "This clip is clipping: the mic is too loud. Lower its input level and record again.";
  const loud: number[] = [];
  for (let f = 0; f + 320 <= n; f += 320) if (db(f, f + 320) > -40) loud.push(f);
  if (!loud.length) return "This clip is too quiet to score. Move closer to the mic or raise its input level, and record again.";
  const GATE = "This clip has digital silence inside speech — a system noise gate (like EasyEffects' RNNoise VAD) is cutting your voice. Turn it off and record again.";
  if (zeros > n * 0.1) return GATE;
  let run = 0;
  for (let i = loud[0]!; i < loud.at(-1)! + 320; i++) if ((run = x(i) === 0 ? run + 1 : 0) > 800) return GATE;
  if (n >= 1600 && db(n - 1600, n) > -45) return "This clip ends mid-word. Record it again and stop a moment after the last word.";
  return null;
}

/** Sova's jargon as whisper misspells it (§chat.voice/jargon-fixes): whole words only, and only
    misspellings with no everyday meaning. */
const JARGON_FIXES: [RegExp, string][] = [
  [/\b(?:work[ -]tree|worktreet)(?=s?\b)/gi, "worktree"],
  [/\b(?:sub[ -]agent|subagen)(?=s?\b)/gi, "subagent"],
  [/\bstate[ -]chart(?=s?\b)/gi, "statechart"],
  [/\bclaud\b/gi, "Claude"],
  [/\bsova\b/gi, "Sova"],
  [/\boverseer(?=s?\b)/gi, "Overseer"],
];

/** The transcript with JARGON_FIXES applied; a lowercase fix keeps a capital it replaces. */
export function fixJargon(text: string): string {
  return JARGON_FIXES.reduce((t, [re, w]) => t.replace(re, (m) => (/^[A-Z]/.test(m) ? w[0]!.toUpperCase() + w.slice(1) : w)), text);
}

/** Labels whisper writes in parentheses for sound that isn't speech. A parenthesis in real speech
    ("(and then)") stays: only these words, alone inside one, are dropped. */
const NON_SPEECH = /\(\s*(?:music|applause|laughs?|laughter|silence|inaudible|noise|coughs?|sighs?|breathing|background noise|upbeat music|static|blank_audio|no speech)\s*\)/gi;

/** whisper's text without its markers ([BLANK_AUDIO], [MUSIC], (music), ♪…), whitespace collapsed, jargon fixed. */
export function cleanTranscript(text: string): string {
  return fixJargon(text
    .replace(/\[[^\]]*\]/g, " ")
    .replace(NON_SPEECH, " ")
    .replace(/[♪♫]+/g, " ")
    .replace(/\s+/g, " ")
    .trim());
}

/** The session folder's name as a prompt word: short, letters/digits/._- only, or nothing. A name
    that repeats a hotword is dropped too: "sova-voice-input" in the prompt turned "Sova" into
    "sova" on the test clip. */
export function hintWord(raw: string | undefined, hotwords: readonly string[] = []): string | null {
  const s = (raw ?? "").trim();
  if (!s || s.length > 48 || !/^[\p{L}\p{N}._ -]+$/u.test(s)) return null;
  const lower = s.toLowerCase();
  return hotwords.some((w) => w.length > 2 && lower.includes(w.toLowerCase())) ? null : s;
}
