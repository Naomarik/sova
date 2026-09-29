// Host detection for voice setup (§app.settings-dialog/voice, step 1 and 2): OS, package manager,
// build tools, the GPU backend, and what a build is missing with the one command that installs it.
// Pure over an injected Probe, so every host shape is a unit test; `systemProbe()` is the real one.

import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { cpus } from "node:os";
import { delimiter, join } from "node:path";
import type { VoiceBackend } from "../../shared/protocol";
import { PREBUILT, PREBUILT_MIN_GLIBC } from "./pins";

export interface Probe {
  platform: string;
  arch: string;
  exists(path: string): boolean;
  readFile(path: string): string | null;
  list(dir: string): string[];
  /** An executable on the voice PATH, or null. */
  which(cmd: string): string | null;
  /** The runtime glibc version ("2.41"), or null (musl, macOS). */
  glibc(): string | null;
  /** A command's stdout, or null when it can't run; short timeout. Used only for the device name. */
  run(argv: string[]): string | null;
  cores(): number;
}

export type PackageManager = "pacman" | "apt" | "dnf" | "zypper" | "brew";

/** What a build can be missing. Package names per manager are in PACKAGES. */
export type Need = "cmake" | "compiler" | "make" | "tar" | "vulkan-headers" | "vulkan-dev" | "glslc" | "xcode";

export interface Detection {
  os: string;
  arch: string;
  distro?: string;
  packageManager?: PackageManager;
  /** The backend a GPU setup builds for; "cpu" when there is no usable GPU backend. */
  backend: VoiceBackend;
  device?: string;
  /** The PREBUILT key this host can run, or null. */
  prebuilt: string | null;
  /** Why voice can't run here at all. */
  unsupported?: string;
}

const LIB_DIRS = ["/usr/lib", "/usr/lib64", "/usr/lib/x86_64-linux-gnu", "/usr/lib/aarch64-linux-gnu", "/usr/local/lib"];
const ICD_DIRS = ["/usr/share/vulkan/icd.d", "/etc/vulkan/icd.d", "/usr/local/share/vulkan/icd.d"];
const INCLUDE_DIRS = ["/usr/include", "/usr/local/include"];

/** `KEY=value` lines of /etc/os-release, quotes stripped. */
export function parseOsRelease(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
  return out;
}

export function packageManagerOf(osRelease: Record<string, string>): PackageManager | undefined {
  const ids = [osRelease.ID ?? "", ...(osRelease.ID_LIKE ?? "").split(/\s+/)].map((s) => s.toLowerCase());
  if (ids.some((i) => ["arch", "manjaro", "endeavouros", "cachyos"].includes(i))) return "pacman";
  if (ids.some((i) => ["debian", "ubuntu"].includes(i))) return "apt";
  if (ids.some((i) => ["fedora", "rhel", "centos"].includes(i))) return "dnf";
  if (ids.some((i) => i.startsWith("opensuse") || i === "suse" || i === "sles")) return "zypper";
  return undefined;
}

const osLabel = (platform: string) => (platform === "darwin" ? "macOS" : platform === "linux" ? "Linux" : platform === "win32" ? "Windows" : platform);

function versionAtLeast(v: string, min: readonly number[]): boolean {
  const parts = v.split(".").map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < min.length; i++) {
    const p = parts[i] ?? 0;
    if (p !== min[i]) return p > min[i]!;
  }
  return true;
}

const hasVulkanLoader = (p: Probe) => LIB_DIRS.some((d) => p.exists(join(d, "libvulkan.so.1")));
const hasVulkanIcd = (p: Probe) => ICD_DIRS.some((d) => p.list(d).some((f) => f.endsWith(".json")));
const hasVulkanHeaders = (p: Probe) => INCLUDE_DIRS.some((d) => p.exists(join(d, "vulkan", "vulkan.h")));
/** The unversioned link cmake's FindVulkan links against (the -dev package's). */
const hasVulkanDev = (p: Probe) => LIB_DIRS.some((d) => p.exists(join(d, "libvulkan.so")));
const hasXcodeTools = (p: Probe) => p.exists("/Library/Developer/CommandLineTools/usr/bin/clang++") || p.exists("/Applications/Xcode.app/Contents/Developer");

function deviceName(p: Probe, backend: VoiceBackend): string | undefined {
  if (backend === "vulkan") {
    const out = p.run(["vulkaninfo", "--summary"]);
    const names = [...(out ?? "").matchAll(/deviceName\s*=\s*(.+)/g)].map((m) => m[1]!.trim());
    return names.find((n) => !/llvmpipe|swiftshader/i.test(n)) ?? undefined;
  }
  if (backend === "cuda") return p.run(["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"])?.split("\n")[0]?.trim() || undefined;
  if (backend === "metal") return p.run(["sysctl", "-n", "machdep.cpu.brand_string"])?.trim() || undefined;
  return undefined;
}

export function detect(p: Probe): Detection {
  const arch = p.arch;
  const base: Omit<Detection, "backend" | "prebuilt"> = { os: osLabel(p.platform), arch };
  if (p.platform !== "linux" && p.platform !== "darwin") {
    return { ...base, backend: "cpu", prebuilt: null, unsupported: `Voice setup supports Linux and macOS hosts. This host runs ${osLabel(p.platform)}.` };
  }
  let distro: string | undefined;
  let packageManager: PackageManager | undefined;
  if (p.platform === "linux") {
    const rel = parseOsRelease(p.readFile("/etc/os-release") ?? "");
    distro = rel.PRETTY_NAME || rel.ID || undefined;
    packageManager = packageManagerOf(rel);
  } else if (p.which("brew")) {
    packageManager = "brew";
  }
  let backend: VoiceBackend = "cpu";
  if (p.platform === "darwin" && arch === "arm64") backend = "metal";
  else if (p.which("nvcc") && p.which("nvidia-smi")) backend = "cuda";
  else if (p.platform === "linux" && hasVulkanLoader(p) && hasVulkanIcd(p)) backend = "vulkan";

  const key = `${p.platform}-${arch}`;
  const glibc = p.glibc();
  const prebuilt = PREBUILT[key] && glibc && versionAtLeast(glibc, PREBUILT_MIN_GLIBC) ? key : null;
  const out: Detection = { ...base, backend, prebuilt };
  if (distro) out.distro = distro;
  if (packageManager) out.packageManager = packageManager;
  const device = deviceName(p, backend);
  if (device) out.device = device;
  return out;
}

/** How this job gets its binary: built from source for `backend`, or the prebuilt CPU tarball. */
export type BuildPlan = { kind: "source"; backend: VoiceBackend } | { kind: "prebuilt"; key: string };

/** GPU mode builds for the detected backend; CPU mode takes the prebuilt where there is one. A
    host whose best backend is the CPU takes the prebuilt too: no toolchain needed. */
export function planFor(det: Detection, mode: "gpu" | "cpu"): BuildPlan {
  if ((mode === "cpu" || det.backend === "cpu") && det.prebuilt) return { kind: "prebuilt", key: det.prebuilt };
  return { kind: "source", backend: mode === "cpu" ? "cpu" : det.backend };
}

/** What the plan needs that this host doesn't have. */
export function missingFor(p: Probe, plan: BuildPlan): Need[] {
  const need: Need[] = [];
  if (!p.which("tar")) need.push("tar");
  if (plan.kind === "prebuilt") return need;
  if (!p.which("cmake")) need.push("cmake");
  if (p.platform === "darwin") {
    if (!hasXcodeTools(p)) need.push("xcode");
  } else {
    if (!p.which("c++") && !p.which("g++") && !p.which("clang++")) need.push("compiler");
    if (!p.which("make") && !p.which("ninja")) need.push("make");
  }
  if (plan.backend === "vulkan") {
    if (!hasVulkanHeaders(p)) need.push("vulkan-headers");
    if (!hasVulkanDev(p)) need.push("vulkan-dev");
    if (!p.which("glslc")) need.push("glslc");
  }
  return need;
}

/** Package names per manager. Arch and Debian/Ubuntu were checked on real hosts; Fedora and
    openSUSE names are from their package indexes, not a real install. */
const PACKAGES: Record<Exclude<PackageManager, "brew">, Record<Exclude<Need, "xcode">, string>> = {
  pacman: { cmake: "cmake", compiler: "base-devel", make: "base-devel", tar: "tar", "vulkan-headers": "vulkan-headers", "vulkan-dev": "vulkan-icd-loader", glslc: "shaderc" },
  apt: { cmake: "cmake", compiler: "build-essential", make: "build-essential", tar: "tar", "vulkan-headers": "libvulkan-dev", "vulkan-dev": "libvulkan-dev", glslc: "glslc" },
  dnf: { cmake: "cmake", compiler: "gcc-c++", make: "make", tar: "tar", "vulkan-headers": "vulkan-headers", "vulkan-dev": "vulkan-loader-devel", glslc: "glslc" },
  zypper: { cmake: "cmake", compiler: "gcc-c++", make: "make", tar: "tar", "vulkan-headers": "vulkan-headers", "vulkan-dev": "vulkan-devel", glslc: "shaderc" },
};
const GENERIC: Record<Need, string> = {
  cmake: "cmake",
  compiler: "a C++17 compiler",
  make: "make or ninja",
  tar: "tar",
  "vulkan-headers": "the Vulkan headers",
  "vulkan-dev": "the Vulkan loader's development files",
  glslc: "glslc (shaderc)",
  xcode: "the Xcode Command Line Tools",
};
const INSTALL: Record<Exclude<PackageManager, "brew">, string> = {
  pacman: "sudo pacman -S --needed",
  apt: "sudo apt-get install -y",
  dnf: "sudo dnf install -y",
  zypper: "sudo zypper install -y",
};

/** The packages to install and the one command that does it; `command` null when there's no known way. */
export function packageCommand(platform: string, pm: PackageManager | undefined, needs: Need[]): { packages: string[]; command: string | null } {
  if (needs.length === 0) return { packages: [], command: null };
  if (platform === "darwin") {
    const parts: string[] = [];
    const packages: string[] = [];
    if (needs.includes("xcode")) {
      parts.push("xcode-select --install");
      packages.push("Xcode Command Line Tools");
    }
    const brew: string[] = [];
    for (const n of needs) if (n !== "xcode" && n !== "compiler" && n !== "make") brew.push(n === "glslc" ? "shaderc" : n);
    const uniq = [...new Set(brew)];
    if (uniq.length) {
      packages.push(...uniq);
      if (pm !== "brew") return { packages, command: null };
      parts.push(`brew install ${uniq.join(" ")}`);
    }
    return { packages, command: parts.join(" && ") };
  }
  if (!pm || pm === "brew") return { packages: [...new Set(needs.map((n) => GENERIC[n]))], command: null };
  const table = PACKAGES[pm];
  const packages = [...new Set(needs.filter((n): n is Exclude<Need, "xcode"> => n !== "xcode").map((n) => table[n]))];
  return { packages, command: `${INSTALL[pm]} ${packages.join(" ")}` };
}

/** The PATH voice looks tools up on and builds with: SOVA_VOICE_PATH, else the server's own. */
export const voicePath = (): string => process.env.SOVA_VOICE_PATH ?? process.env.PATH ?? "";

export function systemProbe(path = voicePath()): Probe {
  const dirs = path.split(delimiter).filter(Boolean);
  return {
    platform: process.platform,
    arch: process.arch,
    exists: (f) => existsSync(f),
    readFile: (f) => {
      try {
        return readFileSync(f, "utf8");
      } catch {
        return null;
      }
    },
    list: (d) => {
      try {
        return readdirSync(d);
      } catch {
        return [];
      }
    },
    which: (cmd) => {
      for (const d of dirs) {
        const f = join(d, cmd);
        try {
          if (!statSync(f).isFile()) continue;
          accessSync(f, constants.X_OK);
          return f;
        } catch {
          // next
        }
      }
      return null;
    },
    glibc: () => {
      const header = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header;
      return header?.glibcVersionRuntime ?? null;
    },
    run: (argv) => {
      try {
        return execFileSync(argv[0]!, argv.slice(1), { encoding: "utf8", timeout: 4000, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, PATH: path } });
      } catch {
        return null;
      }
    },
    cores: () => cpus().length || 1,
  };
}
