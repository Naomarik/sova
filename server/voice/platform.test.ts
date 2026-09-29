import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detect, missingFor, packageCommand, packageManagerOf, parseOsRelease, planFor, type Probe } from "./platform";

/** A host from a few facts: files that exist, commands on PATH, os-release text. */
function host(o: {
  platform?: string;
  arch?: string;
  files?: string[];
  bins?: string[];
  osRelease?: string;
  glibc?: string | null;
  run?: Record<string, string>;
}): Probe {
  const files = new Set(o.files ?? []);
  const bins = new Set(o.bins ?? []);
  return {
    platform: o.platform ?? "linux",
    arch: o.arch ?? "x64",
    exists: (f) => files.has(f),
    readFile: (f) => (f === "/etc/os-release" ? (o.osRelease ?? null) : null),
    list: (d) => [...files].filter((f) => f.startsWith(`${d}/`)).map((f) => f.slice(d.length + 1)),
    which: (c) => (bins.has(c) ? `/usr/bin/${c}` : null),
    glibc: () => (o.glibc === undefined ? "2.41" : o.glibc),
    run: (argv) => o.run?.[argv[0]!] ?? null,
    cores: () => 8,
  };
}

const ARCH = 'NAME="Arch Linux"\nPRETTY_NAME="Arch Linux"\nID=arch\n';
const UBUNTU = 'PRETTY_NAME="Ubuntu 24.04 LTS"\nID=ubuntu\nID_LIKE=debian\n';
const FEDORA = 'PRETTY_NAME="Fedora Linux 41"\nID=fedora\n';
const TOOLS = ["cmake", "c++", "make", "tar"];
const VULKAN_RUNTIME = ["/usr/lib/libvulkan.so.1", "/usr/share/vulkan/icd.d/radeon_icd.json"];
const VULKAN_DEV = ["/usr/include/vulkan/vulkan.h", "/usr/lib/libvulkan.so"];

describe("os-release", () => {
  it("parses quoted and bare values", () => {
    assert.deepEqual(parseOsRelease(UBUNTU), { PRETTY_NAME: "Ubuntu 24.04 LTS", ID: "ubuntu", ID_LIKE: "debian" });
  });
  it("maps ID and ID_LIKE to a package manager", () => {
    assert.equal(packageManagerOf(parseOsRelease(ARCH)), "pacman");
    assert.equal(packageManagerOf(parseOsRelease(UBUNTU)), "apt");
    assert.equal(packageManagerOf({ ID: "pop", ID_LIKE: "ubuntu debian" }), "apt");
    assert.equal(packageManagerOf(parseOsRelease(FEDORA)), "dnf");
    assert.equal(packageManagerOf({ ID: "opensuse-tumbleweed", ID_LIKE: "opensuse suse" }), "zypper");
    assert.equal(packageManagerOf({ ID: "alpine" }), undefined);
  });
});

describe("detect", () => {
  it("Arch with a Radeon ICD: Vulkan, device from vulkaninfo, prebuilt offered", () => {
    const det = detect(
      host({
        osRelease: ARCH,
        bins: [...TOOLS, "glslc"],
        files: [...VULKAN_RUNTIME, ...VULKAN_DEV],
        run: { vulkaninfo: "GPU0:\n\tdeviceName = AMD Radeon 8060S Graphics (RADV STRIX_HALO)\nGPU1:\n\tdeviceName = llvmpipe (LLVM 19)\n" },
      }),
    );
    assert.equal(det.backend, "vulkan");
    assert.equal(det.device, "AMD Radeon 8060S Graphics (RADV STRIX_HALO)");
    assert.equal(det.packageManager, "pacman");
    assert.equal(det.prebuilt, "linux-x64");
    assert.equal(det.unsupported, undefined);
  });

  it("a loader without an ICD is not Vulkan", () => {
    const det = detect(host({ osRelease: UBUNTU, bins: TOOLS, files: ["/usr/lib/x86_64-linux-gnu/libvulkan.so.1"] }));
    assert.equal(det.backend, "cpu");
  });

  it("nvcc and nvidia-smi together mean CUDA, and win over Vulkan", () => {
    const det = detect(host({ osRelease: UBUNTU, bins: [...TOOLS, "nvcc", "nvidia-smi"], files: VULKAN_RUNTIME, run: { "nvidia-smi": "NVIDIA GeForce RTX 4090\n" } }));
    assert.equal(det.backend, "cuda");
    assert.equal(det.device, "NVIDIA GeForce RTX 4090");
    const noSmi = detect(host({ osRelease: UBUNTU, bins: [...TOOLS, "nvcc"] }));
    assert.equal(noSmi.backend, "cpu");
  });

  it("Apple silicon is Metal; an Intel Mac is CPU; neither gets a prebuilt", () => {
    const m = detect(host({ platform: "darwin", arch: "arm64", bins: ["brew"], glibc: null }));
    assert.equal(m.backend, "metal");
    assert.equal(m.packageManager, "brew");
    assert.equal(m.prebuilt, null);
    const intel = detect(host({ platform: "darwin", arch: "x64", glibc: null }));
    assert.equal(intel.backend, "cpu");
    assert.equal(intel.prebuilt, null);
  });

  it("the prebuilt needs glibc 2.35 or newer", () => {
    assert.equal(detect(host({ osRelease: UBUNTU, glibc: "2.35" })).prebuilt, "linux-x64");
    assert.equal(detect(host({ osRelease: UBUNTU, glibc: "2.31" })).prebuilt, null);
    assert.equal(detect(host({ osRelease: UBUNTU, glibc: null })).prebuilt, null);
    assert.equal(detect(host({ osRelease: UBUNTU, arch: "arm64" })).prebuilt, "linux-arm64");
    assert.equal(detect(host({ osRelease: UBUNTU, arch: "riscv64" })).prebuilt, null);
  });

  it("Windows is unsupported, with the reason", () => {
    const det = detect(host({ platform: "win32" }));
    assert.match(det.unsupported ?? "", /supports Linux and macOS hosts\. This host runs Windows\./);
  });
});

describe("plan and missing packages", () => {
  it("GPU mode builds for the detected backend; CPU mode takes the prebuilt; a CPU-only host takes it too", () => {
    const vk = detect(host({ osRelease: ARCH, files: VULKAN_RUNTIME }));
    assert.deepEqual(planFor(vk, "gpu"), { kind: "source", backend: "vulkan" });
    assert.deepEqual(planFor(vk, "cpu"), { kind: "prebuilt", key: "linux-x64" });
    const cpuOnly = detect(host({ osRelease: UBUNTU }));
    assert.deepEqual(planFor(cpuOnly, "gpu"), { kind: "prebuilt", key: "linux-x64" });
    const oldGlibc = detect(host({ osRelease: UBUNTU, glibc: "2.31" }));
    assert.deepEqual(planFor(oldGlibc, "cpu"), { kind: "source", backend: "cpu" });
  });

  it("a Vulkan build missing glslc, headers and cmake on Arch: the pacman line", () => {
    const p = host({ osRelease: ARCH, bins: ["c++", "make", "tar"], files: VULKAN_RUNTIME });
    const needs = missingFor(p, { kind: "source", backend: "vulkan" });
    assert.deepEqual(needs, ["cmake", "vulkan-headers", "vulkan-dev", "glslc"]);
    assert.deepEqual(packageCommand("linux", "pacman", needs), {
      packages: ["cmake", "vulkan-headers", "vulkan-icd-loader", "shaderc"],
      command: "sudo pacman -S --needed cmake vulkan-headers vulkan-icd-loader shaderc",
    });
  });

  it("Ubuntu with nothing: build-essential once, libvulkan-dev once", () => {
    const p = host({ osRelease: UBUNTU, bins: [], files: VULKAN_RUNTIME });
    const needs = missingFor(p, { kind: "source", backend: "vulkan" });
    assert.deepEqual(packageCommand("linux", "apt", needs), {
      packages: ["tar", "cmake", "build-essential", "libvulkan-dev", "glslc"],
      command: "sudo apt-get install -y tar cmake build-essential libvulkan-dev glslc",
    });
  });

  it("a complete host needs nothing; the prebuilt needs only tar", () => {
    const p = host({ osRelease: ARCH, bins: [...TOOLS, "glslc"], files: [...VULKAN_RUNTIME, ...VULKAN_DEV] });
    assert.deepEqual(missingFor(p, { kind: "source", backend: "vulkan" }), []);
    assert.deepEqual(missingFor(host({ bins: [] }), { kind: "prebuilt", key: "linux-x64" }), ["tar"]);
    assert.deepEqual(missingFor(host({ bins: ["tar"] }), { kind: "prebuilt", key: "linux-x64" }), []);
  });

  it("macOS: xcode-select and brew in one line; no brew means no command", () => {
    const p = host({ platform: "darwin", arch: "arm64", bins: ["tar"] });
    const needs = missingFor(p, { kind: "source", backend: "metal" });
    assert.deepEqual(needs, ["cmake", "xcode"]);
    assert.deepEqual(packageCommand("darwin", "brew", needs), {
      packages: ["Xcode Command Line Tools", "cmake"],
      command: "xcode-select --install && brew install cmake",
    });
    assert.equal(packageCommand("darwin", undefined, needs).command, null);
  });

  it("an unknown distro lists what to install and offers no command", () => {
    const out = packageCommand("linux", undefined, ["cmake", "compiler", "make"]);
    assert.equal(out.command, null);
    assert.deepEqual(out.packages, ["cmake", "a C++17 compiler", "make or ninja"]);
  });
});
