import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { CONTRACT_FILE, parseDefinition, type ProjectDef } from "../../shared/project-contract";
import { isTourOrigin, type TourSource } from "../../shared/tour";
import { staticServes, type StaticServe } from "../preview-serve";
import type { PortOwner } from "../port-owner";
import type { Driver } from "./drivers";
import { hostPortOwner } from "./proctable";
import { findUnitListener, realAsyncProcFs, verifyUnitListener, type AsyncProcFs, type HeldListener } from "./tour-target-listener";
import { readRegistry, type Registry } from "./store";
import { containedPath, readBounded } from "../tours/assets";
import { SOVA_LIVE_UNIT, TOUR_SOVA_CREDENTIALS_REFUSAL, TOUR_SOVA_REFUSAL } from "../tours/runner-header";

/**
 * A host that reaches this machine's own listeners, from its literal form: localhost names, 127/8,
 * ::1, and the unspecified addresses 0/8 and :: (which Linux connects locally), in plain or
 * IPv4-mapped form. URL has already canonicalized abbreviated and integer IPv4 forms (http://0 is
 * 0.0.0.0). Accepted residual: a named host that resolves to loopback is not seen here; with the
 * sandbox off only the recorder's X-Sova-Server backstop applies to it.
 */
export function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || host === "[::]" || /^(?:127|0)\.\d+\.\d+\.\d+$/.test(host)
    || /^\[::ffff:(?:7f[0-9a-f]{2}|[0-9a-f]{1,2}):[0-9a-f]{1,4}\]$/.test(host);
}

export { TourTargetUnverifiable } from "./tour-target-listener";

export class TourTargetRefused extends Error {
  readonly guidance = "Start this same running copy through project services, then retry. Recording never starts a substitute.";
}

export interface ResolvedTourTarget {
  origin: string;
  generation?: number;
  /**
   * Set only for a verified managed Sova test copy (slot 1 or higher, Sova's own server service, its
   * own `.agent` state directory in the checkout, no model credentials there): that directory.
   */
  sova?: { agentDir: string };
  /** Recheck before navigation and capture; a new generation/owner stops this attempt. */
  assertCurrent(): Promise<void>;
}

export interface TourTargetDeps {
  registry?: () => Registry;
  projectRoot?: (id: string) => string | null | Promise<string | null>;
  definition?: (checkout: string) => ProjectDef;
  unitOf?: (instance: string, service: string) => string;
  driver?: Pick<Driver, "status" | "owns">;
  /** A stand-in for the whole listener lookup (tests); without it Linux uses the async /proc probe below. */
  portOwner?: (port: number) => PortOwner;
  /** The probe's /proc reads (tests); real fs.promises reads by default. */
  procfs?: AsyncProcFs;
  platform?: NodeJS.Platform;
  serves?: () => StaticServe[];
  /** Every port this Sova itself listens on (main, share, peer, ingress, folder serves). */
  sovaPorts?: () => Promise<Set<number>>;
}

async function ownSovaPorts(): Promise<Set<number>> {
  const ports = (await import("../project-previews")).sovaPorts();
  ports.add((await import("../auth")).authListenPort());
  return ports;
}

const canonical = (path: string): string => {
  try { return realpathSync(path); } catch { throw new TourTargetRefused("This tour's checkout is no longer available."); }
};

/** Resolve identity from the registry each time, never from a remembered URL, port or slot. */
export async function resolveTourTarget(source: TourSource, deps: TourTargetDeps = {}): Promise<ResolvedTourTarget> {
  if (source.kind === "site") {
    if (!isTourOrigin(source.origin)) throw new TourTargetRefused("This tour's site origin is invalid.");
    const url = new URL(source.origin);
    const loopback = isLocalHost(url.hostname);
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    const assertCurrent = async () => {
      if (!loopback) return;
      // A live Sova port (this server's own listeners, or any registered copy's, slot 0 included) is
      // refused before any contact: Sova is toured only as a verified managed copy.
      if ((await (deps.sovaPorts ?? ownSovaPorts)()).has(port)) throw new TourTargetRefused(TOUR_SOVA_REFUSAL);
      const rec = (deps.registry ?? readRegistry)().instances.find((r) => Object.values(r.ports).some((ports) => Object.values(ports).includes(port)));
      if (rec) throw new TourTargetRefused("This loopback port belongs to a managed running copy, including its reserved stopped ports. Use that project's canonical checkout, instance and service identity, not an external site origin.");
    };
    await assertCurrent();
    return { origin: source.origin, assertCurrent };
  }
  const registry = deps.registry ?? readRegistry;
  const rootOf = deps.projectRoot ?? ((id: string) => {
    // Loaded only on an actual server call; test resolvers do not import server routing.
    return registeredProjectRoot(id);
  });
  const definition = deps.definition ?? ((checkout: string) => parseDefinition(readFileSync(join(checkout, CONTRACT_FILE), "utf8")));
  const projectRoot = await rootOf(source.projectId);
  const expectedCheckout = canonical(source.checkout);
  if (expectedCheckout !== source.checkout) throw new TourTargetRefused("The tour's checkout identity is not canonical.");
  const engine = deps.driver && deps.unitOf ? null : (await import("./routes")).projectEngine();
  const driver = deps.driver ?? engine!.driver;
  const unitOf = deps.unitOf ?? ((id: string, svc: string) => engine!.unitOf(id, svc));
  const ownerOf = deps.portOwner ?? hostPortOwner;
  // Linux without a stand-in: the listener is found once, then re-verified live at every contact by its
  // exact socket and process (tour-target-listener), never by scanning the host per contact.
  const probe = !deps.portOwner && (deps.platform ?? process.platform) === "linux" ? (deps.procfs ?? realAsyncProcFs) : null;
  let held: HeldListener | undefined;
  const serves = deps.serves ?? staticServes;
  const stopped = "The original service is stopped, or another process owns its port. Start this same copy before re-recording.";

  const observe = async () => {
    const rec = registry().instances.find((r) => r.id === source.instanceId);
    if (!rec || !projectRoot || canonical(projectRoot) !== canonical(rec.project) || canonical(rec.checkout) !== expectedCheckout)
      throw new TourTargetRefused("This tour's original running copy is no longer registered here.");
    let def: ProjectDef;
    try { def = definition(rec.checkout); } catch { throw new TourTargetRefused("This copy's service definition cannot be read safely."); }
    const service = def.services.find((s) => s.name === source.serviceId && s.scope === "checkout");
    const port = rec.ports[source.serviceId]?.[source.endpoint];
    if (!service || !(source.endpoint in service.ports) || !Number.isInteger(port) || port! < 1 || port! > 65535)
      throw new TourTargetRefused("This tour's original service endpoint is no longer declared.");
    if (rec.desired[source.serviceId] !== "running") throw new TourTargetRefused("This tour's original copy is not running. Start that copy before re-recording.");
    // Sova's own server (the service that adopts the live install in slot 0): only a test copy.
    let sova: { agentDir: string } | undefined;
    if (service.adopt?.unit === SOVA_LIVE_UNIT) {
      if (rec.slot === 0) throw new TourTargetRefused(TOUR_SOVA_REFUSAL);
      if (Object.keys(service.env).some(providerKeyName)) throw new TourTargetRefused(TOUR_SOVA_CREDENTIALS_REFUSAL);
      sova = { agentDir: sovaCopyState(rec.checkout) };
    }
    const unit = unitOf(rec.id, service.name);
    let owner: string;
    if (service.static !== undefined) {
      const folder = canonical(join(rec.checkout, service.static));
      const serve = serves().find((s) => s.id === unit && s.port === port && canonical(s.root) === folder);
      if (!serve) throw new TourTargetRefused("This copy's static service is not running under its own identity.");
      owner = `static:${unit}:${folder}`;
    } else {
      // Container/foreign manager identities are not guessed from a listening TCP port.
      if (service.container || (rec.slot === 0 && service.adopt))
        throw new TourTargetRefused("Recording cannot yet verify ownership of this container or adopted service. Use a verified test copy.");
      const status = await driver.status(unit);
      if (status.state !== "active" || !status.pid) throw new TourTargetRefused(stopped);
      const inUnit = (pid: number) => driver.owns(unit, pid);
      if (probe) {
        if (!held) {
          const found = await findUnitListener(port!, status.pid, inUnit, probe);
          if ("refused" in found) throw new TourTargetRefused(stopped);
          held = found.held;
        } else if (await verifyUnitListener(port!, held, inUnit, probe)) {
          throw new TourTargetRefused("This running copy changed during recording. Retry against the same copy after it is stable.");
        }
        owner = `process:${held.pid}:${held.start}:${status.pid}`;
      } else {
        const listener = ownerOf(port!);
        if (listener === "none" || listener === "unknown" || !driver.owns(unit, listener.pid)) throw new TourTargetRefused(stopped);
        owner = `process:${listener.pid}:${status.pid}`;
      }
    }
    return { origin: `http://127.0.0.1:${port}`, generation: rec.generation, owner, sova };
  };
  const initial = await observe();
  return {
    origin: initial.origin, generation: initial.generation, ...(initial.sova ? { sova: initial.sova } : {}),
    assertCurrent: async () => {
      const now = await observe();
      if (now.origin !== initial.origin || now.generation !== initial.generation || now.owner !== initial.owner || now.sova?.agentDir !== initial.sova?.agentDir)
        throw new TourTargetRefused("This running copy changed during recording. Retry against the same copy after it is stable.");
    },
  };
}

/** An environment variable that hands a model provider a credential (the copy's service definition). */
const providerKeyName = (name: string): boolean => /(?:^|_)(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|OAUTH_TOKEN)$/i.test(name) || /^(?:ANTHROPIC|OPENAI|GEMINI|GOOGLE|ZAI|OPENROUTER|DEEPSEEK|MISTRAL|GROQ|XAI)_/i.test(name);

/** The longest literal placeholder key (Ollama's "ollama") a loopback provider may carry. */
export const PLACEHOLDER_KEY_MAX = 16;

/**
 * Whether a models.json value carries a credential. Any `headers` entry (provider- or model-level)
 * does, and a non-boolean `authHeader`. An `apiKey` (provider- or model-level, empty aside) is not
 * one only when it is a short literal placeholder (at most PLACEHOLDER_KEY_MAX characters, no `$`
 * environment reference, no leading `!` command) on a loopback baseUrl, its own or its provider's.
 * A loopback baseUrl can itself be a credentialed gateway (an Ollama signed in to a cloud account),
 * so this rule does not prove that no paid call is possible: it is accepted by decision, and the
 * recorder's in-test counting stub (sova-copy.integration) remains the zero-provider proof.
 */
function modelsCredential(v: unknown, base?: unknown): boolean {
  if (Array.isArray(v)) return v.some(x => modelsCredential(x, base));
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  const here = "baseUrl" in o ? o.baseUrl : base;
  if ("headers" in o) return true;
  if ("authHeader" in o && typeof o.authHeader !== "boolean") return true;
  if ("apiKey" in o && o.apiKey !== "" && o.apiKey !== null && o.apiKey !== undefined && !placeholderKey(o.apiKey, here)) return true;
  return Object.entries(o).some(([k, x]) => k !== "apiKey" && modelsCredential(x, here));
}
function placeholderKey(key: unknown, base: unknown): boolean {
  if (typeof key !== "string" || key.length > PLACEHOLDER_KEY_MAX || key.includes("$") || key.startsWith("!") || typeof base !== "string") return false;
  try { return isLocalHost(new URL(base).hostname); } catch { return false; }
}

const inside = (root: string, path: string): boolean => { const rel = relative(root, path); return rel === "" || !(rel === ".." || rel.startsWith("../") || isAbsolute(rel)); };

/**
 * A link's final file when every hop of it stays inside `root` (already real): each target's
 * directory is resolved and must lie inside, and the chain ends at a non-link. Otherwise null.
 */
function linkInside(root: string, path: string): string | null {
  let current = path;
  for (let hop = 0; hop < 8; hop++) {
    let link: boolean;
    try { link = lstatSync(current).isSymbolicLink(); } catch { return null; }
    if (!link) return inside(root, current) ? current : null;
    let next: string;
    try {
      const target = resolve(dirname(current), readlinkSync(current));
      const dir = realpathSync(dirname(target));
      if (!inside(root, dir)) return null;
      next = join(dir, basename(target));
    } catch { return null; }
    if (!inside(root, next)) return null;
    current = next;
  }
  return null;
}

/**
 * A credentials file in the copy's state directory: absent is fine; anything that can't be read as a
 * plain, bounded JSON file (unreadable, oversize, unparsable, a directory) counts as credentials. A
 * link counts too, except where `linkRoot` is given (models.json: a test copy's catalogue links into
 * its own checkout) and every hop of it stays inside that root.
 */
function credentialsIn(agentDir: string, file: string, holds: (json: unknown) => boolean, linkRoot?: string): boolean {
  const path = join(agentDir, file);
  let link: boolean;
  try { link = lstatSync(path).isSymbolicLink(); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; return true; }
  let bytes: Buffer | null;
  if (!link) bytes = readBounded(agentDir, path, 256 * 1024);
  else {
    if (!linkRoot) return true;
    const target = linkInside(linkRoot, path);
    bytes = target ? readBounded(linkRoot, target, 256 * 1024) : null;
  }
  if (!bytes) return true;
  try { return holds(JSON.parse(bytes.toString("utf8"))); } catch { return true; }
}

/**
 * A managed Sova copy's own state directory, `<checkout>/.agent`: a real directory (no link anywhere
 * on the way), holding no model credentials: auth.json empty or absent, nothing in models.json but
 * a loopback provider's short literal placeholder key (modelsCredential).
 * Checked again at every contact. Its path is the one the copy's server runs with
 * (PI_CODING_AGENT_DIR="$PWD/.agent"), so its cookie name matches. Accepted limit: the environment
 * the copy's process inherits beyond its service definition is not visible here.
 */
export function sovaCopyState(checkout: string): string {
  const agentDir = join(checkout, ".agent");
  try {
    containedPath(checkout, agentDir);
    if (!lstatSync(agentDir).isDirectory()) throw new Error("not a directory");
  } catch { throw new TourTargetRefused(TOUR_SOVA_REFUSAL); }
  const auth = credentialsIn(agentDir, "auth.json", json => !json || typeof json !== "object" || Array.isArray(json) || Object.keys(json).length > 0);
  let root: string;
  try { root = realpathSync(checkout); } catch { throw new TourTargetRefused(TOUR_SOVA_REFUSAL); }
  if (auth || credentialsIn(agentDir, "models.json", json => modelsCredential(json), root)) throw new TourTargetRefused(TOUR_SOVA_CREDENTIALS_REFUSAL);
  return agentDir;
}

async function registeredProjectRoot(id: string): Promise<string | null> {
  return (await import("../projects/spaces")).listProjects().find((p) => p.id === id)?.root ?? null;
}
