/**
 * The project contract (§app/project-services): `.sova/project.json`, its strict parse, the
 * template language, and the one result shape every verb answers. Pure: no imports, no fs, so the
 * server, the CLI and a later web page read it alike. Never in shared/protocol.ts.
 */

// ---- verbs, codes, exit classes (§app.project-services/result) ---------------------------------

export const VERBS = ["create", "up", "down", "apply", "status", "logs", "reset", "teardown", "doctor", "conform", "test"] as const;
export type Verb = (typeof VERBS)[number];
/** Verb names that exist and answer `unsupported` (§app.project-services/reserved). */
export const RESERVED_VERBS = ["share", "revoke", "deploy", "deploy.plan", "deploy.run", "deploy.status", "deploy.rollback"] as const;
export type ReservedVerb = (typeof RESERVED_VERBS)[number];
export type AnyVerb = Verb | ReservedVerb;
export const isVerb = (v: unknown): v is AnyVerb => (VERBS as readonly unknown[]).includes(v) || (RESERVED_VERBS as readonly unknown[]).includes(v);
/** Verbs that change nothing and take no lock. */
export const READ_VERBS: readonly Verb[] = ["status", "logs", "doctor"];

export const ERROR_CODES = [
  "not-found",
  "invalid-request",
  "invalid-definition",
  "not-approved",
  "not-conformant",
  "cap-reached",
  "port-held",
  "not-ready",
  "start-failed",
  "hook-failed",
  "tests-failed",
  "dirty-worktree",
  "busy",
  "unsupported",
  "refused-slot0",
  "share-denied",
  "forbidden",
  "needs-confirm",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export type ExitClass = 0 | 1 | 2 | 3 | 4;
const EXIT: Record<ErrorCode, ExitClass> = {
  "not-ready": 1,
  "start-failed": 1,
  "hook-failed": 1,
  "tests-failed": 1,
  "not-approved": 2,
  "not-conformant": 2,
  "cap-reached": 2,
  "port-held": 2,
  "dirty-worktree": 2,
  unsupported: 2,
  "refused-slot0": 2,
  "share-denied": 2,
  forbidden: 2,
  "needs-confirm": 2,
  "invalid-request": 3,
  "invalid-definition": 3,
  "not-found": 3,
  busy: 4,
};
/** The CLI's exit code for a result: 0 unless it carries an error. */
export const exitOf = (r: { error?: { code: ErrorCode } | undefined }): ExitClass => (r.error ? EXIT[r.error.code] : 0);
/** The route's HTTP status for a result. */
export function httpStatusOf(r: { error?: { code: ErrorCode } | undefined }): number {
  if (!r.error) return 200;
  if (r.error.code === "not-found") return 404;
  return ({ 0: 200, 1: 502, 2: 409, 3: 400, 4: 423 } as const)[EXIT[r.error.code]];
}

// ---- the declaration (§app.project-services/contract) ------------------------------------------

export type Argv = string[];
export type PortDecl = { base: number; stride: number } | { fixed: number };
export type ReadyDecl = { tcp: string; timeout: number } | { http: string; path: string; timeout: number };
export type ReloadDecl = "restart" | "none" | { signal: "HUP" | "USR1" | "USR2" | "INT" | "TERM" } | { cmd: Argv };
export interface StepDecl {
  id: string;
  run: Argv;
  inputs: string[];
  timeout: number;
}
export interface ServiceDecl {
  name: string;
  /** Exactly one of `cmd` and `static`. */
  cmd?: Argv;
  static?: string;
  cwd: string;
  env: Record<string, string>;
  ports: Record<string, PortDecl>;
  requires: string[];
  ready?: ReadyDecl;
  reload: ReloadDecl;
  build?: Omit<StepDecl, "id">;
  scope: "checkout" | "shared";
  container?: { name: string; engine: "docker" | "podman" };
  /** `on-demand`: `up` leaves it stopped unless named or required (§app.project-services/up). */
  start: "up" | "on-demand";
  /** How a builder uses it (a template, no `${host.…}`), for the instance note; outside the hash. */
  about?: string;
}
/** The project's test command (§app.project-services/test). */
export interface TestDecl {
  run: Argv;
  requires: string[];
  timeout: number;
  /** A small selection, green on the main checkout, that conformance runs. */
  smoke: string[];
}
export type DataDecl =
  | { name: string; kind: "dir"; path?: string; from: string }
  | { name: string; kind: "hook"; provision: Argv; deprovision: Argv; timeout: number };
export interface ProjectDef {
  version: 1;
  slots: { cap: number };
  host: string[];
  setup: StepDecl[];
  /** In declaration order. */
  data: DataDecl[];
  /** In declaration order. */
  services: ServiceDecl[];
  hooks: { probe?: { run: Argv; timeout: number } };
  test?: TestDecl;
  /** Reserved (share, deploy): kept as written, not used yet. */
  reserved: { share?: unknown; deploy?: unknown };
}

export const CONTRACT_FILE = ".sova/project.json";
export const SLOT_CAP_DEFAULT = 4;
export const SLOT_CAP_MAX = 16;
export const READY_TIMEOUT_DEFAULT = 60;
export const READY_TIMEOUT_MAX = 600;
export const HOOK_TIMEOUT_DEFAULT = 120;
export const HOOK_TIMEOUT_MAX = 1800;
export const TEST_TIMEOUT_DEFAULT = 600;
export const ABOUT_MAX = 200;
export const SELECTORS_MAX = 50;
/** A test selector: never empty, never a flag (§app.project-services/contract). */
export const SELECTOR = /^[A-Za-z0-9_][A-Za-z0-9_./:*-]{0,199}$/;
/** Why `v` is not a list of selectors, or null. */
export function selectorsProblem(v: unknown): string | null {
  if (!Array.isArray(v)) return "must be a list of selectors";
  if (v.length > SELECTORS_MAX) return `at most ${SELECTORS_MAX} selectors`;
  for (const x of v) if (typeof x !== "string" || !SELECTOR.test(x)) return `${JSON.stringify(x)} is not a selector (letters, digits and _ . / : * -, starting with a letter, digit or _, at most 200)`;
  return null;
}
/** Conformance takes the two slots above the cap (§app.project-services/conform). */
export const scratchSlots = (def: Pick<ProjectDef, "slots">): [number, number] => [def.slots.cap + 1, def.slots.cap + 2];

const NAME = /^[a-z][a-z0-9-]{0,30}$/;
/** The variables Sova sets itself (§app.project-services/contract): a definition's env never names one. */
export const SOVA_ENV = ["SOVA_V", "SOVA_PROJECT", "SOVA_INSTANCE", "SOVA_SLOT", "SOVA_CHECKOUT", "SOVA_MAIN", "SOVA_BRANCH", "SOVA_DATA", "SOVA_VERB", "SOVA_STEP", "SOVA_OUT", "SOVA_TEST_SELECT"];
const sovaSets = (k: string) => SOVA_ENV.includes(k) || k.startsWith("SOVA_PORT_");
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const SIGNALS = ["HUP", "USR1", "USR2", "INT", "TERM"] as const;

/** Erasable syntax only (no parameter properties): the CLI imports this file with Node's type stripping. */
export class DefinitionError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "DefinitionError";
    this.path = path;
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

function keysOnly(o: Obj, allowed: readonly string[], path: string): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new DefinitionError(`${path}.${k}`, "unknown key");
}
function obj(v: unknown, path: string): Obj {
  if (!isObj(v)) throw new DefinitionError(path, "must be an object");
  return v;
}
function name(v: string, path: string): string {
  if (!NAME.test(v)) throw new DefinitionError(path, "a name is lowercase letters, digits and hyphens, starting with a letter, at most 31 characters");
  return v;
}
function argv(v: unknown, path: string): Argv {
  if (!Array.isArray(v) || v.length === 0) throw new DefinitionError(path, "must be an argv: a non-empty array of strings (never a shell string)");
  return v.map((a, i) => {
    if (typeof a !== "string" || a === "") throw new DefinitionError(`${path}[${i}]`, "must be a non-empty string");
    return a;
  });
}
function int(v: unknown, path: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new DefinitionError(path, `must be an integer from ${min} to ${max}`);
  return v;
}
function timeout(v: unknown, path: string, dflt: number, max: number): number {
  return v === undefined ? dflt : int(v, path, 1, max);
}
/** A path relative to the checkout: no absolute path, no `..`, no dot-segment unless `dots`. */
function relPath(v: unknown, path: string, dots = false): string {
  if (typeof v !== "string" || v === "") throw new DefinitionError(path, "must be a relative path");
  if (v.startsWith("/") || v.includes("\\") || v.includes("\0")) throw new DefinitionError(path, "must be a relative path inside the checkout");
  const segs = v.split("/").filter((s) => s !== "" && s !== ".");
  for (const s of segs) {
    if (s === "..") throw new DefinitionError(path, "must stay inside the checkout (no ..)");
    if (!dots && s.startsWith(".")) throw new DefinitionError(path, "must not name a dot-folder or dot-file");
  }
  return segs.length ? segs.join("/") : ".";
}
function strList(v: unknown, path: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new DefinitionError(path, "must be an array of strings");
  return v.map((x, i) => {
    if (typeof x !== "string" || x === "") throw new DefinitionError(`${path}[${i}]`, "must be a non-empty string");
    return x;
  });
}

function step(v: unknown, path: string, withId: boolean): StepDecl {
  const o = obj(v, path);
  keysOnly(o, withId ? ["id", "run", "inputs", "timeout"] : ["run", "inputs", "timeout"], path);
  const id = withId ? name(typeof o.id === "string" ? o.id : "", `${path}.id`) : "";
  return { id, run: argv(o.run, `${path}.run`), inputs: strList(o.inputs, `${path}.inputs`).map((p, i) => relPath(p, `${path}.inputs[${i}]`, true)), timeout: timeout(o.timeout, `${path}.timeout`, HOOK_TIMEOUT_DEFAULT, HOOK_TIMEOUT_MAX) };
}

function port(v: unknown, path: string): PortDecl {
  const o = obj(v, path);
  if ("fixed" in o) {
    keysOnly(o, ["fixed"], path);
    return { fixed: int(o.fixed, `${path}.fixed`, 1024, 65535) };
  }
  keysOnly(o, ["base", "stride"], path);
  return { base: int(o.base, `${path}.base`, 1024, 65535), stride: o.stride === undefined ? 1 : int(o.stride, `${path}.stride`, 1, 1000) };
}

function ready(v: unknown, path: string, ports: Record<string, PortDecl>): ReadyDecl {
  const o = obj(v, path);
  const t = timeout(o.timeout, `${path}.timeout`, READY_TIMEOUT_DEFAULT, READY_TIMEOUT_MAX);
  const portName = (x: unknown, p: string) => {
    if (typeof x !== "string" || !(x in ports)) throw new DefinitionError(p, "must name one of the service's ports");
    return x;
  };
  if ("tcp" in o) {
    keysOnly(o, ["tcp", "timeout"], path);
    return { tcp: portName(o.tcp, `${path}.tcp`), timeout: t };
  }
  if ("http" in o) {
    keysOnly(o, ["http", "path", "timeout"], path);
    const p = o.path === undefined ? "/" : o.path;
    if (typeof p !== "string" || !p.startsWith("/")) throw new DefinitionError(`${path}.path`, "must start with /");
    return { http: portName(o.http, `${path}.http`), path: p, timeout: t };
  }
  throw new DefinitionError(path, "must be {tcp: <port name>} or {http: <port name>, path?}");
}

function reload(v: unknown, path: string): ReloadDecl {
  if (v === undefined) return "restart";
  if (v === "restart" || v === "none") return v;
  const o = obj(v, path);
  if ("signal" in o) {
    keysOnly(o, ["signal"], path);
    if (!(SIGNALS as readonly unknown[]).includes(o.signal)) throw new DefinitionError(`${path}.signal`, `must be one of ${SIGNALS.join(", ")}`);
    return { signal: o.signal as (typeof SIGNALS)[number] };
  }
  keysOnly(o, ["cmd"], path);
  return { cmd: argv(o.cmd, `${path}.cmd`) };
}

function service(nm: string, v: unknown, path: string): ServiceDecl {
  const o = obj(v, path);
  keysOnly(o, ["cmd", "static", "cwd", "env", "ports", "requires", "ready", "reload", "build", "scope", "container", "start", "about"], path);
  const hasCmd = o.cmd !== undefined;
  const hasStatic = o.static !== undefined;
  if (hasCmd === hasStatic) throw new DefinitionError(path, "needs exactly one of cmd (an argv) and static (a folder)");
  const ports: Record<string, PortDecl> = {};
  if (o.ports !== undefined) for (const [k, p] of Object.entries(obj(o.ports, `${path}.ports`))) ports[name(k, `${path}.ports.${k}`)] = port(p, `${path}.ports.${k}`);
  const env: Record<string, string> = {};
  if (o.env !== undefined)
    for (const [k, e] of Object.entries(obj(o.env, `${path}.env`))) {
      if (!ENV_NAME.test(k) || sovaSets(k)) throw new DefinitionError(`${path}.env.${k}`, "an env name is A-Z, 0-9 and _, and never one Sova sets itself (SOVA_V, SOVA_SLOT, SOVA_PORT_…)");
      if (typeof e !== "string") throw new DefinitionError(`${path}.env.${k}`, "must be a string");
      env[k] = e;
    }
  const scope = o.scope === undefined ? "checkout" : o.scope;
  if (scope !== "checkout" && scope !== "shared") throw new DefinitionError(`${path}.scope`, "must be checkout or shared");
  const out: ServiceDecl = {
    name: nm,
    cwd: o.cwd === undefined ? "." : relPath(o.cwd, `${path}.cwd`, true),
    env,
    ports,
    requires: strList(o.requires, `${path}.requires`),
    reload: reload(o.reload, `${path}.reload`),
    scope,
    start: "up",
  };
  if (o.start !== undefined) {
    if (o.start !== "up" && o.start !== "on-demand") throw new DefinitionError(`${path}.start`, 'must be "up" or "on-demand"');
    if (o.start === "on-demand" && scope === "shared") throw new DefinitionError(`${path}.start`, "a shared service starts with up");
    out.start = o.start;
  }
  if (o.about !== undefined) {
    if (typeof o.about !== "string" || !o.about.trim() || o.about.length > ABOUT_MAX) throw new DefinitionError(`${path}.about`, `must be a sentence of at most ${ABOUT_MAX} characters`);
    if (/\$\{host\./.test(o.about)) throw new DefinitionError(`${path}.about`, "may not read ${host.…}: the note is shown to sessions");
    out.about = o.about;
  }
  if (hasStatic) {
    out.static = relPath(o.static, `${path}.static`);
    if (Object.keys(ports).length !== 1) throw new DefinitionError(`${path}.ports`, "a static service has exactly one port");
    for (const k of ["cwd", "env", "build", "container", "ready"] as const) if (o[k] !== undefined) throw new DefinitionError(`${path}.${k}`, "a static service has nothing to run");
    if (o.reload !== undefined && o.reload !== "none") throw new DefinitionError(`${path}.reload`, "a static service's files are live: reload is none");
    if (scope === "shared") throw new DefinitionError(`${path}.scope`, "a static service belongs to its checkout");
    out.reload = "none";
  } else out.cmd = argv(o.cmd, `${path}.cmd`);
  if (o.ready !== undefined) out.ready = ready(o.ready, `${path}.ready`, ports);
  if (o.build !== undefined) {
    const b = step(o.build, `${path}.build`, false);
    out.build = { run: b.run, inputs: b.inputs, timeout: b.timeout };
  }
  if (o.container !== undefined) {
    const c = obj(o.container, `${path}.container`);
    keysOnly(c, ["name", "engine"], `${path}.container`);
    if (typeof c.name !== "string" || !c.name) throw new DefinitionError(`${path}.container.name`, "must be a container name (a template)");
    const engine = c.engine === undefined ? "docker" : c.engine;
    if (engine !== "docker" && engine !== "podman") throw new DefinitionError(`${path}.container.engine`, "must be docker or podman");
    out.container = { name: c.name, engine };
  }
  if (scope === "shared")
    for (const [k, p] of Object.entries(ports)) if (!("fixed" in p)) throw new DefinitionError(`${path}.ports.${k}`, "a shared service's ports are fixed");
  return out;
}

function data(nm: string, v: unknown, path: string): DataDecl {
  const o = obj(v, path);
  if (o.kind === "dir") {
    keysOnly(o, ["kind", "path", "from"], path);
    const from = o.from === undefined ? "empty" : o.from;
    if (typeof from !== "string" || !from) throw new DefinitionError(`${path}.from`, 'must be "empty" or a folder (a template)');
    return { name: nm, kind: "dir", ...(o.path !== undefined ? { path: relPath(o.path, `${path}.path`, true) } : {}), from };
  }
  if (o.kind === "hook") {
    keysOnly(o, ["kind", "provision", "deprovision", "timeout"], path);
    return { name: nm, kind: "hook", provision: argv(o.provision, `${path}.provision`), deprovision: argv(o.deprovision, `${path}.deprovision`), timeout: timeout(o.timeout, `${path}.timeout`, HOOK_TIMEOUT_DEFAULT, HOOK_TIMEOUT_MAX) };
  }
  throw new DefinitionError(`${path}.kind`, 'must be "dir" or "hook"');
}

/** Every `${…}` variable a definition's templates name, with where. */
function* templates(def: ProjectDef): Generator<[string, string]> {
  for (const s of def.setup) for (const [i, a] of s.run.entries()) yield [a, `setup.${s.id}.run[${i}]`];
  for (const d of def.data) {
    if (d.kind === "dir") {
      if (d.from !== "empty") yield [d.from, `data.${d.name}.from`];
    } else {
      for (const [i, a] of d.provision.entries()) yield [a, `data.${d.name}.provision[${i}]`];
      for (const [i, a] of d.deprovision.entries()) yield [a, `data.${d.name}.deprovision[${i}]`];
    }
  }
  for (const s of def.services) {
    const p = `services.${s.name}`;
    for (const [i, a] of (s.cmd ?? []).entries()) yield [a, `${p}.cmd[${i}]`];
    for (const [k, e] of Object.entries(s.env)) yield [e, `${p}.env.${k}`];
    if (typeof s.reload === "object" && "cmd" in s.reload) for (const [i, a] of s.reload.cmd.entries()) yield [a, `${p}.reload.cmd[${i}]`];
    for (const [i, a] of (s.build?.run ?? []).entries()) yield [a, `${p}.build.run[${i}]`];
    if (s.container) yield [s.container.name, `${p}.container.name`];
    if (s.about !== undefined) yield [s.about, `${p}.about`];
  }
  for (const [i, a] of (def.test?.run ?? []).entries()) yield [a, `test.run[${i}]`];
  for (const [i, a] of (def.hooks.probe?.run ?? []).entries()) yield [a, `hooks.probe.run[${i}]`];
}

/** Parse `.sova/project.json`'s text. Throws DefinitionError naming the first problem's path. */
export function parseDefinition(text: string): ProjectDef {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new DefinitionError("$", `not JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  const o = obj(raw, "$");
  keysOnly(o, ["version", "slots", "host", "setup", "data", "services", "hooks", "test", "share", "deploy"], "$");
  if (o.version !== 1) throw new DefinitionError("$.version", "must be 1");
  let cap = SLOT_CAP_DEFAULT;
  if (o.slots !== undefined) {
    const s = obj(o.slots, "$.slots");
    keysOnly(s, ["cap"], "$.slots");
    if (s.cap !== undefined) cap = int(s.cap, "$.slots.cap", 1, SLOT_CAP_MAX);
  }
  const host = strList(o.host, "$.host");
  for (const [i, h] of host.entries()) if (!ENV_NAME.test(h)) throw new DefinitionError(`$.host[${i}]`, "a host name is A-Z, 0-9 and _");
  if (o.setup !== undefined && !Array.isArray(o.setup)) throw new DefinitionError("$.setup", "must be an array of steps");
  const setup = ((o.setup as unknown[] | undefined) ?? []).map((s, i) => step(s, `$.setup[${i}]`, true));
  if (new Set(setup.map((s) => s.id)).size !== setup.length) throw new DefinitionError("$.setup", "step ids must be unique");
  const dataList = o.data === undefined ? [] : Object.entries(obj(o.data, "$.data")).map(([k, v]) => data(name(k, `$.data.${k}`), v, `$.data.${k}`));
  const svcObj = obj(o.services, "$.services");
  const services = Object.entries(svcObj).map(([k, v]) => service(name(k, `$.services.${k}`), v, `$.services.${k}`));
  if (!services.length) throw new DefinitionError("$.services", "declare at least one service");
  const hooks: ProjectDef["hooks"] = {};
  if (o.hooks !== undefined) {
    const h = obj(o.hooks, "$.hooks");
    keysOnly(h, ["probe"], "$.hooks");
    if (h.probe !== undefined) {
      const p = step(h.probe, "$.hooks.probe", false);
      hooks.probe = { run: p.run, timeout: p.timeout };
    }
  }
  let test: TestDecl | undefined;
  if (o.test !== undefined) {
    const t = obj(o.test, "$.test");
    keysOnly(t, ["run", "requires", "timeout", "smoke"], "$.test");
    const requires = strList(t.requires, "$.test.requires");
    for (const r of requires) if (!services.some((x) => x.name === r)) throw new DefinitionError("$.test.requires", `names no service "${r}"`);
    if (!Array.isArray(t.smoke) || !t.smoke.length) throw new DefinitionError("$.test.smoke", "name the smoke selection: 1 to 50 selectors, green on the main checkout");
    const bad = selectorsProblem(t.smoke);
    if (bad) throw new DefinitionError("$.test.smoke", bad);
    test = { run: argv(t.run, "$.test.run"), requires, timeout: timeout(t.timeout, "$.test.timeout", TEST_TIMEOUT_DEFAULT, HOOK_TIMEOUT_MAX), smoke: t.smoke as string[] };
  }
  const def: ProjectDef = {
    version: 1,
    slots: { cap },
    host,
    setup,
    data: dataList,
    services,
    hooks,
    ...(test ? { test } : {}),
    reserved: { ...(o.share !== undefined ? { share: o.share } : {}), ...(o.deploy !== undefined ? { deploy: o.deploy } : {}) },
  };
  // requires: known, scope-consistent, acyclic.
  const byName = new Map(services.map((s) => [s.name, s]));
  for (const s of services)
    for (const r of s.requires) {
      const t = byName.get(r);
      if (!t || r === s.name) throw new DefinitionError(`$.services.${s.name}.requires`, `names no other service "${r}"`);
      if (s.scope === "shared" && t.scope !== "shared") throw new DefinitionError(`$.services.${s.name}.requires`, "a shared service requires only shared services");
    }
  serviceOrder(def);
  // Ports: every allocated port, in every slot up to the scratch slots, must fit, and no two ports
  // of one instance may coincide.
  const top = cap + 2;
  for (const s of services)
    for (const [k, p] of Object.entries(s.ports))
      if ("base" in p && p.base + top * p.stride > 65535) throw new DefinitionError(`$.services.${s.name}.ports.${k}`, `slot ${top} would need port ${p.base + top * p.stride}`);
  // Across slots too: two ports whose ranges meet (base 9000 and 9001, stride 1) would make every
  // slot's instance claim a port of its neighbour's.
  const seen = new Map<number, { key: string; slot: number }>();
  for (let slot = 0; slot <= top; slot++)
    for (const s of services)
      for (const [k, p] of Object.entries(s.ports)) {
        const n = portFor(p, slot);
        const key = `${s.name}.${k}`;
        const other = seen.get(n);
        if (other && other.key !== key) throw new DefinitionError(`$.services.${s.name}.ports.${k}`, `slot ${slot} gives it port ${n}, which ${other.key} has in slot ${other.slot}`);
        if (!other) seen.set(n, { key, slot });
      }
  // Templates: every variable must be one Sova knows.
  const vars = templateVars(def);
  for (const [t, where] of templates(def)) {
    const bad = unknownVars(t, vars);
    if (bad) throw new DefinitionError(`$.${where}`, bad);
  }
  return def;
}

/** Services in start order: each after everything it requires (declaration order breaks ties). Throws on a cycle. */
export function serviceOrder(def: Pick<ProjectDef, "services">): ServiceDecl[] {
  const out: ServiceDecl[] = [];
  const state = new Map<string, "visiting" | "done">();
  const byName = new Map(def.services.map((s) => [s.name, s]));
  const visit = (s: ServiceDecl, chain: string[]) => {
    const st = state.get(s.name);
    if (st === "done") return;
    if (st === "visiting") throw new DefinitionError(`$.services.${s.name}.requires`, `cycle: ${[...chain, s.name].join(" → ")}`);
    state.set(s.name, "visiting");
    for (const r of s.requires) visit(byName.get(r)!, [...chain, s.name]);
    state.set(s.name, "done");
    out.push(s);
  };
  for (const s of def.services) visit(s, []);
  return out;
}

/** The services `names` need, with what they require (transitively), in start order. */
export function closureOf(def: Pick<ProjectDef, "services">, names: readonly string[]): ServiceDecl[] {
  const want = new Set<string>();
  const byName = new Map(def.services.map((s) => [s.name, s]));
  const add = (n: string) => {
    if (want.has(n)) return;
    want.add(n);
    for (const r of byName.get(n)?.requires ?? []) add(r);
  };
  for (const n of names) add(n);
  return serviceOrder(def).filter((s) => want.has(s.name));
}

export const portFor = (p: PortDecl, slot: number): number => ("fixed" in p ? p.fixed : p.base + slot * p.stride);

/** Every port of the definition in `slot`: `{service: {port: number}}`, shared services included. */
export function portsFor(def: Pick<ProjectDef, "services">, slot: number): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const s of def.services) {
    out[s.name] = {};
    for (const [k, p] of Object.entries(s.ports)) out[s.name]![k] = portFor(p, slot);
  }
  return out;
}

// ---- templates (§app.project-services/contract) ------------------------------------------------

const FIXED_VARS = ["slot", "instance", "project", "checkout", "main", "branch", "data"];

function templateVars(def: ProjectDef): Set<string> {
  const v = new Set(FIXED_VARS);
  for (const d of def.data) v.add(`data.${d.name}`);
  for (const s of def.services) for (const k of Object.keys(s.ports)) v.add(`ports.${s.name}.${k}`);
  for (const h of def.host) v.add(`host.${h}`);
  return v;
}

const TOKEN = /\$\$|\$\{([^}]*)\}|\$/g;

/** Why a template is bad (an unknown variable, a stray `$`), or null. */
function unknownVars(t: string, vars: Set<string>): string | null {
  for (const m of t.matchAll(TOKEN)) {
    if (m[0] === "$$") continue;
    if (m[0] === "$") return 'a lone "$" (write $$ for a literal $, ${name} for a variable)';
    if (!vars.has(m[1]!)) return `unknown template variable \${${m[1]}}`;
  }
  return null;
}

/** Render a template with `vars` (every name must be there: the parse checked them). */
export function render(t: string, vars: Readonly<Record<string, string>>): string {
  return t.replace(TOKEN, (m, key: string | undefined) => {
    if (m === "$$") return "$";
    const v = key === undefined ? undefined : vars[key];
    if (v === undefined) throw new Error(`template variable \${${key}} has no value`);
    return v;
  });
}

/** `SOVA_PORT_<SERVICE>_<PORT>`'s name part: upper case, anything else `_`. */
export const envPart = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "_");

// ---- the result (§app.project-services/result) -------------------------------------------------

export type InstanceState = "absent" | "stopped" | "running" | "degraded";
export type StepKind = "setup" | "data" | "hook" | "build" | "start" | "ready" | "reload" | "stop" | "check" | "worktree" | "slot" | "test";
export interface Step {
  id: string;
  kind: StepKind;
  result: "done" | "skipped" | "failed";
  ms: number;
  detail?: string;
  fingerprint?: string;
}
export type ServiceState = "stopped" | "starting" | "ready" | "degraded" | "failed" | "external";
export interface ServiceView {
  name: string;
  scope: "checkout" | "shared";
  kind: "process" | "static" | "container";
  state: ServiceState;
  unit: string | null;
  pid: number | null;
  ports: Record<string, number>;
  ready?: { probe: string; ok: boolean; ms: number };
  detail?: string;
}
export interface DataView {
  name: string;
  kind: "dir" | "hook";
  ref: string;
  exists: boolean;
}
export interface InstanceSummary {
  instance: string;
  slot: number;
  generation: number;
  checkout: string;
  branch: string | null;
  state: InstanceState;
  services: ServiceView[];
  createdBy: string;
}
export interface Check {
  id: string;
  ok: boolean;
  detail: string;
  ms?: number;
}
export interface LogLine {
  t: string;
  service: string;
  text: string;
}
export interface ConformReport {
  suiteVersion: number;
  defHash: string;
  ref: string;
  pass: boolean;
  checks: Check[];
  leaks: string[];
}
export interface TestFailure {
  name: string;
  message?: string;
  file?: string;
  line?: number;
}
/** A test run's result (§app.project-services/test): counts are null when the runner wrote none. */
export interface TestsReport {
  select: string[];
  pass: boolean;
  passed: number | null;
  failed: number | null;
  errors: number | null;
  skipped: number | null;
  failures: TestFailure[];
  exit: number | null;
  timedOut: boolean;
  ms: number;
  peakBytes: number | null;
}
export const FAILURES_MAX = 50;
export const FAILURE_MESSAGE_MAX = 2000;
export interface VerbError {
  code: ErrorCode;
  message: string;
  step?: string;
  service?: string;
}
export interface VerbResult {
  v: 1;
  verb: AnyVerb;
  project: string | null;
  instance: string | null;
  slot: number | null;
  generation: number | null;
  checkout: string | null;
  branch: string | null;
  ok: boolean;
  changed: boolean;
  state: InstanceState;
  steps: Step[];
  services: ServiceView[];
  data: DataView[];
  links: never[];
  instances?: InstanceSummary[];
  lines?: LogLine[];
  checks?: Check[];
  conform?: ConformReport;
  tests?: TestsReport;
  error?: VerbError;
  defHash: string | null;
  approved: boolean;
  at: string;
}

/** The result with its keys in the one fixed order (§app.project-services/result). */
export function ordered(r: VerbResult): VerbResult {
  const out: VerbResult = {
    v: 1,
    verb: r.verb,
    project: r.project,
    instance: r.instance,
    slot: r.slot,
    generation: r.generation,
    checkout: r.checkout,
    branch: r.branch,
    ok: r.ok,
    changed: r.changed,
    state: r.state,
    steps: r.steps,
    services: r.services,
    data: r.data,
    links: r.links,
    ...(r.instances !== undefined ? { instances: r.instances } : {}),
    ...(r.lines !== undefined ? { lines: r.lines } : {}),
    ...(r.checks !== undefined ? { checks: r.checks } : {}),
    ...(r.conform !== undefined ? { conform: r.conform } : {}),
    ...(r.tests !== undefined ? { tests: r.tests } : {}),
    ...(r.error !== undefined ? { error: r.error } : {}),
    defHash: r.defHash,
    approved: r.approved,
    at: r.at,
  };
  return out;
}

/** Whether `v` is a result of this shape (keys, order and closed values), for tests and clients. */
export function isVerbResult(v: unknown): v is VerbResult {
  if (!isObj(v)) return false;
  const keys = Object.keys(v);
  const want = ["v", "verb", "project", "instance", "slot", "generation", "checkout", "branch", "ok", "changed", "state", "steps", "services", "data", "links"];
  if (keys.slice(0, want.length).join() !== want.join()) return false;
  const tail = keys.slice(want.length);
  const optional = ["instances", "lines", "checks", "conform", "tests", "error"];
  const fixedTail = ["defHash", "approved", "at"];
  if (tail.slice(-3).join() !== fixedTail.join()) return false;
  const mid = tail.slice(0, -3);
  if (mid.some((k) => !optional.includes(k)) || mid.join() !== optional.filter((k) => mid.includes(k)).join()) return false;
  if (v.v !== 1 || !isVerb(v.verb) || typeof v.ok !== "boolean" || typeof v.changed !== "boolean") return false;
  if (!["absent", "stopped", "running", "degraded"].includes(v.state as string)) return false;
  if (v.error !== undefined && !(isObj(v.error) && (ERROR_CODES as readonly unknown[]).includes(v.error.code) && typeof v.error.message === "string")) return false;
  if (v.error !== undefined && v.ok) return false;
  return Array.isArray(v.steps) && Array.isArray(v.services) && Array.isArray(v.data) && Array.isArray(v.links);
}
