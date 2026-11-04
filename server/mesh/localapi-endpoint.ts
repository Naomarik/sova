import { execFile as execFileCb } from "node:child_process";
import { lstat, readFile, readlink } from "node:fs/promises";

// Where this host's own Tailscale LocalAPI answers, found with no setting (Node builtins only):
// - SOVA_TAILSCALE_SOCKET, when set: that socket, on every platform, and nothing else is looked at.
// - Every platform but macOS: tailscaled's socket at DEFAULT_TAILSCALE_SOCKET, with no file read and
//   no program started to find it, so Linux does exactly what it did before this module.
// - macOS: the first kind of install found, in this order.
//   1. Tailscale's app from tailscale.com: /Library/Tailscale/ipnport, a symlink whose text is the
//      port on 127.0.0.1, and sameuserproof-<port>, the key. Both must be root's, and the key file a
//      plain file nobody else may write, so another account can neither point Sova at a port of its
//      choosing nor plant a key. Read again for every request: the app writes a new port and key when
//      it restarts. A key this account can't read (EACCES) means it isn't an administrator.
//   2. The App Store app: its port and key from lsof over this account's own IPNExtension processes
//      (the sameuserproof-<port>-<key> file they hold open), as Tailscale's own CLI finds it outside
//      its sandbox. Never the app's group container itself: reading that can raise macOS's "access
//      data from other apps" prompt.
//   3. Homebrew or open-source tailscaled: the socket /var/run/tailscaled.socket.
//   What 2 or 3 found is kept in memory until a request through it fails (forgetLocalApiEndpoint).
//   The app's files outlive the app, so a caller whose request to the app's port was refused asks
//   again passing that endpoint over (localApiEndpoint(passOver)), and the next kind is tried.
// Nothing here runs at import, at boot or on a timer: only when a LocalAPI request asks (localapi.ts).

export const DEFAULT_TAILSCALE_SOCKET = "/var/run/tailscale/tailscaled.sock";
const APP_DIR = "/Library/Tailscale";
const LSOF = "/usr/sbin/lsof";
const APP_STORE_KEY_FILE = ".tailscale.ipn.macos/sameuserproof-";

export type Endpoint = { kind: "socket"; path: string } | { kind: "tcp"; port: number; token: string; source: "app" | "appstore" };

/** Nothing found: no kind of install at all, or only an app whose key this account can't read. */
export class EndpointError extends Error {
  constructor(readonly reason: "missing" | "not-admin") {
    super(reason === "missing" ? "no Tailscale LocalAPI found" : "Tailscale's key can't be read by this account");
  }
}

export interface FileInfo {
  uid: number;
  mode: number;
  isFile(): boolean;
  isSymbolicLink(): boolean;
  isSocket(): boolean;
}

interface Deps {
  platform: string;
  env: Record<string, string | undefined>;
  uid: () => number;
  lstat: (path: string) => Promise<FileInfo>;
  readlink: (path: string) => Promise<string>;
  readFile: (path: string) => Promise<string>;
  /** The program's stdout when it exits 0; rejects otherwise (lsof exits 1 when nothing matches). */
  execFile: (file: string, args: string[], opts: { timeout: number }) => Promise<string>;
  /** Homebrew's tailscaled socket. */
  brewSocket: string;
}

const defaults: Deps = {
  platform: process.platform,
  env: process.env,
  uid: () => process.getuid?.() ?? -1,
  lstat: (path) => lstat(path),
  readlink: (path) => readlink(path),
  readFile: (path) => readFile(path, "utf8"),
  execFile: (file, args, opts) =>
    new Promise((resolve, reject) => execFileCb(file, args, { ...opts, encoding: "utf8" }, (err, stdout) => (err ? reject(err) : resolve(stdout)))),
  brewSocket: "/var/run/tailscaled.socket",
};
let deps: Deps = defaults;

/** Tests: replace some dependencies; returns the undo. */
export function setLocalApiEndpointDeps(partial: Partial<Deps>): () => void {
  const before = deps;
  deps = { ...deps, ...partial };
  return () => {
    deps = before;
  };
}

/** Whether this host is a Mac (its LocalAPI errors are then worded for a Mac, localapi.ts). */
export const onMac = (): boolean => deps.platform === "darwin";

let remembered: Endpoint | null = null;

/** A request through the endpoint failed: look again next time. */
export function forgetLocalApiEndpoint(): void {
  remembered = null;
}

const same = (a: Endpoint, b: Endpoint | undefined): boolean =>
  !!b && (a.kind === "socket" ? b.kind === "socket" && a.path === b.path : b.kind === "tcp" && a.port === b.port && a.token === b.token);

const portOf = (text: string): number | null => {
  if (!/^\d{1,5}$/.test(text)) return null;
  const port = Number(text);
  return port >= 1 && port <= 65535 ? port : null;
};

/** The tailscale.com app's port and key, null when it isn't there (or isn't root's), "not-admin"
    when this account can't read its key. */
async function appEndpoint(): Promise<Endpoint | "not-admin" | null> {
  try {
    const link = await deps.lstat(`${APP_DIR}/ipnport`);
    if (!link.isSymbolicLink() || link.uid !== 0) return null;
    const text = await deps.readlink(`${APP_DIR}/ipnport`);
    const port = portOf(text);
    if (port === null) return null;
    const keyFile = `${APP_DIR}/sameuserproof-${text}`;
    const key = await deps.lstat(keyFile);
    if (!key.isFile() || key.uid !== 0 || (key.mode & 0o022) !== 0) return null;
    const token = (await deps.readFile(keyFile)).trim();
    return token ? { kind: "tcp", port, token, source: "app" } : null;
  } catch (err) {
    return (err as NodeJS.ErrnoException | null)?.code === "EACCES" ? "not-admin" : null;
  }
}

/** The App Store app's port and key, from the key file its IPNExtension holds open; null when none. */
async function appStoreEndpoint(): Promise<Endpoint | null> {
  let out: string;
  try {
    out = await deps.execFile(LSOF, ["-n", "-a", `-u${deps.uid()}`, "-c", "IPNExtension", "-F"], { timeout: 2000 });
  } catch {
    return null; // no such process (exit 1), or no lsof: not this kind
  }
  for (const line of out.split("\n")) {
    const at = line.indexOf(APP_STORE_KEY_FILE);
    if (at < 0) continue;
    const rest = line.slice(at + APP_STORE_KEY_FILE.length);
    const dash = rest.indexOf("-");
    const port = dash > 0 ? portOf(rest.slice(0, dash)) : null;
    const token = rest.slice(dash + 1);
    if (port !== null && token) return { kind: "tcp", port, token, source: "appstore" };
  }
  return null;
}

async function brewEndpoint(): Promise<Endpoint | null> {
  try {
    return (await deps.lstat(deps.brewSocket)).isSocket() ? { kind: "socket", path: deps.brewSocket } : null;
  } catch {
    return null;
  }
}

/** Where to ask this host's Tailscale (see above). `passOver`: an endpoint a request just failed at,
    skipped by this look. Rejects with an EndpointError when nothing is found. */
export async function localApiEndpoint(passOver?: Endpoint): Promise<Endpoint> {
  const override = deps.env.SOVA_TAILSCALE_SOCKET;
  if (override) return { kind: "socket", path: override };
  if (deps.platform !== "darwin") return { kind: "socket", path: DEFAULT_TAILSCALE_SOCKET };
  if (remembered && !same(remembered, passOver)) return remembered;
  const app = await appEndpoint();
  if (app && app !== "not-admin" && !same(app, passOver)) return app;
  for (const look of [appStoreEndpoint, brewEndpoint]) {
    const found = await look();
    if (found && !same(found, passOver)) return (remembered = found);
  }
  throw new EndpointError(app === "not-admin" ? "not-admin" : "missing");
}
