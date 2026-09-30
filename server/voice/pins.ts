// What voice installs, pinned (§app.settings-dialog/voice). Bump by hand; every value here was
// checked against its source on the day it was written (2026-09-29).

/** The whisper.cpp tag built from source. */
export const WHISPER_TAG = "v1.9.4";
export const WHISPER_SOURCE_URL = `https://github.com/ggml-org/whisper.cpp/archive/refs/tags/${WHISPER_TAG}.tar.gz`;
/** The directory the tag tarball extracts to. */
export const WHISPER_SOURCE_DIR = `whisper.cpp-${WHISPER_TAG.slice(1)}`;

/** A model voice can download and run (§app.settings-dialog/voice-models). */
export interface CatalogModel {
  id: string;
  /** The file name in `<voice dir>/models` (and what an import folder is searched for). */
  file: string;
  url: string;
  bytes: number;
  sha256: string;
  label: string;
  quant: string;
  languages: "en" | "multi";
  engine: "whisper" | "transcribe";
  default?: true;
}

const HF_WHISPER = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

/**
 * The catalog, smallest first. Sizes and sha256 are the Hugging Face tree API's `size` and
 * `lfs.oid` (its sha256), read 2026-09-29.
 */
export const CATALOG: readonly CatalogModel[] = [
  {
    // Exact, fast on a GPU, and what made "Sova" come out right in the spike.
    id: "ggml-large-v3-turbo-q5_0",
    file: "ggml-large-v3-turbo-q5_0.bin",
    url: `${HF_WHISPER}/ggml-large-v3-turbo-q5_0.bin`,
    bytes: 574_041_195,
    sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
    label: "large-v3-turbo",
    quant: "q5_0",
    languages: "multi",
    engine: "whisper",
    default: true,
  },
  {
    // transcribe.cpp's GGUF port of NVIDIA's English Parakeet: no prompt, so calibration only scores it.
    id: "parakeet-tdt-0.6b-v2-q8_0",
    file: "parakeet-tdt-0.6b-v2-Q8_0.gguf",
    url: "https://huggingface.co/handy-computer/parakeet-tdt-0.6b-v2-gguf/resolve/main/parakeet-tdt-0.6b-v2-Q8_0.gguf",
    bytes: 729_574_912,
    sha256: "f0d0e99cebb6d3b83f1f7069b82b5d3c2e39a54545b0da039cb4bafd9c4e5caa",
    label: "Parakeet TDT 0.6B v2",
    quant: "q8_0",
    languages: "en",
    engine: "transcribe",
  },
  {
    id: "ggml-large-v3-turbo-q8_0",
    file: "ggml-large-v3-turbo-q8_0.bin",
    url: `${HF_WHISPER}/ggml-large-v3-turbo-q8_0.bin`,
    bytes: 874_188_075,
    sha256: "317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1",
    label: "large-v3-turbo",
    quant: "q8_0",
    languages: "multi",
    engine: "whisper",
  },
  {
    id: "ggml-large-v3-q5_0",
    file: "ggml-large-v3-q5_0.bin",
    url: `${HF_WHISPER}/ggml-large-v3-q5_0.bin`,
    bytes: 1_081_140_203,
    sha256: "d75795ecff3f83b5faa89d1900604ad8c780abd5739fae406de19f23ecd98ad1",
    label: "large-v3",
    quant: "q5_0",
    languages: "multi",
    engine: "whisper",
  },
  {
    // The official f16 from distil-whisper; its repo names the file ggml-model.bin, so it gets its own name here.
    id: "ggml-distil-large-v3.5",
    file: "ggml-distil-large-v3.5.bin",
    url: "https://huggingface.co/distil-whisper/distil-large-v3.5-ggml/resolve/main/ggml-model.bin",
    bytes: 1_519_521_155,
    sha256: "ec2498919b498c5f6b00041adb45650124b3cd9f26f545fffa8f5d11c28dcf26",
    label: "distil-large-v3.5",
    quant: "f16",
    languages: "en",
    engine: "whisper",
  },
  {
    id: "ggml-large-v3-turbo",
    file: "ggml-large-v3-turbo.bin",
    url: `${HF_WHISPER}/ggml-large-v3-turbo.bin`,
    bytes: 1_624_555_275,
    sha256: "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69",
    label: "large-v3-turbo",
    quant: "f16",
    languages: "multi",
    engine: "whisper",
  },
];

export const DEFAULT_MODEL: CatalogModel = CATALOG.find((m) => m.default)!;
/** The model setup installs. */
export const MODEL = DEFAULT_MODEL;

export const catalogModel = (id: string): CatalogModel | undefined => CATALOG.find((m) => m.id === id);

/** Silero voice detection for whisper-server's `-vm` (ggml-org/whisper-vad, read 2026-09-29).
    Fetched beside every whisper model: 885 KB, and a request with `vad` fails without it. */
export const VAD_MODEL = {
  id: "ggml-silero-v6.2.0",
  file: "ggml-silero-v6.2.0.bin",
  url: "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin",
  bytes: 885_098,
  sha256: "2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987",
} as const;

/**
 * transcribe.cpp, the Parakeet engine: its prebuilt Linux x86_64 Vulkan release (GitHub release
 * asset digest, read 2026-09-29) holds libtranscribe and ggml but no program, so setup compiles
 * server/voice/transcribe-host.c against it with the header of the same tag.
 */
export const TRANSCRIBE_CPP = {
  tag: "v0.2.4",
  platform: "linux-x64",
  url: "https://github.com/handy-computer/transcribe.cpp/releases/download/v0.2.4/transcribe-native-0.2.4-linux-x86_64-cpu-vulkan.tar.gz",
  bytes: 21_607_373,
  sha256: "28b22a523a25b41d59ff91147b6f79f35330663c92c22e483d15d6f4dc0cfc9a",
  dir: "transcribe-native-linux-x86_64-cpu-vulkan",
  headerUrl: "https://raw.githubusercontent.com/handy-computer/transcribe.cpp/v0.2.4/include/transcribe.h",
  headerBytes: 137_600,
  headerSha256: "288457c5b1d974d164b545609d8483c90fb73c9715e734e8886e7ef0d72d18f8",
} as const;

/**
 * The prebuilt CPU binaries (Linux only: releases ship no macOS server, and Windows isn't a Sova
 * host). Rolling build tag b5130 is whisper.cpp 1.9.4, built on ubuntu-22.04, so it needs glibc
 * 2.35 or newer. The tarball holds whisper-server beside its shared libraries (RUNPATH $ORIGIN),
 * so the whole directory is kept.
 */
export const PREBUILT: Record<string, { url: string; bytes: number; sha256: string; dir: string }> = {
  "linux-x64": {
    url: "https://github.com/ggml-org/whisper.cpp/releases/download/b5130/whisper-bin-ubuntu-x64.tar.gz",
    bytes: 9_793_438,
    sha256: "53e7fd8b5764edad916b8848dd0af6abb1ff1d3b86c899e79c78652412536c32",
    dir: "whisper-bin-ubuntu-x64",
  },
  "linux-arm64": {
    url: "https://github.com/ggml-org/whisper.cpp/releases/download/b5130/whisper-bin-ubuntu-arm64.tar.gz",
    bytes: 4_605_905,
    sha256: "93532a0e3777f26f041ffa358ee77dd88b1a33a86847c1990745327ff335a5d6",
    dir: "whisper-bin-ubuntu-arm64",
  },
};
export const PREBUILT_MIN_GLIBC = [2, 35] as const;
export const PREBUILT_TAG = "b5130";

/** whisper has no hotword list; an initial prompt biases spelling the same way. */
export const HOTWORDS = ["Sova", "pi", "SolidJS", "worktree", "Vite", "TypeScript", "subagent", "Hono", "pnpm", "Claude", "Codex", "Overseer", "statechart"];

/** The same words as one punctuated sentence: whisper follows a prompt's style, and a list may
    pull the output toward a list's. Calibration tries both. It shares no phrasing with the
    calibration sentences, so it can't flatter its own rows. */
export const PROMPT_SENTENCE =
  "Sova is written in TypeScript with SolidJS, Hono, Vite and pnpm; its Overseer, subagent, statechart and worktree code works with pi, Claude and Codex.";

/** The self-test clip's words (server/voice/selftest.wav, espeak-ng): it passes on 2 of these. */
export const SELFTEST_WORDS = ["sova", "worktree", "type", "check"];
