// What voice installs, pinned (§app.settings-dialog/voice). Bump by hand; every value here was
// checked against its source on the day it was written (2026-09-29).

/** The whisper.cpp tag built from source. */
export const WHISPER_TAG = "v1.9.4";
export const WHISPER_SOURCE_URL = `https://github.com/ggml-org/whisper.cpp/archive/refs/tags/${WHISPER_TAG}.tar.gz`;
/** The directory the tag tarball extracts to. */
export const WHISPER_SOURCE_DIR = `whisper.cpp-${WHISPER_TAG.slice(1)}`;

/** The one model: exact, fast on a GPU, and what made "Sova" come out right in the spike. */
export const MODEL = {
  id: "ggml-large-v3-turbo-q5_0",
  file: "ggml-large-v3-turbo-q5_0.bin",
  bytes: 574_041_195,
  sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
  url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin",
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
export const HOTWORDS = ["Sova", "pi", "SolidJS", "worktree", "Vite", "TypeScript", "subagent", "Hono", "pnpm", "Claude", "Codex"];

/** The self-test clip's words (server/voice/selftest.wav, espeak-ng): it passes on 2 of these. */
export const SELFTEST_WORDS = ["sova", "worktree", "type", "check"];
