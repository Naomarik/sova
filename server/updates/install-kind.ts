import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { InstallKind } from "../../shared/protocol";
import { realExec, type Exec } from "./git";

/**
 * What kind of copy this server runs from, which decides what an upgrade
 * may do: the installer's checkout, a developer checkout run by a user service, or neither (check
 * only). Everything it reads comes through `InstallProbe`, so its unit tests build each case
 * without a real service.
 */

export const LAUNCHER_MARKER = "# sova-launcher v1";
export const SERVICE_MARKER = "sova-service v1";
export const ENTRY_MARKER = "X-Sova-Launcher=v1";
export const INSTALLER_UNIT = "sova.service";
export const INSTALLER_LABEL = "io.github.naomarik.sova";

export interface ServiceUnit {
  manager: "systemd" | "launchd";
  /** A systemd unit ("sova-runtime.service") or a launchd label ("io.github.naomarik.sova"). */
  name: string;
}

export interface InstallInfo {
  kind: InstallKind;
  whyNot: string | null;
  checkout: string | null;
  /** The user service whose main process this server is, or null. */
  unit: ServiceUnit | null;
  /** Installed copy: its launcher, the port it was installed with, and what the install left out. */
  launcher: string | null;
  installPort: number | null;
  noExtensions: boolean;
  noAppEntry: boolean;
}

export interface InstallProbe {
  checkout: string | null;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  home: string;
  pid: number;
  uid: number;
  agentDir: string;
  readFile(path: string): string | null;
  exists(path: string): boolean;
  isFile(path: string): boolean;
  realpath(path: string): string;
  /** `[link path, its target]` for each symlink in `dir`. */
  links(dir: string): [string, string][];
  exec: Exec;
}

export function realProbe(checkout: string | null, agentDir: string): InstallProbe {
  return {
    checkout,
    env: process.env,
    platform: process.platform,
    home: homedir(),
    pid: process.pid,
    uid: process.getuid?.() ?? 0,
    agentDir,
    readFile: (p) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
    exists: (p) => existsSync(p),
    isFile: (p) => {
      try {
        return lstatSync(p).isFile();
      } catch {
        return false;
      }
    },
    realpath: (p) => {
      try {
        return realpathSync(p);
      } catch {
        return resolve(p);
      }
    },
    links: (dir) => {
      try {
        return readdirSync(dir)
          .map((n) => join(dir, n))
          .flatMap((p): [string, string][] => {
            try {
              return lstatSync(p).isSymbolicLink() ? [[p, readlinkSync(p)]] : [];
            } catch {
              return [];
            }
          });
      } catch {
        return [];
      }
    },
    exec: realExec,
  };
}

/** A `printf %q` word as bash would read it back (the launcher's `dir=` line); null for a form it doesn't write. */
export function unquoteShell(word: string): string | null {
  if (word.startsWith("$'")) return null;
  if (word.startsWith("'") && word.endsWith("'") && word.length >= 2) return word.slice(1, -1);
  let out = "";
  for (let i = 0; i < word.length; i++) {
    const ch = word[i]!;
    if (ch === "\\" && i + 1 < word.length) out += word[++i];
    else out += ch;
  }
  return out;
}

/** The launcher's own facts: the install it runs and the port it was written with; null when it isn't the installer's. */
export function parseLauncher(text: string): { dir: string; port: number | null } | null {
  if (!text.split("\n").slice(0, 5).some((l) => l.trim() === LAUNCHER_MARKER)) return null;
  const dirLine = /^dir=(.+)$/m.exec(text);
  const dir = dirLine ? unquoteShell(dirLine[1]!.trim()) : null;
  if (!dir) return null;
  const port = /^install_port=(\d+)$/m.exec(text);
  return { dir, port: port ? Number(port[1]) : null };
}

/** The systemd unit a `/proc/self/cgroup` puts this process in, when it is a unit of the user's manager. */
export function userUnitOfCgroup(cgroup: string): string | null {
  const line = cgroup.split("\n").find((l) => l.startsWith("0::")) ?? cgroup.split("\n")[0] ?? "";
  const path = line.replace(/^[^:]*:[^:]*:/, "");
  const parts = path.split("/").filter(Boolean);
  const mgr = parts.findIndex((p) => /^user@\d+\.service$/.test(p));
  const last = parts[parts.length - 1];
  return mgr >= 0 && last && last !== parts[mgr] && last.endsWith(".service") ? last : null;
}

/** The ExecStart program of a unit file, or a launchd plist's first ProgramArguments string. */
export function serviceProgram(text: string): string | null {
  const exec = /^ExecStart=(.+)$/m.exec(text);
  if (exec) {
    const v = exec[1]!.trim();
    return v.startsWith('"') ? v.slice(1, v.indexOf('"', 1)).replace(/\\(.)/g, "$1") : v.split(/\s+/)[0]!;
  }
  const plist = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]+)<\/string>/.exec(text);
  return plist ? plist[1]!.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&") : null;
}

/** The user service whose main process this server is (systemd: its cgroup's unit and MainPID; launchd: XPC_SERVICE_NAME and its pid). */
export async function ownServiceUnit(p: InstallProbe): Promise<ServiceUnit | null> {
  if (p.platform === "darwin") {
    const label = p.env.XPC_SERVICE_NAME;
    if (!label || label === "0" || label.startsWith("application.")) return null;
    const r = await p.exec("launchctl", ["print", `gui/${p.uid}/${label}`], { timeoutMs: 5_000 });
    const pid = /^\s*pid = (\d+)/m.exec(r.stdout);
    return r.code === 0 && pid && Number(pid[1]) === p.pid ? { manager: "launchd", name: label } : null;
  }
  if (p.platform !== "linux") return null;
  const unit = userUnitOfCgroup(p.readFile("/proc/self/cgroup") ?? "");
  if (!unit) return null;
  const r = await p.exec("systemctl", ["--user", "show", "--property=MainPID", "--value", unit], { timeoutMs: 5_000 });
  return r.code === 0 && Number(r.stdout.trim()) === p.pid ? { manager: "systemd", name: unit } : null;
}

const CHECK_ONLY = (checkout: string | null, whyNot: string): InstallInfo => ({ kind: "check-only", whyNot, checkout, unit: null, launcher: null, installPort: null, noExtensions: false, noAppEntry: false });

export async function detectInstall(p: InstallProbe): Promise<InstallInfo> {
  const checkout = p.checkout;
  if (!checkout) return CHECK_ONLY(null, "This server doesn't run from a git checkout, so it can't check or upgrade.");
  if (p.isFile(join(checkout, ".git"))) return CHECK_ONLY(checkout, "This copy runs from a worktree, so it updates with git, not from here.");
  if (!p.exists(join(checkout, ".git"))) return CHECK_ONLY(checkout, "This copy isn't a git checkout of its own, so it updates with git, not from here.");
  const unit = await ownServiceUnit(p);
  const real = p.realpath(checkout);

  // The installer's checkout: its launcher points here, and it carries its own Bun.
  const xdgConfig = p.env.XDG_CONFIG_HOME || join(p.home, ".config");
  const unitFile = p.platform === "darwin" ? join(p.home, "Library/LaunchAgents", `${INSTALLER_LABEL}.plist`) : join(xdgConfig, "systemd/user", INSTALLER_UNIT);
  const unitText = p.readFile(unitFile);
  const ourService = !!unitText && unitText.includes(SERVICE_MARKER);
  const candidates = [p.env.SOVA_LAUNCHER, ourService ? serviceProgram(unitText!) : null, join(p.home, ".local/bin/sova")].filter((x): x is string => !!x);
  if (p.exists(join(checkout, ".bun/bin/bun"))) {
    for (const launcher of candidates) {
      const text = p.readFile(launcher);
      const parsed = text ? parseLauncher(text) : null;
      if (!parsed || p.realpath(parsed.dir) !== real) continue;
      // The installer's service, when it is what runs this server; else the launcher started it.
      const installerUnit = unit && (unit.name === INSTALLER_UNIT || unit.name === INSTALLER_LABEL) && ourService ? unit : null;
      const extDir = join(p.agentDir, "extensions");
      const ours = join(checkout, "pi-config/extensions");
      const noExtensions = !p.links(extDir).some(([, target]) => target.startsWith(`${ours}/`) || target.startsWith(`${real}/pi-config/extensions/`));
      const entry =
        p.platform === "darwin" ? p.readFile(join(p.home, "Applications/Sova.app/Contents/Info.plist")) : p.readFile(join(p.env.XDG_DATA_HOME || join(p.home, ".local/share"), "applications/sova.desktop"));
      return { kind: "installer", whyNot: null, checkout, unit: installerUnit, launcher, installPort: parsed.port, noExtensions, noAppEntry: !entry?.includes(ENTRY_MARKER) };
    }
  }
  if (unit) return { kind: "developer", whyNot: null, checkout, unit, launcher: null, installPort: null, noExtensions: false, noAppEntry: false };
  return CHECK_ONLY(checkout, "This copy isn't run by a service, so it can't restart itself after an upgrade. Update it with git.");
}

/** The launcher's directory, for install.sh's --bin. */
export const binDirOf = (launcher: string): string => dirname(launcher);
