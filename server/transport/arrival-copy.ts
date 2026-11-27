// The arrived chat's running copy (§app.transport/agent "Ready means the app runs"): once the chat is here, Sova's
// server (the project's services, never the agent's sandbox) starts the copies the device it came from ran for it
// (the services the switch stopped there, each on its tree here), else the project's own copy of the chat's tree, and
// waits for each service to be ready; then it opens the project's entry page (its definition's `open`) and wants an
// HTTP success. That copy stays running, its data the project's own fresh data (data never travels). A project with no
// definition here starts no copy. One start at a time per transport. Pure but for the deps it is handed.
import type { AgentCheck } from "./agent";

/** A copy to start here: the tree (its folder on this device), its name as Running Copies names it, and its services
    (absent: the copy's own default, every checkout service its `up` starts). */
export interface CopyPlan {
  tree: string;
  name: string;
  services?: string[];
}

/** What `up` answered (the engine's result, cut to what the reading uses). */
export interface CopyUp {
  ok: boolean;
  instance: string | null;
  services: { name: string; scope: string; state: string; ports: Record<string, number>; detail?: string }[];
  steps: { id: string; kind: string; result: string; detail?: string }[];
  error?: { code: string; message: string; step?: string; service?: string };
}

/** A copy's entry page: its endpoint, that endpoint's port in this copy, and the page's path. */
export interface CopyEntry {
  endpoint: string;
  port: number;
  path: string;
}

export interface CopyReading {
  name: string;
  tree: string;
  ok: boolean;
  detail: string;
  instance?: string;
  entry?: CopyEntry;
  /** What failed: a setup or data step's id, or a service's name (copy_logs reads it). */
  step?: string;
  service?: string;
  /** The copy's own (checkout) services up answered for. */
  services?: string[];
}

/** The transport's running copy as its card shows it. `waiting`: it starts once the rest here is set up; `none`: the
    project has no running-copy definition here, so none was started. */
export interface CopyView {
  state: "waiting" | "starting" | "running" | "failed" | "none";
  copies: { name: string; ok: boolean; detail: string; entry?: CopyEntry }[];
  at: number;
}

export interface CopyDeps {
  /** Start (or keep) the copy of the checkout `tree` with `services`, through this server's project services, and wait
      until each is ready (the engine's `up`). */
  copyUp(tree: string, services?: string[]): Promise<CopyUp>;
  /** The project's definition at `tree`, as far as the copy needs it: its entry (`open`) or null; null: none here. */
  copyDef(tree: string): { open: { endpoint: string; path: string } | null } | null;
  /** GET the entry page on this device: its HTTP status, null when nothing answered. */
  entryAnswers(port: number, path: string): Promise<number | null>;
  /** The copy's log: a service's, or a setup or data step's, oldest first. */
  logs(instance: string, what: { service?: string; step?: string }, lines: number): Promise<string[]>;
  /** Each service of the copy `instance` as it is now (the engine's status); null: unreadable. */
  copyStatus?(instance: string): Promise<{ name: string; scope: string; state: string }[] | null>;
  /** Stop just these services of the copy `instance` (the engine's down of them; its data kept). */
  copyDown?(instance: string, services: string[]): Promise<void>;
}

/** A service that isn't running well: its next start must be a fresh one, never a bare up of what it has. */
const UNWELL = new Set(["failed", "degraded", "starting"]);

/**
 * Which of a copy's services a start again after a failure stops first (then up starts them fresh): its own (checkout)
 * services that are failed, degraded or still starting, and every one of them running since before the agent's last
 * fix (`started`: when each was last started, `fixAt`: the agent's last tool call that could change something, null
 * when none is known). A healthy service started after that fix, a stopped one (up starts it anyway) and a shared one
 * are left as they are. Pure.
 */
export function restartOf(services: readonly { name: string; scope: string; state: string }[], started: Readonly<Record<string, number>>, fixAt: number | null): string[] {
  return services
    .filter((s) => s.scope === "checkout" && s.state !== "stopped")
    .filter((s) => UNWELL.has(s.state) || (fixAt !== null && (started[s.name] ?? 0) < fixAt))
    .map((s) => s.name);
}

/** An HTTP success: 2xx, or a redirect (a sign-in page's). Pure. */
export const entryOk = (status: number | null): boolean => status !== null && status >= 200 && status < 400;

/** The copies to start: the source's, each on its tree here, else the chat's own tree's copy; only trees whose
    definition is here. Pure but for reading the definitions. */
export function copyPlan(running: readonly CopyPlan[], ownTree: string, deps: Pick<CopyDeps, "copyDef">, ownName?: string): CopyPlan[] {
  const asked = running.length ? running : [{ tree: ownTree, name: ownName ?? ownTree.split("/").filter(Boolean).pop() ?? ownTree }];
  const seen = new Set<string>();
  return asked.filter((p) => {
    if (seen.has(p.tree) || !deps.copyDef(p.tree)) return false;
    seen.add(p.tree);
    return true;
  });
}

const cut = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** One copy: up (each service ready), then its entry page. */
export async function readCopy(p: CopyPlan, deps: CopyDeps): Promise<CopyReading> {
  const base = { name: p.name, tree: p.tree };
  let r: CopyUp;
  try {
    r = await deps.copyUp(p.tree, p.services);
  } catch (err) {
    return { ...base, ok: false, detail: `Its running copy ${p.name} didn't start: ${cut(err instanceof Error ? err.message : String(err))}` };
  }
  const own = r.services.filter((s) => s.scope === "checkout").map((s) => s.name);
  const instance = { ...(r.instance ? { instance: r.instance } : {}), ...(own.length ? { services: own } : {}) };
  if (!r.ok) {
    const e = r.error;
    const failed = r.steps.find((s) => s.result === "failed");
    const step = e?.step ?? failed?.id;
    const where = e?.service ? `its service ${e.service}` : step ? `its step ${step}` : "it";
    return {
      ...base,
      ...instance,
      ok: false,
      detail: `Its running copy ${p.name} didn't start: ${where} failed (${cut(e?.message ?? failed?.detail ?? "no reason given")})`,
      ...(e?.service ? { service: e.service } : step ? { step } : {}),
    };
  }
  const def = deps.copyDef(p.tree);
  if (!def?.open) return { ...base, ...instance, ok: true, detail: `Its running copy ${p.name} runs here (its definition names no entry page)` };
  const dot = def.open.endpoint.indexOf(".");
  const svc = r.services.find((s) => s.name === def.open!.endpoint.slice(0, dot) && s.scope === "checkout");
  const port = svc?.ports[def.open.endpoint.slice(dot + 1)];
  if (!port) return { ...base, ...instance, ok: false, detail: `Its running copy ${p.name} runs, but its entry ${def.open.endpoint} has no port in it`, ...(svc ? { service: svc.name } : {}) };
  const entry = { endpoint: def.open.endpoint, port, path: def.open.path };
  const status = await deps.entryAnswers(port, def.open.path).catch(() => null);
  if (!entryOk(status))
    return { ...base, ...instance, entry, service: svc!.name, ok: false, detail: `Its running copy ${p.name} runs, but its entry page ${def.open.path} (port ${port}) ${status === null ? "didn't answer" : `answered ${status}`}` };
  return { ...base, ...instance, entry, ok: true, detail: `Its running copy ${p.name} runs here: its entry page ${def.open.path} answered ${status}` };
}

const chains = new Map<string, Promise<unknown>>();

/** `fn` once every earlier call for `key` has ended: one copy start at a time per transport. */
export function oneAtATime<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const before = chains.get(key) ?? Promise.resolve();
  const run = before.then(fn, fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  chains.set(key, tail);
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return run;
}

/** The copies as checks: each copy, running or why not. Pure. */
export const copyChecks = (readings: readonly CopyReading[]): AgentCheck[] => readings.map((r) => ({ id: `copy:${r.name}`, ok: r.ok, detail: r.detail }));

/** The copies before the rest here is set up: each waits (not Ready). Pure. */
export const copyWaiting = (plan: readonly CopyPlan[]): AgentCheck[] =>
  plan.map((p) => ({ id: `copy:${p.name}`, ok: false, detail: `Its running copy ${p.name} starts once the rest here is set up` }));

/** The card's view of these readings. Pure. */
export function copyViewOf(readings: readonly CopyReading[], at: number): CopyView {
  return {
    state: readings.every((r) => r.ok) ? "running" : "failed",
    copies: readings.map((r) => ({ name: r.name, ok: r.ok, detail: r.detail, ...(r.entry ? { entry: r.entry } : {}) })),
    at,
  };
}

/** What the agent's start_copy answers. Pure. */
export function copyStartText(readings: readonly CopyReading[]): string {
  const lines = readings.map((r) => `- ${r.name}: ${r.ok ? "running" : "not running"}. ${r.detail}${r.ok ? "" : r.step ? ` (read it with copy_logs, step ${r.step})` : r.service ? ` (read it with copy_logs, service ${r.service})` : ""}`);
  return readings.every((r) => r.ok)
    ? ["The running copy is up and its entry page answers:", ...lines, "", "Leave it running. End your turn: Sova reads it again then."].join("\n")
    : [
        "The running copy isn't running yet:",
        ...lines,
        "",
        "Find out why (copy_logs), fix what is inside your folders, ask on the card for the rest, then start it again with start_copy: it starts what failed, and what ran before your fix, fresh. Never run the project's servers, builds or watchers yourself.",
      ].join("\n");
}
