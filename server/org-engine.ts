import { OrgError } from "./orgs";
import type { ActBy, Envelope } from "./org-envelope";
import { projectOfSession, stampEnvelope } from "./org-stamp";
import { defaultPoSettings, projectOverseerPaths, readPoSettings } from "./project-overseer-store";

/**
 * The org engines of this host (design §2 "one org, one queue"): one OrgHost (server/org-host/, the
 * engine member's) per attached org, opened at startup and at create/attach, closed at detach. Every
 * org and project route reads from and acts through it; nothing here keeps state of its own.
 *
 * The server's handlers for effects and invocations (session files, links, git, promotion, looks,
 * replies, wrap-ups, reconcile runs) are registered on every host as it opens, by the modules that
 * own them (`onOrgHostOpened`), so this module imports none of them.
 */

/** A chart refusal as the host answers it (engine API §3). */
export interface Refusal {
  sentence: string;
  tail?: string | null;
  stage?: string;
  check?: string | null;
  status?: number | null;
  code?: string | null;
}

export interface ActResult {
  taken: boolean;
  refusal: Refusal | null;
  result: unknown;
}

export interface SessionInfo {
  id: string;
  chart: string;
  configuration: string[];
  data: Record<string, unknown>;
  running?: boolean;
}

export interface EnabledEvent {
  event: string;
  enabled: boolean;
  refusal?: Refusal;
}

export interface Effect {
  kind: string;
  key: string;
  sessionId: string;
  [field: string]: unknown;
}

export interface Invocation {
  sessionId: string;
  invokeId: string;
  type: string;
  params?: Record<string, unknown>;
}

export type InvocationReport = (outcome: "finished" | "stopped" | "not-started", detail?: string) => void;

export interface HostChange {
  sessions: string[];
  steps: unknown[];
}

/** An act's metadata as its chart declares it (`:acts`): the level it needs, whether it counts against an allowance, … */
export interface ActMeta {
  needs?: string | null;
  tool?: string;
  counts?: string;
  hold?: boolean;
  correction?: boolean;
  peopleFacing?: boolean;
  codeFacing?: boolean;
  [key: string]: unknown;
}

export interface ChartInfo {
  name: string;
  version: number;
  acts: Record<string, ActMeta>;
  [key: string]: unknown;
}

/** The OrgHost as the server calls it (engine API §4). */
export interface OrgHostApi {
  effects: { register(kind: string, fn: (effect: Effect) => Promise<unknown>): void };
  invocations: { register(type: string, runner: { start(inv: Invocation, report: InvocationReport): void; stop(inv: Invocation): void }): void };
  act(sid: string, event: string, payload: Record<string, unknown>, envelope: Envelope | Record<string, unknown>): Promise<ActResult>;
  start(sid: string, chart: string, data: Record<string, unknown>, envelope: Envelope | Record<string, unknown>): Promise<unknown>;
  setState(sid: string, change: { states: string[]; patch?: Record<string, unknown>; reason: string }, envelope: Envelope | Record<string, unknown>): Promise<ActResult>;
  trial(sid: string, event: string, payload: Record<string, unknown>, envelope: Envelope | Record<string, unknown>): ActResult;
  enabledEvents(sid: string, envelope: Envelope | Record<string, unknown>): EnabledEvent[];
  configuration(sid: string): string[] | null;
  data(sid: string): Record<string, unknown> | null;
  sessions(chart?: string): SessionInfo[];
  holds(): unknown[];
  chartOf(sid: string): string | null;
  /** The registry's entry for a chart (engine API §3 chartInfo): its acts with their metadata. */
  chartInfo(name: string): ChartInfo | null;
  problems(): { file: string; why: string }[];
  logAct(row: Record<string, unknown>): Promise<void>;
  onChange(fn: (change: HostChange) => void): void;
  close(): Promise<void>;
}

export interface OpenOptions {
  orgId: string;
  workspaceDir: string;
  stateDir: string;
}

/** The host's `stamp` option (engine API): a fresh envelope for an act the engine delivers itself
    (a chart's drive, a held act at its release). `who` is the act's original actor (default "chart")
    and project: an act on a person or the org (a held roster approve) is still its project's act, so
    its level, pause, archive, ledgers and hold come from that project, never from defaults. */
export type Stamp = (sid: string, event: string, payload: Record<string, unknown>, who?: { by?: ActBy; overseerId?: string; projectId?: string }) => Envelope;

/** The project an engine-delivered act belongs to: the original envelope's, else the payload's,
    else the target session's own. */
export function stampProject(host: Pick<OrgHostApi, "data">, sid: string, payload: Record<string, unknown>, who?: { projectId?: string }): string | null {
  if (typeof who?.projectId === "string" && who.projectId) return who.projectId;
  if (typeof payload.projectId === "string" && payload.projectId) return payload.projectId;
  return projectOfSession(host, sid);
}

type Opener = (opts: OpenOptions & { stamp: Stamp }) => Promise<OrgHostApi>;

let opener: Opener = async () => {
  throw new Error("The org engine is not available on this server.");
};

/** How a host is opened: server/index.ts sets the real OrgHost.open; tests set a fake. */
export function setOrgHostOpener(fn: Opener): void {
  opener = fn;
}

const hosts = new Map<string, OrgHostApi>();
const opening = new Map<string, Promise<OrgHostApi>>();
const openedHooks: ((host: OrgHostApi, orgId: string) => void)[] = [];
const changeHooks: ((orgId: string, change: HostChange) => void)[] = [];

/** Register effect and invocation handlers (and anything else per host) on every host as it opens. */
export function onOrgHostOpened(fn: (host: OrgHostApi, orgId: string) => void): void {
  openedHooks.push(fn);
  for (const [orgId, host] of hosts) fn(host, orgId);
}

/** After every committed batch of any org (Needs you, the session list, share pages re-read). */
export function onOrgChange(fn: (orgId: string, change: HostChange) => void): void {
  changeHooks.push(fn);
}

/** Open the org's engine (once; a second call waits for the first). */
export async function openOrgHost(opts: OpenOptions): Promise<OrgHostApi> {
  const have = hosts.get(opts.orgId);
  if (have) return have;
  const pending = opening.get(opts.orgId);
  if (pending) return pending;
  const p = (async () => {
    let self: OrgHostApi | null = null;
    const stamp: Stamp = (sid, _event, payload, who) => {
      if (!self) throw new Error("The org engine stamped before it opened.");
      const pid = stampProject(self, sid, payload, who);
      return stampEnvelope(self, opts.orgId, pid, { by: who?.by ?? "chart", ...(who?.overseerId ? { overseerId: who.overseerId } : {}), attended: false }, (projectId) => readPoSettings(projectOverseerPaths(opts.orgId, projectId, opts.workspaceDir)), defaultPoSettings());
    };
    const host = await opener({ ...opts, stamp });
    self = host;
    for (const fn of openedHooks) fn(host, opts.orgId);
    host.onChange((change) => {
      for (const fn of changeHooks)
        try {
          fn(opts.orgId, change);
        } catch (err) {
          console.warn(`[org-engine] change listener: ${err instanceof Error ? err.message : String(err)}`);
        }
    });
    hosts.set(opts.orgId, host);
    return host;
  })();
  opening.set(opts.orgId, p);
  try {
    return await p;
  } finally {
    opening.delete(opts.orgId);
  }
}

/** Close the org's engine (detach, shutdown). Nothing to close is fine. */
export async function closeOrgHost(orgId: string): Promise<void> {
  const host = hosts.get(orgId) ?? (await opening.get(orgId)?.catch(() => undefined));
  hosts.delete(orgId);
  await host?.close();
}

/** Every open host (shutdown). */
export async function closeAllOrgHosts(): Promise<void> {
  await Promise.all([...hosts.keys()].map((id) => closeOrgHost(id)));
}

/** The open engine of an attached org; 409 when it did not open (a broken journal: its page says why). */
export function hostOf(orgId: string): OrgHostApi {
  const host = hosts.get(orgId);
  if (!host) throw new OrgError("This organization's engine is not open on this host.", 409);
  return host;
}

export const isOrgHostOpen = (orgId: string): boolean => hosts.has(orgId);

const STATUSES = new Set([400, 404, 409, 410]);

/** A chart refusal as the route answers it: its status (409 when the chart names none) and sentence; `code` passes through. */
export function refusalError(r: Refusal): OrgError {
  const status = (STATUSES.has(r.status ?? 0) ? r.status : 409) as 400 | 404 | 409 | 410;
  return new OrgError(r.sentence, status, r.code ?? undefined);
}

/** Send an act; a refusal throws as the route answers it. Returns the host's result. */
export async function actOrThrow(orgId: string, sid: string, event: string, payload: Record<string, unknown>, envelope: Envelope | Record<string, unknown>): Promise<ActResult> {
  const out = await hostOf(orgId).act(sid, event, payload, envelope);
  if (!out.taken) throw refusalError(out.refusal ?? { sentence: "That can't be done now." });
  return out;
}

/** Tests: forget every host without closing it. */
export function resetOrgHostsForTest(): void {
  hosts.clear();
  opening.clear();
  openedHooks.length = 0;
  changeHooks.length = 0;
}
