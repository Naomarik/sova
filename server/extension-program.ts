// The program an extension names: started, stopped and logged through the project
// services driver, as a unit of its own, so it outlives a server restart and Turn Off still finds it. Both
// drivers run with no restart of their own: a driver's Restart=on-failure would bring a program back on code
// you haven't approved, so a failed one comes back through Sova's pass (server/extension-loader.ts).
import { execFileSync } from "node:child_process";
import { accessSync, constants, mkdirSync, realpathSync } from "node:fs";
import { createServer } from "node:net";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { selectDriver } from "./project-services/adapters";
import { DetachedDriver, DriverError, realExec, SystemdDriver, type Driver, type UnitStatus } from "./project-services/drivers";
import { inheritedEnv } from "./project-services/env-allow";
import { stateHash } from "./project-services/store";
import { extensionKeys, keyFileName } from "./extension-keys";
import { clearHealthOf, sovaOrigin } from "./extensions";
import { stateRoot } from "./state-root";

const programsRoot = (): string => join(stateRoot(), "extension-programs");

/** `<state root>/extension-data/<id>`, kept apart by the key file's name rule when ids differ only in case. */
export function extensionDataDir(id: string): string {
  return join(stateRoot(), "extension-data", id === id.toLowerCase() ? id : keyFileName(id).replace(/\.key$/, ""));
}

export const unitPrefix = (): string => `sova-ext-${stateHash()}-`;
export const unitOf = (id: string): string => `${unitPrefix()}${id}`;

type Chosen = { id: string; driver: Driver | null };
let chosen: { root: string; pending: Promise<Chosen> } | null = null;

/** This state root's driver, chosen once as project services choose theirs. */
function choice(): Promise<Chosen> {
  const root = stateRoot();
  if (chosen?.root === root) return chosen.pending;
  const detached = () => new DetachedDriver(15_000, { restart: false, procsDir: () => join(programsRoot(), "procs"), logsDir: () => join(programsRoot(), "logs") });
  const pending = selectDriver({ detached }).then((s): Chosen => ({ id: s.id, driver: s.id === "systemd" ? new SystemdDriver(realExec, { restart: false }) : s.driver }));
  chosen = { root, pending };
  return pending;
}

const driverOf = async (): Promise<Driver> => {
  const c = await choice();
  if (!c.driver) throw new DriverError("this computer has no service manager Sova can use");
  return c.driver;
};

/** It comes back when Sova starts, not by itself at login. */
export const noServiceManager = async (): Promise<boolean> => (await choice()).id !== "systemd";

const runnable = (p: string): boolean => {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const onPath = (name: string, path: string | undefined): string | null => {
  for (const dir of (path ?? "").split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, name);
    if (runnable(p)) return p;
  }
  return null;
};

/** mise's shim needs a trusted config where it runs, and an extension's folder has none: use what it points at. */
function throughMise(name: string, folder: string): string | null {
  try {
    const p = execFileSync("mise", ["which", name], { cwd: folder, encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    return p && runnable(p) ? p : null;
  } catch {
    return null;
  }
}

/**
 * The program's first word → what to start, or null when it can't be found. A relative path starts from
 * its folder. A bare name is looked for on Sova's PATH, seen through mise's shims. `node` always has an
 * answer: SOVA_NODE, then this server's own runtime, because a service's PATH often holds no node.
 */
export function resolveProgram(word: string, folder: string, env: NodeJS.ProcessEnv = process.env, execPath: string = process.execPath): string | null {
  if (isAbsolute(word)) return runnable(word) ? word : null;
  if (word.includes("/")) {
    const p = resolve(folder, word);
    return runnable(p) ? p : null;
  }
  const found = onPath(word, env.PATH);
  if (found) {
    let real = found;
    try {
      real = realpathSync(found);
    } catch {
      // the path as found
    }
    const shim = found.includes("/shims/") || /\/mise(\.exe)?$/.test(real);
    return shim ? (throughMise(word, folder) ?? (word === "node" ? (env.SOVA_NODE ?? execPath) : found)) : found;
  }
  if (word === "node") return env.SOVA_NODE ?? execPath;
  return null;
}

export interface ProgramSpec {
  id: string;
  run: string[];
  folder: string;
  /** http://127.0.0.1:<port>: PORT is its port. */
  api: string;
}

/** The environment it gets: the small allow-list, its address and its key's file. Never Sova's token. */
export function programEnv(spec: ProgramSpec, port: string, keyFile: string, dataDir: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return { ...inheritedEnv(env), PORT: port, SOVA_URL: sovaOrigin(), SOVA_EXTENSION_ID: spec.id, SOVA_EXTENSION_KEY_FILE: keyFile, SOVA_EXTENSION_DATA_DIR: dataDir };
}

export class ProgramNotFound extends Error {
  constructor(readonly program: string) {
    super(`Couldn't find ${program}.`);
  }
}

/** Start it, with its key written first. Starting one already running does nothing. */
export async function startProgram(spec: ProgramSpec): Promise<void> {
  const exe = resolveProgram(spec.run[0]!, spec.folder);
  if (!exe) throw new ProgramNotFound(spec.run[0]!);
  extensionKeys.sync();
  const dataDir = extensionDataDir(spec.id);
  mkdirSync(dataDir, { recursive: true });
  const d = await driverOf();
  const st = await d.status(unitOf(spec.id));
  if (st.state === "active" || st.state === "activating") return;
  clearHealthOf(spec.id);
  await d.start({ unit: unitOf(spec.id), argv: [exe, ...spec.run.slice(1)], cwd: spec.folder, env: programEnv(spec, new URL(spec.api).port, extensionKeys.fileOf(spec.id), dataDir) });
}

export async function stopProgram(id: string): Promise<void> {
  await (await driverOf()).stop(unitOf(id));
  clearHealthOf(id);
}

export const programStatus = async (id: string): Promise<UnitStatus> => (await choice()).driver?.status(unitOf(id)) ?? { state: "missing", pid: null };

export const programLog = async (id: string, lines: number): Promise<{ t: string; text: string }[]> => (await choice()).driver?.logs(unitOf(id), lines) ?? [];

/** The ids of this state root's units, running or recorded. */
export async function programUnits(): Promise<string[]> {
  const d = (await choice()).driver;
  if (!d) return [];
  const prefix = unitPrefix();
  return (await d.units(prefix)).map((u) => u.slice(prefix.length));
}

/** A free port on the loopback. */
export function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const s = createServer();
    s.unref();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      s.close(() => (a && typeof a === "object" ? done(a.port) : fail(new Error("no port"))));
    });
  });
}

/** Tests: choose the driver again. */
export const resetProgramDriverForTest = (): void => {
  chosen = null;
};
