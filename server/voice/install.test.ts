import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { acquireLock, DEFAULT_STEPS, lockHolder, NeedsPackages, readInstall, sourceBinaryName, VoiceInstaller, voicePaths, type StepFn } from "./install";
import { MODEL, WHISPER_SOURCE_DIR } from "./pins";
import type { Probe } from "./platform";

const FAKE = fileURLToPath(new URL("../../scripts/fake-whisper-server.mjs", import.meta.url));

const probe = (bins: string[] = ["cmake", "c++", "make", "tar"]): Probe => ({
  platform: "linux",
  arch: "x64",
  exists: () => false,
  readFile: () => "ID=arch\n",
  list: () => [],
  which: (c) => (bins.includes(c) ? `/usr/bin/${c}` : null),
  glibc: () => "2.41",
  run: () => null,
  cores: () => 4,
});

function installer(steps: Partial<Record<string, StepFn>>, bins?: string[]) {
  const paths = voicePaths(mkdtempSync(join(tmpdir(), "voice-inst-")));
  const calls: string[] = [];
  const wrapped: Record<string, StepFn> = {};
  for (const id of ["detect", "packages", "source", "build", "model", "selftest", "finish"]) {
    const fn = steps[id] ?? (async () => "done" as const);
    wrapped[id] = async (ctx) => {
      calls.push(id);
      return fn(ctx);
    };
  }
  const inst = new VoiceInstaller({ paths: () => paths, probe: () => probe(bins), steps: wrapped });
  return { inst, paths, calls };
}

const states = (inst: VoiceInstaller) => inst.job!.steps.map((s) => `${s.id}:${s.state}`).join(" ");

describe("the setup job", () => {
  it("runs every step in order and ends ok", async () => {
    const { inst, calls } = installer({ source: async () => "skipped" });
    const started = inst.start();
    assert.ok(started.ok);
    assert.equal(inst.running(), true);
    await inst.whenDone();
    assert.deepEqual(calls, ["detect", "packages", "source", "build", "model", "selftest", "finish"]);
    assert.equal(inst.job!.outcome, "ok");
    assert.equal(states(inst), "detect:done packages:done source:skipped build:done model:done selftest:done finish:done");
    assert.ok(inst.logSince(0).lines.some((l) => l.text === "Voice is ready."));
  });

  it("missing packages stop it in needs-packages with the command; nothing after runs", async () => {
    const { inst, calls } = installer({ packages: async () => new NeedsPackages(["cmake", "shaderc"], "sudo pacman -S --needed cmake shaderc") });
    inst.start();
    await inst.whenDone();
    assert.equal(inst.job!.outcome, "needs-packages");
    assert.deepEqual(inst.missing, { packages: ["cmake", "shaderc"], command: "sudo pacman -S --needed cmake shaderc" });
    assert.deepEqual(calls, ["detect", "packages"]);
    assert.equal(states(inst), "detect:done packages:failed source:pending build:pending model:pending selftest:pending finish:pending");
  });

  it("a failed step keeps its error; the retry resumes, and a step whose result exists is skipped", async () => {
    let built = false;
    let fail = true;
    const { inst, calls } = installer({
      build: async () => {
        if (built) return "skipped";
        if (fail) throw new Error("cmake --build exited with 2. error: vulkan.h not found.");
        built = true;
        return "done";
      },
    });
    inst.start();
    await inst.whenDone();
    assert.equal(inst.job!.outcome, "failed");
    const step = inst.job!.steps.find((s) => s.id === "build")!;
    assert.equal(step.state, "failed");
    assert.equal(step.error, "cmake --build exited with 2. error: vulkan.h not found");
    fail = false;
    calls.length = 0;
    inst.start();
    await inst.whenDone();
    assert.equal(inst.job!.outcome, "ok");
    calls.length = 0;
    inst.start();
    await inst.whenDone();
    assert.equal(inst.job!.steps.find((s) => s.id === "build")!.state, "skipped");
  });

  it("one job at a time; cancel stops the running step and leaves the rest pending", async () => {
    const { inst } = installer({
      model: (ctx) =>
        new Promise((_, reject) => {
          ctx.progress(1000, MODEL.bytes, "bytes");
          ctx.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    assert.ok(inst.start().ok);
    const again = inst.start();
    assert.equal(again.ok, false);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(inst.job!.steps.find((s) => s.id === "model")!.progress?.done, 1000);
    assert.equal(inst.cancel(), true);
    await inst.whenDone();
    assert.equal(inst.job!.outcome, "cancelled");
    assert.equal(states(inst), "detect:done packages:done source:done build:done model:pending selftest:pending finish:pending");
    assert.equal(inst.running(), false);
  });

  it("the lock: a live other process refuses the job; a dead one's lock is taken over", async () => {
    const { inst, paths } = installer({});
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.lockFile, JSON.stringify({ pid: process.ppid, at: Date.now() }));
    assert.equal(lockHolder(paths), process.ppid);
    const refused = inst.start();
    assert.equal(refused.ok, false);
    assert.match((refused as { error: string }).error, /Another process \(pid \d+\) is setting up voice/);
    writeFileSync(paths.lockFile, JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() }));
    assert.equal(acquireLock(paths), null);
    const ok = inst.start();
    assert.ok(ok.ok);
    await inst.whenDone();
    assert.equal(lockHolder(paths), null);
    assert.throws(() => readFileSync(paths.lockFile), /ENOENT/);
  });

  it("the log reads from a sequence number", async () => {
    const { inst } = installer({});
    inst.start();
    await inst.whenDone();
    const all = inst.logSince(0);
    const tail = inst.logSince(all.lines[2]!.seq);
    assert.equal(tail.lines.length, all.lines.length - 3);
    assert.equal(tail.seq, all.seq);
  });
});

describe("the real steps, on a prepared folder", () => {
  it("skips what exists, self-tests the binary it finds, and writes install.json", async () => {
    const { inst, paths } = installer(
      {
        detect: async (ctx) => {
          ctx.plan = { kind: "source", backend: "cpu" };
          ctx.job.backend = "cpu";
          return "done";
        },
        packages: DEFAULT_STEPS.packages,
        source: DEFAULT_STEPS.source,
        build: DEFAULT_STEPS.build,
        model: DEFAULT_STEPS.model,
        selftest: DEFAULT_STEPS.selftest,
        finish: DEFAULT_STEPS.finish,
      },
      ["cmake", "c++", "make", "tar"],
    );
    mkdirSync(join(paths.src, WHISPER_SOURCE_DIR), { recursive: true });
    writeFileSync(join(paths.src, WHISPER_SOURCE_DIR, "CMakeLists.txt"), "");
    mkdirSync(paths.bin, { recursive: true });
    symlinkSync(FAKE, join(paths.bin, sourceBinaryName("cpu")));
    mkdirSync(paths.models, { recursive: true });
    writeFileSync(paths.modelFile, "");
    truncateSync(paths.modelFile, MODEL.bytes); // sparse: the size is what a non-repair checks
    inst.start();
    await inst.whenDone();
    assert.equal(inst.job!.outcome, "ok", JSON.stringify(inst.job!.steps));
    assert.equal(states(inst), "detect:done packages:done source:skipped build:skipped model:skipped selftest:done finish:done");
    const rec = readInstall(paths);
    assert.ok(rec);
    assert.equal(rec.backend, "cpu");
    assert.equal(rec.binary, `bin/${sourceBinaryName("cpu")}`);
    assert.equal(rec.selftestText, "Open Sova, and run the type check in the worktree.");
    assert.equal(rec.model, MODEL.id);
    assert.match(inst.job!.steps.find((s) => s.id === "selftest")!.note ?? "", /^\d+\.\d s · CPU$/);
  });

  it("a self-test that hears the wrong words fails the job", async () => {
    const prev = process.env.FAKE_WHISPER_TEXT;
    process.env.FAKE_WHISPER_TEXT = "Thank you.";
    try {
      const { inst, paths } = installer({
        detect: async (ctx) => {
          ctx.plan = { kind: "source", backend: "cpu" };
          return "done";
        },
        selftest: DEFAULT_STEPS.selftest,
      });
      mkdirSync(paths.bin, { recursive: true });
      symlinkSync(FAKE, join(paths.bin, sourceBinaryName("cpu")));
      inst.start();
      await inst.whenDone();
      assert.equal(inst.job!.outcome, "failed");
      assert.equal(inst.job!.steps.find((s) => s.id === "selftest")!.error, "The self-test heard “Thank you.”, not the test sentence");
    } finally {
      if (prev === undefined) delete process.env.FAKE_WHISPER_TEXT;
      else process.env.FAKE_WHISPER_TEXT = prev;
    }
  });

  it("packages: the pacman command when cmake is missing", async () => {
    const { inst } = installer(
      {
        detect: async (ctx) => {
          ctx.plan = { kind: "source", backend: "cpu" };
          ctx.det = { os: "Linux", arch: "x64", backend: "cpu", prebuilt: null, packageManager: "pacman" };
          return "done";
        },
        packages: DEFAULT_STEPS.packages,
      },
      ["c++", "make", "tar"],
    );
    inst.start();
    await inst.whenDone();
    assert.deepEqual(inst.missing, { packages: ["cmake"], command: "sudo pacman -S --needed cmake" });
  });
});
