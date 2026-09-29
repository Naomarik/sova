// What POST /api/voice/transcribe accepts (§chat.voice/transcribe) and what it hands back: a
// 16 kHz 16-bit PCM mono RIFF/WAVE body in, whisper's text with its non-speech markers out.

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bits: number;
  dataBytes: number;
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
      return { sampleRate: fmt.sampleRate, channels: fmt.channels, bits: fmt.bits, dataBytes, audioSec: dataBytes / (2 * fmt.sampleRate) };
    }
    off = body + size + (size & 1);
  }
  return { error: "The WAV has no data chunk." };
}

/** Labels whisper writes in parentheses for sound that isn't speech. A parenthesis in real speech
    ("(and then)") stays: only these words, alone inside one, are dropped. */
const NON_SPEECH = /\(\s*(?:music|applause|laughs?|laughter|silence|inaudible|noise|coughs?|sighs?|breathing|background noise|upbeat music|static|blank_audio|no speech)\s*\)/gi;

/** whisper's text without its markers ([BLANK_AUDIO], [MUSIC], (music), ♪…), whitespace collapsed. */
export function cleanTranscript(text: string): string {
  return text
    .replace(/\[[^\]]*\]/g, " ")
    .replace(NON_SPEECH, " ")
    .replace(/[♪♫]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
