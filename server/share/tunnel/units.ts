import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TunnelKey, TunnelMode } from "../../../shared/public-links";
import { stateHash } from "../../project-services/store";
import { stateRoot } from "../../state-root";
import { CLOUDFLARED_NO_AUTOUPDATE } from "./binary";

/**
 * How a Cloudflare tunnel runs as a unit of its own (§mesh.tunnel/lifetime): its name, slice, files,
 * cloudflared's argv per mode, the unit's systemd properties and the hook script that writes the
 * tunnel's end into the one folder Sova watches. Pure apart from the hook writer, for tests.
 */

export const TUNNEL_SLICE = "sova-tunnels.slice";
/** systemd's (and the detached driver's) stop grace for a tunnel. */
export const TUNNEL_STOP_SEC = 15;
/** Ports a tunnel never forwards to: Sova's own app (4800), its mesh port, and the hermetic app (4810). */
export const FORBIDDEN_TARGETS: ReadonlySet<number> = new Set([4800, 4801, 4810]);

export const tunnelsDir = (): string => join(stateRoot(), "tunnels");
export const tunnelsFile = (dir = tunnelsDir()): string => join(dir, "tunnels.json");
export const hookPath = (dir = tunnelsDir()): string => join(dir, "hook.sh");
export const envDir = (dir = tunnelsDir()): string => join(dir, "env");
export const envFileOf = (unit: string, dir = tunnelsDir()): string => join(envDir(dir), `${unit}.env`);
export const pidFileOf = (unit: string, dir = tunnelsDir()): string => join(dir, `${unit}.pid`);
export const exitFileOf = (unit: string, dir = tunnelsDir()): string => join(dir, `${unit}.exit`);
export const procsDirOf = (dir = tunnelsDir()): string => join(dir, "procs");
export const logsDirOf = (dir = tunnelsDir()): string => join(dir, "logs");

/** Every tunnel unit of this state root starts with this: a hermetic or dev server never adopts the live server's. */
export const tunnelUnitPrefix = (hash = stateHash()): string => `sova-tunnel-${hash}-`;
/** `sova-tunnel-<hash>-share`, `sova-tunnel-<hash>-pv<port>`. */
export const tunnelUnitOf = (key: TunnelKey, hash = stateHash()): string => `${tunnelUnitPrefix(hash)}${key.kind === "share" ? "share" : `pv${key.port}`}`;
/** The key a tunnel is recorded under in tunnels.json. */
export const recordIdOf = (key: TunnelKey): string => (key.kind === "share" ? "share" : `preview:${key.port}`);
export function keyOfRecordId(id: string): TunnelKey | null {
  if (id === "share") return { kind: "share" };
  const m = /^preview:(\d{1,5})$/.exec(id);
  const port = m ? Number(m[1]) : 0;
  return port > 0 && port < 65536 ? { kind: "preview", port } : null;
}
export const sameKey = (a: TunnelKey, b: TunnelKey): boolean => recordIdOf(a) === recordIdOf(b);

export interface ArgvInput {
  cloudflared: string;
  mode: TunnelMode;
  /** Loopback port the tunnel forwards to (quick only; an Account tunnel's routes live in the dashboard). */
  targetPort: number;
  metricsPort: number;
  pidfile: string;
}

/** cloudflared's argv. The updater is always off (an update restarts the process, which would change a
    Free address); an Account tunnel's token comes from TUNNEL_TOKEN in its env, never argv. */
export function cloudflaredArgv(i: ArgvInput): string[] {
  const common = [CLOUDFLARED_NO_AUTOUPDATE, "--metrics", `127.0.0.1:${i.metricsPort}`, "--pidfile", i.pidfile];
  if (i.mode === "account") return [i.cloudflared, "tunnel", ...common, "run"];
  if (FORBIDDEN_TARGETS.has(i.targetPort)) throw new Error(`a tunnel never forwards to port ${i.targetPort}`);
  return [i.cloudflared, "tunnel", ...common, "--grace-period", "5s", "--url", `http://127.0.0.1:${i.targetPort}`];
}

/** A path systemd takes as one word with nothing to expand: no space, quote, `%`, `$` or backslash. */
export const plainPath = (p: string): boolean => /^\/[A-Za-z0-9_./+,:@=-]+$/.test(p);

/** The unit's extra systemd properties: the stop hook on every end (clean stop, crash, OOM kill), and for
    an Account tunnel systemd's own restart (its address never changes). A Free tunnel is never
    restarted by systemd: its restart is a new address, which Sova must see. */
export function unitProperties(mode: TunnelMode, unit: string, hook: string): string[] {
  if (!plainPath(hook)) throw new Error(`the tunnel hook's path can't be given to systemd: ${hook}`);
  const props = [`ExecStopPost=${hook} exited ${unit}`];
  if (mode === "account") props.push("Restart=always", "RestartSec=5", "StartLimitIntervalSec=120", "StartLimitBurst=5");
  return props;
}

/** The detached driver's argv: the hook runs cloudflared, waits for it and writes the same end line. */
export const detachedArgv = (hook: string, unit: string, argv: string[]): string[] => ["/bin/sh", hook, "run", unit, "--", ...argv];

/**
 * The hook (POSIX sh). `exited <unit>`: systemd's ExecStopPost, which gets $SERVICE_RESULT $EXIT_CODE
 * $EXIT_STATUS. `run <unit> -- argv…`: the detached wrapper; TERM/INT/HUP go on to the child. Either
 * writes `<dir>/<unit>.exit` as `<result> <code> <status> <epoch-seconds>`, through a rename, so the
 * watched folder sees one whole file appear.
 */
export const HOOK_SH = `#!/bin/sh
# Sova's tunnel hook: written by Sova, rewritten at each tunnel start. Do not edit.
dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1
mark() {
  t="$dir/$1.exit.$$"
  printf '%s %s %s %s\\n' "$2" "$3" "$4" "$(date +%s)" > "$t" && mv -f "$t" "$dir/$1.exit"
}
case "\${1:-}" in
  exited)
    mark "$2" "\${SERVICE_RESULT:-unknown}" "\${EXIT_CODE:-unknown}" "\${EXIT_STATUS:-}"
    ;;
  run)
    u=$2
    shift 3
    "$@" &
    child=$!
    got=0
    trap 'got=1; kill -TERM "$child" 2>/dev/null' TERM INT HUP
    while :; do
      wait "$child"
      rc=$?
      if [ "$got" = 1 ] && kill -0 "$child" 2>/dev/null; then got=0; continue; fi
      break
    done
    if [ "$rc" -eq 0 ]; then mark "$u" success exited 0
    elif [ "$rc" -gt 128 ]; then mark "$u" signal killed "$((rc - 128))"
    else mark "$u" exit-code exited "$rc"
    fi
    exit "$rc"
    ;;
  *)
    echo "usage: hook.sh exited <unit> | run <unit> -- <argv...>" >&2
    exit 2
    ;;
esac
`;

/** The tunnels folder and its subfolders (detached records hold an Account token; logs hold cloudflared's
    lines): the owner's only, 0700, made so or put back so. */
export function privateDirs(dir = tunnelsDir()): void {
  for (const d of [dir, procsDirOf(dir), logsDirOf(dir), envDir(dir)]) {
    mkdirSync(d, { recursive: true, mode: 0o700 });
    chmodSync(d, 0o700);
  }
}

/** Write the hook (0700) if it differs. */
export function writeHook(dir = tunnelsDir()): string {
  privateDirs(dir);
  const file = hookPath(dir);
  let now = "";
  try {
    now = readFileSync(file, "utf8");
  } catch {
    // none yet
  }
  if (now !== HOOK_SH) {
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, HOOK_SH, { mode: 0o700 });
    renameSync(tmp, file);
  }
  chmodSync(file, 0o700);
  return file;
}

export interface ExitLine {
  /** systemd's $SERVICE_RESULT (`success`, `exit-code`, `signal`, `timeout`, `oom-kill`, …) or the wrapper's own. */
  result: string;
  code: string;
  status: string;
  /** When it ended (ms). */
  at: number;
}

/** A `.exit` file's line, or null when it isn't one. */
export function parseExitLine(text: string): ExitLine | null {
  const m = /^(\S+) (\S+) (\S*) (\d+)$/.exec(text.replace(/\r?\n$/, ""));
  if (!m) return null;
  return { result: m[1]!, code: m[2]!, status: m[3]!, at: Number(m[4]) * 1000 };
}

/** One sentence for how a tunnel ended. */
export function exitReason(e: ExitLine): string {
  if (e.result === "success") return "The tunnel ended.";
  if (e.result === "oom-kill") return "The tunnel was stopped for using too much memory.";
  if (e.code === "killed" || e.result === "signal") return `The tunnel was stopped by a signal (${e.status || "unknown"}).`;
  return `The tunnel ended with an error (exit ${e.status || e.code}).`;
}

/** Log lines with anything shaped like a connector token blanked (a token is base64 JSON: `eyJ…`). */
export const maskSecrets = (lines: string[]): string[] =>
  lines.map((l) => l.replace(/TUNNEL_TOKEN=\S+/g, "TUNNEL_TOKEN=…").replace(/eyJ[A-Za-z0-9+/=_-]{36,}/g, "…").replace(/--token[= ]\S+/g, "--token …"));
