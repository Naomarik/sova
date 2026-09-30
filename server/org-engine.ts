import type { Hold, Refusal, StampContext } from "./statecharts";
import { OrgHost, type ActResult, type HostChange } from "./org-host";
import { OrgError } from "./org-error";
import type { ActBy, Envelope } from "./org-envelope";
import { projectOfSession, stampEnvelope, type StampWho } from "./org-stamp";
import type { ProjectOverseerSettings } from "../shared/project-overseer";

/**
 * The org engines of this host (design §2 "one org, one queue"): one OrgHost (server/org-host/, the
 * engine member's) per attached org, opened at startup and at create/attach, closed at detach. Every
 * org and project route reads from and acts through it; nothing here keeps state of its own.
 *
 * The server's handlers for effects and invocations (session files, links, git, promotion, looks,
 * replies, wrap-ups, reconcile runs) are registered on every host as it opens, by the modules that
 * own them (`onOrgHostOpened`), so this module imports none of them.
 */

export type { Refusal } from "./statecharts";
export type { ActResult, Effect, EffectOutcome, HostChange, HostProblem, Invocation, InvocationReport, SessionInfo } from "./org-host";

/** The OrgHost as the server calls it (server/org-host/, the engine member's): the host itself, so
    tests may hand in a fake with the same shape. */
export type OrgHostApi = Pick<
  OrgHost,
  "paths" | "feed" | "effects" | "invocations" | "log" | "act" | "actNow" | "settle" | "start" | "setState" | "trial" | "explain" | "enabledEvents" | "configuration" | "data" | "sessions" | "holds" | "nextDueAt" | "fireDue" | "statechartOf" | "statechartInfo" | "problems" | "logAct" | "onChange" | "reload" | "close" | "rewindowHours"
>;

/** Where a project's settings (overseer.json, as read now) come from: server/project-overseer-store.ts
    registers it as it loads. Injected, so this module imports nothing that imports server/orgs.ts
    (orgs registers its change listener here as it loads). */
type SettingsPart = Pick<ProjectOverseerSettings, "autonomy" | "caps" | "holdMin" | "confirmKinds">;
let settingsSource: { read(orgId: string, projectId: string, workspaceDir?: string): SettingsPart; defaults(): SettingsPart } | null = null;
export function setProjectSettingsSource(source: NonNullable<typeof settingsSource>): void {
  settingsSource = source;
}
function settingsOf(): NonNullable<typeof settingsSource> {
  if (!settingsSource) throw new Error("The project settings reader is not loaded (server/project-overseer-store.ts).");
  return settingsSource;
}

/** r13: the people an engine-delivered act reaches, as records with their current effective hours (server/orgs.ts
    registers it as it loads): the stamp carries them, so a held act released later is checked against the hours in
    force then. */
let stampPeopleSource: ((orgId: string, payload: Record<string, unknown>) => Record<string, unknown>) | null = null;
export function setStampPeopleSource(fn: NonNullable<typeof stampPeopleSource>): void {
  stampPeopleSource = fn;
}

export interface OpenOptions {
  orgId: string;
  workspaceDir: string;
  stateDir: string;
}

/** The host's `stamp` option (engine API): a fresh envelope for an act the engine delivers itself
    (a statechart's drive, a held act at its release). `who` is the act's original actor (default "statechart")
    and project: an act on a person or the org (a held roster approve) is still its project's act, so
    its level, pause, archive, ledgers and hold come from that project, never from defaults. */
export type Stamp = (sid: string, event: string, payload: Record<string, unknown>, who?: StampContext) => Envelope;

/** The project an engine-delivered act belongs to: the original envelope's, else the payload's,
    else the target session's own. */
export function stampProject(host: Pick<OrgHostApi, "data">, sid: string, payload: Record<string, unknown>, who?: { projectId?: string }): string | null {
  if (typeof who?.projectId === "string" && who.projectId) return who.projectId;
  if (typeof payload.projectId === "string" && payload.projectId) return payload.projectId;
  return projectOfSession(host, sid);
}

type Opener = (opts: OpenOptions & { stamp: Stamp; clock: () => number }) => Promise<OrgHostApi>;

let opener: Opener = (opts) => OrgHost.open(opts);

/** How a host is opened: OrgHost.open, unless a test sets a fake. */
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

let testClock: (() => number) | null = null;
/** Tests move every org host's clock with the project overseer's (server/project-overseer.ts setClockForTest). */
export function setOrgClockForTest(fn: (() => number) | null): void {
  testClock = fn;
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
      const settings = settingsOf();
      const env = stampEnvelope(self, opts.orgId, pid, { by: (who?.by as ActBy | undefined) ?? "statechart", ...(who?.overseerId ? { overseerId: who.overseerId } : {}), attended: false }, (projectId) => settings.read(opts.orgId, projectId, opts.workspaceDir), settings.defaults());
      return { ...env, ...(stampPeopleSource?.(opts.orgId, payload) ?? {}) } as Envelope;
    };
    const host = await opener({ ...opts, stamp, clock: () => (testClock ? testClock() : Date.now()) });
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

/** A statechart refusal as the route answers it: its status (409 when the statechart names none) and sentence; `code` passes through. */
export function refusalError(r: Refusal): OrgError {
  const status = (STATUSES.has(r.status ?? 0) ? r.status : 409) as 400 | 404 | 409 | 410;
  return new OrgError(r.sentence, status, r.code ?? undefined, r.tail ?? undefined);
}

/** The envelope for an act of `who` on the org's project (null: an org-level act), from the statecharts as they stand now. */
export function envelopeFor(orgId: string, projectId: string | null, who: StampWho): Envelope {
  const host = hostOf(orgId);
  const settings = settingsOf();
  return stampEnvelope(host, orgId, projectId, who, (pid) => settings.read(orgId, pid), settings.defaults());
}

/** A hold's id as the server names it (F19): the statechart's hold id is unique only within its session
    ("gather/start#0"), so every id the operator, the UI or an overseer sees is `${sessionId}:${holdId}`. */
export const holdRef = (h: { sessionId: string; id: string }): string => `${h.sessionId}:${h.id}`;

/** An act's hold as its caller reports it: `{ id: holdRef, until }`. `sid` is the session the act was sent to (the
    hold's own; the act result's `held` does not carry it). */
export const heldAt = (sid: string, held: { id: string; until: number }): { id: string; until: number } => ({ id: holdRef({ sessionId: sid, id: held.id }), until: held.until });

/** The org's hold a `holdRef` names (a hold id never contains ':', so it splits at the last one); none: undefined. */
export function holdByRef(orgId: string, ref: string): Hold | undefined {
  const at = ref.lastIndexOf(":");
  if (at <= 0) return undefined;
  const sid = ref.slice(0, at);
  const id = ref.slice(at + 1);
  return hostOf(orgId).holds().find((h) => h.sessionId === sid && h.id === id);
}

/** Send an act; a refusal throws as the route answers it. Returns the host's result. */
export async function actOrThrow(orgId: string, sid: string, event: string, payload: Record<string, unknown>, envelope: Envelope | Record<string, unknown>, opts: { settle?: boolean } = {}): Promise<ActResult> {
  const out = await hostOf(orgId).act(sid, event, payload, envelope, opts);
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
