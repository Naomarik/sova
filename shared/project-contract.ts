/**
 * The project contract (§app/project-services): `.sova/project.json`, its strict parse, the
 * template language, and the one result shape every verb answers. Pure: no imports, no fs, so the
 * server, the CLI and a later web page read it alike. Never in shared/protocol.ts.
 */

// ---- verbs, codes, exit classes (§app.project-services/result) ---------------------------------

export const VERBS = ["create", "up", "down", "apply", "status", "logs", "reset", "teardown", "doctor", "conform", "test", "share", "revoke"] as const;
export type Verb = (typeof VERBS)[number];
/** The deploy verbs (§app.project-services/deploy): a target of the definition's `deploy`, never an instance. */
export const DEPLOY_VERBS = ["deploy.check", "deploy.plan", "deploy.run", "deploy.status", "deploy.logs", "deploy.rollback", "deploy.request"] as const;
export type DeployVerb = (typeof DEPLOY_VERBS)[number];
export type AnyVerb = Verb | DeployVerb;
export const isDeployVerb = (v: unknown): v is DeployVerb => (DEPLOY_VERBS as readonly unknown[]).includes(v);
export const isVerb = (v: unknown): v is AnyVerb => (VERBS as readonly unknown[]).includes(v) || isDeployVerb(v);
/** Verbs that change nothing and take no lock. */
export const READ_VERBS: readonly Verb[] = ["status", "logs", "doctor"];
/** The deploy verbs anyone with the project in scope may call: they read (§app.project-services/deploy-callers). */
export const DEPLOY_READ_VERBS: readonly DeployVerb[] = ["deploy.status", "deploy.logs", "deploy.check"];

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
  "deploy-refused",
  "needs-override",
  "deploy-failed",
  "verify-failed",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export type ExitClass = 0 | 1 | 2 | 3 | 4;
const EXIT: Record<ErrorCode, ExitClass> = {
  "not-ready": 1,
  "start-failed": 1,
  "hook-failed": 1,
  "tests-failed": 1,
  "deploy-failed": 1,
  "verify-failed": 1,
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
  "deploy-refused": 2,
  "needs-override": 2,
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
  /** How it is isolated and why: a record for the reader, never applied; outside the hash. */
  isolation?: IsolationDecl;
  /** In slot 0, this systemd unit Sova did not start, on these fixed ports (§app.project-services/adopt); inside the hash. */
  adopt?: AdoptDecl;
  /** `reload`: apply it on the main checkout's copy whenever main's HEAD moves, while it runs there (§app.project-services/on-merge); inside the hash. */
  onMerge?: "reload";
}
/** `unit` a whole `.service` name, never Sova's own; `ports` every port of the service, fixed. */
export interface AdoptDecl {
  unit: string;
  ports: Record<string, number>;
}
export const ISOLATION_METHODS = ["ports", "names", "process", "container", "netns", "shared"] as const;
export interface IsolationDecl {
  method: (typeof ISOLATION_METHODS)[number];
  why: string;
}
/** The project's test command (§app.project-services/test). */
export interface TestDecl {
  run: Argv;
  requires: string[];
  timeout: number;
  /** A small selection, green on the main checkout, that conformance runs. */
  smoke: string[];
}
/** `sensitive`: its copies hold data derived from production, so no instance holding it is ever shared; inside the hash. */
export type DataDecl =
  | { name: string; kind: "dir"; path?: string; from: string; sensitive?: true }
  | { name: string; kind: "hook"; provision: Argv; deprovision: Argv; timeout: number; sensitive?: true };
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
  /** What a running copy may share (§app.project-services/share); absent: nothing. Inside the hash. */
  share?: ShareDecl;
  /** The entry point: where a person opens the app. Exposes nothing, so outside the hash. */
  open?: OpenDecl;
  /** How it ships (§app.project-services/deploy): outside the definition's hash, under its own (deployHash). */
  deploy?: DeployDecl;
  /** The checkout files the definition was written from; their change at HEAD is drift. Outside the hash. */
  sources?: string[];
}

/** The endpoints a copy may share (`"<service>.<port>"`, checkout services only; none when absent), at most `maxDays` per link, and whether at all. */
export interface ShareDecl {
  endpoints: string[];
  /** 1–SHARE_DAYS_MAX; absent: SHARE_DAYS_MAX. */
  maxDays?: number;
  /** false: never shared, whatever is listed. */
  allow?: false;
}
/** The project's entry point (§app.project-services/contract): a checkout service's declared port (`"<service>.<port>"`) and the page's path there ("/" when absent). */
export interface OpenDecl {
  endpoint: string;
  path: string;
}
/** One deploy step: an argv run in the deploy's fresh checkout, in order (§app.project-services/deploy). */
export interface DeployStepDecl {
  id: string;
  run: Argv;
  timeout: number;
}
/** How a target is undone: its own steps, the last verified commit deployed again, or nothing, with the operator's reason. */
export type DeployRollbackDecl = { steps: DeployStepDecl[] } | "redeploy-previous" | { none: string };
export const CREDENTIAL_KINDS = ["env", "ssh", "tool-login"] as const;
/** A credential by name only: `env` a host variable's value (never in the repo), `ssh` and `tool-login` the tool's own store, which Sova never reads. */
export interface DeployCredentialDecl {
  name: string;
  kind: (typeof CREDENTIAL_KINDS)[number];
  /** Run at plan: exit 0 means the credential works. */
  check: Argv;
}
export interface DeployVerifyDecl {
  /** An http(s) URL (a template). */
  http: string;
  /** The status a healthy answer has. */
  expect: number;
  timeout: number;
}
export const DEPLOY_TESTS = ["smoke", "full", "none"] as const;
export interface DeployTargetDecl {
  name: string;
  about: string;
  /** The branch a commit must be on to ship here; absent: the main checkout's branch. */
  branch?: string;
  build: DeployStepDecl[];
  steps: DeployStepDecl[];
  /** Read-only steps run at plan (a dry run, a terraform plan). */
  plan: DeployStepDecl[];
  verify?: DeployVerifyDecl;
  rollback: DeployRollbackDecl;
  credentials: DeployCredentialDecl[];
  requires: { tests: (typeof DEPLOY_TESTS)[number] };
}
export interface DeployDecl {
  /** In declaration order. */
  targets: DeployTargetDecl[];
}
export const DEPLOY_TIMEOUT_DEFAULT = 600;
export const DEPLOY_VERIFY_TIMEOUT_DEFAULT = 30;
export const DEPLOY_TARGETS_MAX = 10;
export const DEPLOY_STEPS_MAX = 30;
/** The variables a deploy step reads besides `${host.NAME}`: the commit shipped, the target, the deploy's checkout and the target's branch. */
export const DEPLOY_VARS = ["commit", "target", "checkout", "branch"] as const;
export const OPEN_PATH_MAX = 200;
/** An instance link lasts 1 day by default and at most 7 (§app.project-services/share). */
export const SHARE_DAYS_DEFAULT = 1;
export const SHARE_DAYS_MAX = 7;
export const SHARE_ENDPOINTS_MAX = 20;

export const CONTRACT_FILE = ".sova/project.json";
export const SLOT_CAP_DEFAULT = 4;
export const SLOT_CAP_MAX = 16;
export const READY_TIMEOUT_DEFAULT = 60;
export const READY_TIMEOUT_MAX = 600;
export const HOOK_TIMEOUT_DEFAULT = 120;
export const HOOK_TIMEOUT_MAX = 1800;
export const TEST_TIMEOUT_DEFAULT = 600;
export const ABOUT_MAX = 200;
export const SOURCES_MAX = 50;
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

/** Every key the declaration accepts, by where it sits (the parse refuses any other; the playbook's reference is pinned to these). */
export const DEFINITION_KEYS = {
  top: ["version", "slots", "host", "setup", "data", "services", "open", "hooks", "test", "share", "deploy", "sources"],
  slots: ["cap"],
  step: ["id", "run", "inputs", "timeout"],
  service: ["cmd", "static", "cwd", "env", "ports", "requires", "ready", "reload", "build", "scope", "container", "start", "about", "isolation", "adopt", "onMerge"],
  port: [["base", "stride"], ["fixed"]],
  ready: [["tcp", "timeout"], ["http", "path", "timeout"]],
  reload: [["signal"], ["cmd"]],
  build: ["run", "inputs", "timeout"],
  container: ["name", "engine"],
  isolation: ["method", "why"],
  adopt: ["unit", "ports"],
  data: [["kind", "path", "from", "sensitive"], ["kind", "provision", "deprovision", "timeout", "sensitive"]],
  hooks: ["probe"],
  probe: ["run", "inputs", "timeout"],
  test: ["run", "requires", "timeout", "smoke"],
  share: ["endpoints", "maxDays", "allow"],
  open: ["endpoint", "path"],
  deploy: ["targets"],
  target: ["about", "branch", "build", "steps", "plan", "verify", "rollback", "credentials", "requires"],
  deployStep: ["id", "run", "timeout"],
  verify: ["http", "expect", "timeout"],
  rollback: [["steps"], ["none"]],
  credential: ["name", "kind", "check"],
  requires: ["tests"],
} as const;
const K = DEFINITION_KEYS;

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
  keysOnly(o, withId ? K.step : K.build, path);
  const id = withId ? name(typeof o.id === "string" ? o.id : "", `${path}.id`) : "";
  return { id, run: argv(o.run, `${path}.run`), inputs: strList(o.inputs, `${path}.inputs`).map((p, i) => relPath(p, `${path}.inputs[${i}]`, true)), timeout: timeout(o.timeout, `${path}.timeout`, HOOK_TIMEOUT_DEFAULT, HOOK_TIMEOUT_MAX) };
}

function port(v: unknown, path: string): PortDecl {
  const o = obj(v, path);
  if ("fixed" in o) {
    keysOnly(o, K.port[1], path);
    return { fixed: int(o.fixed, `${path}.fixed`, 1024, 65535) };
  }
  keysOnly(o, K.port[0], path);
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
    keysOnly(o, K.ready[0], path);
    return { tcp: portName(o.tcp, `${path}.tcp`), timeout: t };
  }
  if ("http" in o) {
    keysOnly(o, K.ready[1], path);
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
    keysOnly(o, K.reload[0], path);
    if (!(SIGNALS as readonly unknown[]).includes(o.signal)) throw new DefinitionError(`${path}.signal`, `must be one of ${SIGNALS.join(", ")}`);
    return { signal: o.signal as (typeof SIGNALS)[number] };
  }
  keysOnly(o, K.reload[1], path);
  return { cmd: argv(o.cmd, `${path}.cmd`) };
}

function service(nm: string, v: unknown, path: string): ServiceDecl {
  const o = obj(v, path);
  keysOnly(o, K.service, path);
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
  if (o.isolation !== undefined) {
    const i = obj(o.isolation, `${path}.isolation`);
    keysOnly(i, K.isolation, `${path}.isolation`);
    if (!(ISOLATION_METHODS as readonly unknown[]).includes(i.method)) throw new DefinitionError(`${path}.isolation.method`, `must be one of ${ISOLATION_METHODS.join(", ")}`);
    if (typeof i.why !== "string" || !i.why.trim() || i.why.length > ABOUT_MAX) throw new DefinitionError(`${path}.isolation.why`, `must be a sentence of at most ${ABOUT_MAX} characters`);
    out.isolation = { method: i.method as IsolationDecl["method"], why: i.why };
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
    keysOnly(c, K.container, `${path}.container`);
    if (typeof c.name !== "string" || !c.name) throw new DefinitionError(`${path}.container.name`, "must be a container name (a template)");
    const engine = c.engine === undefined ? "docker" : c.engine;
    if (engine !== "docker" && engine !== "podman") throw new DefinitionError(`${path}.container.engine`, "must be docker or podman");
    out.container = { name: c.name, engine };
  }
  if (scope === "shared")
    for (const [k, p] of Object.entries(ports)) if (!("fixed" in p)) throw new DefinitionError(`${path}.ports.${k}`, "a shared service's ports are fixed");
  if (o.adopt !== undefined) out.adopt = adopt(o.adopt, `${path}.adopt`, out);
  if (o.onMerge !== undefined) {
    if (o.onMerge !== "reload") throw new DefinitionError(`${path}.onMerge`, 'must be "reload"');
    if (hasStatic) throw new DefinitionError(`${path}.onMerge`, "a static service's files are live: nothing reloads on merge");
    if (scope === "shared") throw new DefinitionError(`${path}.onMerge`, "a shared service is no copy's: onMerge reloads the main checkout's own services");
    out.onMerge = "reload";
  }
  return out;
}

/** An adopted unit: a systemd service name that is not Sova's own, and a fixed port for each of the service's ports. */
const UNIT_NAME = /^[A-Za-z0-9@._:-]{1,200}\.service$/;
function adopt(v: unknown, path: string, s: ServiceDecl): AdoptDecl {
  const o = obj(v, path);
  keysOnly(o, K.adopt, path);
  if (s.static !== undefined || s.container || s.scope === "shared") throw new DefinitionError(path, "only a cmd checkout service (no container) adopts a unit");
  if (typeof o.unit !== "string" || !UNIT_NAME.test(o.unit)) throw new DefinitionError(`${path}.unit`, "must be a systemd user service name (<name>.service)");
  if (/^sova-(svc|hook|restart)-/.test(o.unit)) throw new DefinitionError(`${path}.unit`, "must be a unit Sova did not start (never sova-svc-…, sova-hook-…)");
  const p = obj(o.ports, `${path}.ports`);
  const ports: Record<string, number> = {};
  for (const k of Object.keys(p)) if (!(k in s.ports)) throw new DefinitionError(`${path}.ports.${k}`, "names no port of the service");
  for (const k of Object.keys(s.ports)) {
    if (p[k] === undefined) throw new DefinitionError(`${path}.ports`, `give the unit's port for ${k}`);
    ports[k] = int(p[k], `${path}.ports.${k}`, 1024, 65535);
  }
  return { unit: o.unit, ports };
}

/** `sensitive: true` kept; false (the default) dropped, so a definition hashes as it did without the key. */
function sensitive(o: Obj, path: string): { sensitive?: true } {
  if (o.sensitive === undefined || o.sensitive === false) return {};
  if (o.sensitive !== true) throw new DefinitionError(`${path}.sensitive`, "must be true or false");
  return { sensitive: true };
}

function data(nm: string, v: unknown, path: string): DataDecl {
  const o = obj(v, path);
  if (o.kind === "dir") {
    keysOnly(o, K.data[0], path);
    const from = o.from === undefined ? "empty" : o.from;
    if (typeof from !== "string" || !from) throw new DefinitionError(`${path}.from`, 'must be "empty" or a folder (a template)');
    return { name: nm, kind: "dir", ...(o.path !== undefined ? { path: relPath(o.path, `${path}.path`, true) } : {}), from, ...sensitive(o, path) };
  }
  if (o.kind === "hook") {
    keysOnly(o, K.data[1], path);
    return { name: nm, kind: "hook", provision: argv(o.provision, `${path}.provision`), deprovision: argv(o.deprovision, `${path}.deprovision`), timeout: timeout(o.timeout, `${path}.timeout`, HOOK_TIMEOUT_DEFAULT, HOOK_TIMEOUT_MAX), ...sensitive(o, path) };
  }
  throw new DefinitionError(`${path}.kind`, 'must be "dir" or "hook"');
}

/** `share`: each endpoint a checkout service's declared port, once; `maxDays` 1–7; `allow: true` (the default) dropped, so it hashes as without. */
function shareDecl(v: unknown, services: readonly ServiceDecl[]): ShareDecl {
  const o = obj(v, "$.share");
  keysOnly(o, K.share, "$.share");
  if (o.endpoints !== undefined && !Array.isArray(o.endpoints)) throw new DefinitionError("$.share.endpoints", 'must be a list of "<service>.<port>"');
  const list: unknown[] = (o.endpoints as unknown[] | undefined) ?? [];
  if (list.length > SHARE_ENDPOINTS_MAX) throw new DefinitionError("$.share.endpoints", `at most ${SHARE_ENDPOINTS_MAX} endpoints`);
  const endpoints: string[] = [];
  for (const [i, e] of list.entries()) {
    const at = `$.share.endpoints[${i}]`;
    const m = typeof e === "string" ? /^([a-z][a-z0-9-]{0,30})\.([a-z][a-z0-9-]{0,30})$/.exec(e) : null;
    if (!m) throw new DefinitionError(at, 'must be "<service>.<port>"');
    const svc = services.find((s) => s.name === m[1]);
    if (!svc || !(m[2]! in svc.ports)) throw new DefinitionError(at, `names no declared port (${e as string})`);
    if (svc.scope === "shared") throw new DefinitionError(at, "a shared service is never shared: only a copy's own (checkout) services");
    if (endpoints.includes(e as string)) throw new DefinitionError(at, "each endpoint once");
    endpoints.push(e as string);
  }
  const out: ShareDecl = { endpoints };
  if (o.maxDays !== undefined) out.maxDays = int(o.maxDays, "$.share.maxDays", 1, SHARE_DAYS_MAX);
  if (o.allow !== undefined && o.allow !== true) {
    if (o.allow !== false) throw new DefinitionError("$.share.allow", "must be true or false");
    out.allow = false;
  }
  return out;
}

/** `open`: a checkout service's declared port and a path from `/` (no space, control character or backslash), "/" when absent. */
function openDecl(v: unknown, services: readonly ServiceDecl[]): OpenDecl {
  const o = obj(v, "$.open");
  keysOnly(o, K.open, "$.open");
  const m = typeof o.endpoint === "string" ? /^([a-z][a-z0-9-]{0,30})\.([a-z][a-z0-9-]{0,30})$/.exec(o.endpoint) : null;
  if (!m) throw new DefinitionError("$.open.endpoint", 'must be "<service>.<port>"');
  const svc = services.find((s) => s.name === m[1]);
  if (!svc || !(m[2]! in svc.ports)) throw new DefinitionError("$.open.endpoint", `names no declared port (${o.endpoint as string})`);
  if (svc.scope === "shared") throw new DefinitionError("$.open.endpoint", "a shared service is no copy's own: the entry is a checkout service's port");
  const path = o.path === undefined ? "/" : o.path;
  if (typeof path !== "string" || !path.startsWith("/") || path.length > OPEN_PATH_MAX || /[\s\\\u0000-\u001f\u007f]/.test(path))
    throw new DefinitionError("$.open.path", `must start with / (at most ${OPEN_PATH_MAX} characters, no spaces or backslashes)`);
  return { endpoint: o.endpoint as string, path };
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

// ---- deploy (§app.project-services/deploy) ------------------------------------------------------

const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/;
const CREDENTIAL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,63}$/;

function deploySteps(v: unknown, path: string, min: number): DeployStepDecl[] {
  if (v === undefined && min === 0) return [];
  if (!Array.isArray(v) || v.length < min) throw new DefinitionError(path, min ? "must be a list of steps {id, run}, at least one" : "must be a list of steps {id, run}");
  if (v.length > DEPLOY_STEPS_MAX) throw new DefinitionError(path, `at most ${DEPLOY_STEPS_MAX} steps`);
  const out = v.map((x, i) => {
    const at = `${path}[${i}]`;
    const o = obj(x, at);
    keysOnly(o, K.deployStep, at);
    return { id: name(typeof o.id === "string" ? o.id : "", `${at}.id`), run: argv(o.run, `${at}.run`), timeout: timeout(o.timeout, `${at}.timeout`, DEPLOY_TIMEOUT_DEFAULT, HOOK_TIMEOUT_MAX) };
  });
  if (new Set(out.map((s) => s.id)).size !== out.length) throw new DefinitionError(path, "step ids must be unique");
  return out;
}

function deployTarget(nm: string, v: unknown, path: string): DeployTargetDecl {
  const o = obj(v, path);
  keysOnly(o, K.target, path);
  if (typeof o.about !== "string" || !o.about.trim() || o.about.length > ABOUT_MAX || o.about.includes("${")) throw new DefinitionError(`${path}.about`, `must say what the target is, a sentence of at most ${ABOUT_MAX} characters with no template`);
  const out: DeployTargetDecl = {
    name: nm,
    about: o.about,
    build: deploySteps(o.build, `${path}.build`, 0),
    steps: deploySteps(o.steps, `${path}.steps`, 1),
    plan: deploySteps(o.plan, `${path}.plan`, 0),
    rollback: "redeploy-previous",
    credentials: [],
    requires: { tests: "smoke" },
  };
  if (o.branch !== undefined) {
    if (typeof o.branch !== "string" || !BRANCH.test(o.branch) || o.branch.includes("..")) throw new DefinitionError(`${path}.branch`, "must be a plain branch name");
    out.branch = o.branch;
  }
  if (o.verify !== undefined) {
    const vo = obj(o.verify, `${path}.verify`);
    keysOnly(vo, K.verify, `${path}.verify`);
    if (typeof vo.http !== "string" || !/^https?:\/\/\S+$/.test(vo.http)) throw new DefinitionError(`${path}.verify.http`, "must be an http:// or https:// URL (a template)");
    out.verify = { http: vo.http, expect: vo.expect === undefined ? 200 : int(vo.expect, `${path}.verify.expect`, 100, 599), timeout: timeout(vo.timeout, `${path}.verify.timeout`, DEPLOY_VERIFY_TIMEOUT_DEFAULT, READY_TIMEOUT_MAX) };
  }
  if (o.rollback === undefined) throw new DefinitionError(`${path}.rollback`, 'say how it is undone: {steps: [...]}, "redeploy-previous" or {none: "<why>"}');
  if (o.rollback !== "redeploy-previous") {
    const r = obj(o.rollback, `${path}.rollback`);
    if ("none" in r) {
      keysOnly(r, K.rollback[1], `${path}.rollback`);
      if (typeof r.none !== "string" || !r.none.trim() || r.none.length > ABOUT_MAX) throw new DefinitionError(`${path}.rollback.none`, `must be the reason it can't be undone, a sentence of at most ${ABOUT_MAX} characters`);
      out.rollback = { none: r.none };
    } else {
      keysOnly(r, K.rollback[0], `${path}.rollback`);
      out.rollback = { steps: deploySteps(r.steps, `${path}.rollback.steps`, 1) };
    }
  }
  if (o.credentials !== undefined) {
    if (!Array.isArray(o.credentials)) throw new DefinitionError(`${path}.credentials`, "must be a list of {name, kind, check}");
    out.credentials = o.credentials.map((x, i) => {
      const at = `${path}.credentials[${i}]`;
      const c = obj(x, at);
      keysOnly(c, K.credential, at);
      if (!(CREDENTIAL_KINDS as readonly unknown[]).includes(c.kind)) throw new DefinitionError(`${at}.kind`, `must be one of ${CREDENTIAL_KINDS.join(", ")}`);
      const kind = c.kind as DeployCredentialDecl["kind"];
      if (typeof c.name !== "string" || !(kind === "env" ? ENV_NAME.test(c.name) && !sovaSets(c.name) : CREDENTIAL_NAME.test(c.name)))
        throw new DefinitionError(`${at}.name`, kind === "env" ? "an env credential is a variable name (A-Z, 0-9 and _), never one Sova sets" : "must be a name (letters, digits and _ . @ -)");
      return { name: c.name, kind, check: argv(c.check, `${at}.check`) };
    });
    if (new Set(out.credentials.map((c) => c.name)).size !== out.credentials.length) throw new DefinitionError(`${path}.credentials`, "each credential once");
  }
  if (o.requires !== undefined) {
    const r = obj(o.requires, `${path}.requires`);
    keysOnly(r, K.requires, `${path}.requires`);
    if (!(DEPLOY_TESTS as readonly unknown[]).includes(r.tests)) throw new DefinitionError(`${path}.requires.tests`, `must be one of ${DEPLOY_TESTS.join(", ")}`);
    out.requires = { tests: r.tests as DeployTargetDecl["requires"]["tests"] };
  }
  return out;
}

function deployDecl(v: unknown, test: TestDecl | undefined): DeployDecl {
  const o = obj(v, "$.deploy");
  keysOnly(o, K.deploy, "$.deploy");
  const t = obj(o.targets, "$.deploy.targets");
  const targets = Object.entries(t).map(([k, x]) => deployTarget(name(k, `$.deploy.targets.${k}`), x, `$.deploy.targets.${k}`));
  if (!targets.length) throw new DefinitionError("$.deploy.targets", "declare at least one target");
  if (targets.length > DEPLOY_TARGETS_MAX) throw new DefinitionError("$.deploy.targets", `at most ${DEPLOY_TARGETS_MAX} targets`);
  for (const x of targets) if (x.requires.tests !== "none" && !test) throw new DefinitionError(`$.deploy.targets.${x.name}.requires.tests`, `requires ${x.requires.tests} tests, and the definition declares no test command`);
  return { targets };
}

/** Every step of a target, in the order they run, each with its review key (`<list>.<id>`, a credential's `credentials.<name>`). */
export function deployStepsOf(t: DeployTargetDecl): { key: string; list: "credentials" | "plan" | "build" | "steps" | "rollback"; id: string; run: Argv }[] {
  return [
    ...t.credentials.map((c) => ({ key: `credentials.${c.name}`, list: "credentials" as const, id: c.name, run: c.check })),
    ...t.plan.map((s) => ({ key: `plan.${s.id}`, list: "plan" as const, id: s.id, run: s.run })),
    ...t.build.map((s) => ({ key: `build.${s.id}`, list: "build" as const, id: s.id, run: s.run })),
    ...t.steps.map((s) => ({ key: `steps.${s.id}`, list: "steps" as const, id: s.id, run: s.run })),
    ...(typeof t.rollback === "object" && "steps" in t.rollback ? t.rollback.steps.map((s) => ({ key: `rollback.${s.id}`, list: "rollback" as const, id: s.id, run: s.run })) : []),
  ];
}

/** The variables a deploy's templates may read. */
function deployVars(def: Pick<ProjectDef, "host">): Set<string> {
  const v = new Set<string>(DEPLOY_VARS);
  for (const h of def.host) v.add(`host.${h}`);
  return v;
}

/** Every template of the deploy section, with where. */
function* deployTemplates(d: DeployDecl): Generator<[string, string]> {
  for (const t of d.targets) {
    const p = `deploy.targets.${t.name}`;
    for (const s of deployStepsOf(t)) for (const [i, a] of s.run.entries()) yield [a, `${p}.${s.list === "credentials" ? `credentials.${s.id}.check` : `${s.list}.${s.id}.run`}[${i}]`];
    if (t.verify) yield [t.verify.http, `${p}.verify.http`];
  }
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
  keysOnly(o, K.top, "$");
  if (o.version !== 1) throw new DefinitionError("$.version", "must be 1");
  let cap = SLOT_CAP_DEFAULT;
  if (o.slots !== undefined) {
    const s = obj(o.slots, "$.slots");
    keysOnly(s, K.slots, "$.slots");
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
    keysOnly(h, K.hooks, "$.hooks");
    if (h.probe !== undefined) {
      const p = step(h.probe, "$.hooks.probe", false);
      hooks.probe = { run: p.run, timeout: p.timeout };
    }
  }
  let sources: string[] | undefined;
  if (o.sources !== undefined) {
    const list = strList(o.sources, "$.sources");
    if (list.length > SOURCES_MAX) throw new DefinitionError("$.sources", `at most ${SOURCES_MAX} files`);
    sources = list.map((p, i) => relPath(p, `$.sources[${i}]`, true));
    if (new Set(sources).size !== sources.length) throw new DefinitionError("$.sources", "each file once");
  }
  let test: TestDecl | undefined;
  if (o.test !== undefined) {
    const t = obj(o.test, "$.test");
    keysOnly(t, K.test, "$.test");
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
    ...(o.share !== undefined ? { share: shareDecl(o.share, services) } : {}),
    ...(o.open !== undefined ? { open: openDecl(o.open, services) } : {}),
    ...(o.deploy !== undefined ? { deploy: deployDecl(o.deploy, test) } : {}),
    ...(sources ? { sources } : {}),
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
  const adopting = services.filter((s) => s.adopt);
  if (adopting.length > 1) throw new DefinitionError(`$.services.${adopting[1]!.name}.adopt`, "at most one service adopts a unit");
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
  // An adopted unit's ports are its own in slot 0: no slot's allocation may give one to any service.
  for (const s of adopting)
    for (const [k, n] of Object.entries(s.adopt!.ports)) {
      const other = seen.get(n);
      if (other && !(other.key === `${s.name}.${k}` && other.slot === 0)) throw new DefinitionError(`$.services.${s.name}.adopt.ports.${k}`, `port ${n} is ${other.key}'s in slot ${other.slot}`);
    }
  // Templates: every variable must be one Sova knows.
  const vars = templateVars(def);
  for (const [t, where] of templates(def)) {
    const bad = unknownVars(t, vars);
    if (bad) throw new DefinitionError(`$.${where}`, bad);
  }
  if (def.deploy) {
    const dv = deployVars(def);
    for (const [t, where] of deployTemplates(def.deploy)) {
      const bad = unknownVars(t, dv);
      if (bad) throw new DefinitionError(`$.${where}`, bad);
    }
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

/** Every port of the definition in `slot`: `{service: {port: number}}`, shared services included; an adopted service's in slot 0 are its unit's. */
export function portsFor(def: Pick<ProjectDef, "services">, slot: number): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const s of def.services) {
    out[s.name] = {};
    for (const [k, p] of Object.entries(s.ports)) out[s.name]![k] = slot === 0 && s.adopt ? s.adopt.ports[k]! : portFor(p, slot);
  }
  return out;
}

/** The service slot 0 adopts (§app.project-services/adopt), if any. */
export const adoptedService = (def: Pick<ProjectDef, "services">): ServiceDecl | null => def.services.find((s) => s.adopt) ?? null;

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
export type StepKind = "setup" | "data" | "hook" | "build" | "start" | "ready" | "reload" | "stop" | "check" | "worktree" | "slot" | "test" | "link";
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
  /** The resident memory of its unit's processes now, while a process or container service runs. */
  rssBytes?: number;
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
  /** Its active share links (§app.project-services/share). */
  links: LinkView[];
  /** The endpoints its definition lets it share, and why it can't when it can't (null: it can). */
  share: { endpoints: string[]; refused: string | null };
}
/** One share link of an instance (§app.project-services/share). `url` only for the operator, never in a tool result. */
export interface LinkView {
  id: string;
  instance: string;
  endpoint: string;
  port: number;
  createdAt: string;
  expiresAt: string;
  state: "active" | "expired" | "revoked";
  createdBy: string;
  url?: string;
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
/** One service's resident memory over a conformance run: its peak, and its steady reading (null: never read). */
export interface MemoryReading {
  peakBytes: number | null;
  steadyBytes: number | null;
}
/** Each scratch instance's memory (the sum of its services), and each service's (§app.project-services/conform). */
export interface ConformMemory {
  instances: (MemoryReading & { label: "A" | "B"; services: (MemoryReading & { name: string })[] })[];
}
export interface ConformLog {
  label: "A" | "B";
  /** A service's name, or `step:<unit step>` (`step:setup-<id>`, `step:build-<service>`, `step:data-<name>-provision`) for a failed step. */
  service: string;
  state: string;
  lines: string[];
}
export const CONFORM_LOG_LINES = 80;
export interface ConformReport {
  suiteVersion: number;
  defHash: string;
  ref: string;
  pass: boolean;
  checks: Check[];
  leaks: string[];
  /** On a failed run: the last lines of each service (or step) that was not ready or failed, read before teardown. */
  logs?: ConformLog[];
  /** Run in a private network namespace under the sandbox policy, before approval (§app.project-services/confined). */
  confined?: boolean;
  memory?: ConformMemory;
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
/** A target's deploy standing (§app.project-runtime/deploy-standing), derived from main's deploy and this host's approvals. */
export type DeployStanding = "none" | "awaiting-approval" | "approved" | "stale";
/** One step as the operator ticks it: its argv with `${host.…}` resolved on this host (`unset`: the names this host lacks), `${commit}` and the like kept. */
export interface DeployReviewStep {
  key: string;
  list: "credentials" | "plan" | "build" | "steps" | "rollback";
  id: string;
  argv: string[];
  unset: string[];
}
export interface DeployTargetReview {
  name: string;
  about: string;
  /** The branch a commit must be on (declared, else main's). */
  branch: string;
  steps: DeployReviewStep[];
  credentials: { name: string; kind: DeployCredentialDecl["kind"] }[];
  verify: { url: string; expect: number; unset: string[] } | null;
  rollback: "steps" | "redeploy-previous" | { none: string };
  tests: DeployTargetDecl["requires"]["tests"];
}
/** The Sova-rendered review of a deploy section (§app.project-services/deploy-trust): every key must be ticked before it is approved. */
export interface DeployReview {
  deployHash: string;
  targets: DeployTargetReview[];
  /** Every tick: `<target>/<step key>`, `<target>/verify` when declared, and `<target>/rollback`. */
  keys: string[];
}
/** The keys a review needs ticked. Pure. */
export function reviewKeys(targets: readonly { name: string; steps: readonly { key: string }[]; verify: unknown }[]): string[] {
  return targets.flatMap((t) => [...t.steps.map((s) => `${t.name}/${s.key}`), ...(t.verify ? [`${t.name}/verify`] : []), `${t.name}/rollback`]);
}
export type DeployKind = "deploy" | "rollback";
export type DeployState = "running" | "succeeded" | "failed" | "verify-failed" | "interrupted";
export interface DeployStepRun {
  key: string;
  exit: number | null;
  ms: number;
  timedOut?: boolean;
}
/** One deploy (or rollback) of a target, as deploy.status and deploy.run answer it. */
export interface DeployRecordView {
  id: string;
  target: string;
  kind: DeployKind;
  commit: string;
  planId: string;
  deployHash: string;
  by: string;
  startedAt: string;
  endedAt: string | null;
  state: DeployState;
  steps: DeployStepRun[];
  verify: { url: string; status: number | null; ok: boolean; detail: string } | null;
  /** The operator's typed reasons for what the plan let through (§app.project-services/deploy-plan). */
  overrides: { tests?: string; dirty?: string };
  /** Why it failed, when it did. */
  detail?: string;
}
/** A plan (§app.project-services/deploy-plan): good for 15 minutes, once. */
export interface DeployPlanView {
  planId: string;
  project: string;
  target: string;
  kind: DeployKind;
  commit: string;
  deployHash: string;
  createdAt: string;
  expiresAt: string;
  checks: Check[];
  overrides: { tests?: string; dirty?: string };
  /** What deploy.run will run, resolved, in order. */
  steps: { key: string; argv: string[] }[];
  verify: { url: string; expect: number } | null;
}
export interface DeployTargetView {
  name: string;
  about: string;
  standing: DeployStanding;
  /** When this deploy hash was approved here. */
  approvedAt: string | null;
  /** Its deploy now, or the last one. */
  last: DeployRecordView | null;
  /** The last verified deploy's commit (redeploy-previous goes back before it). */
  verifiedCommit: string | null;
  rollback: "steps" | "redeploy-previous" | { none: string };
  /** An overseer's open request to deploy (§app.project-services/deploy-callers). */
  request: DeployRequestView | null;
}
export interface DeployRequestView {
  id: string;
  target: string;
  commit: string | null;
  why: string;
  by: string;
  at: string;
}
/** The deploy verbs' own key in the result. */
export interface DeployReport {
  /** Main's deploy hash (deploy.status, deploy.check: the ref's), null when it declares none. */
  deployHash: string | null;
  approved: boolean;
  targets?: DeployTargetView[];
  /** While the hash waits for approval (deploy.status). */
  review?: DeployReview;
  plan?: DeployPlanView;
  record?: DeployRecordView;
  history?: DeployRecordView[];
  request?: DeployRequestView;
}
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
  links: LinkView[];
  instances?: InstanceSummary[];
  lines?: LogLine[];
  checks?: Check[];
  conform?: ConformReport;
  tests?: TestsReport;
  deploy?: DeployReport;
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
    ...(r.deploy !== undefined ? { deploy: r.deploy } : {}),
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
  const optional = ["instances", "lines", "checks", "conform", "tests", "deploy", "error"];
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
