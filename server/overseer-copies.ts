import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { HEntry } from "../shared/harness";
import { choiceNames, clickChoices, matchCardClick, type ClickChoice, type CopyAct } from "../shared/overseer-card";
import type { CopyStarter, SessionSummary, SovaConfirmItem } from "../shared/protocol";
import { chatProcessAlive } from "./chat-runtime/supervisor";
import { serverRedactor } from "./overseer-redact";
import type { CopyApproval, ProjectEngine } from "./project-services/engine";
import { LEFTOVER_UNSUPPORTED, leftoverOn, realLeftoverHost, type LeftoverHost } from "./project-services/leftovers";
import { cardsOnBranch } from "./overseer-run-note";
import { linksOf } from "./project-services/share";
import { readRegistry, type InstanceRecord, type Registry } from "./project-services/store";

/**
 * Copies and leftover processes on the Overseers' cards (§app.overseer/copies): the rows a card lists, resolved
 * when it is raised, and what the click that opened a turn approved, per row and per verb. Only a click counts
 * (the exact-click test, shared/overseer-card.ts matchCardClick), and only a chosen label that names the verb
 * ("Tear Down…", "Reset…", "Stop…") approves it; Keep, Not Now, Cancel approve nothing.
 */

type CopyItem = Extract<SovaConfirmItem, { kind: "copy" }>;
type LeftoverItem = Extract<SovaConfirmItem, { kind: "leftover" }>;

export const MAIN_COPY_REFUSAL = "A project's main copy is never on a card.";

/** What resolving a copy row reads from the host (tests fake it). */
export interface CopyRowHost {
  registry(): Registry;
  /** A session by id, for the starter's title and whether it works now. */
  session(id: string): Promise<SessionSummary | null>;
  /** The project's name (its registered name, else its folder's). */
  projectName(root: string): string;
  /** `git status --porcelain` of a folder: its output, or null when it can't be read. */
  status(folder: string): Promise<string | null>;
  exists(path: string): boolean;
  links(instance: string): number;
}

const gitStatus = (folder: string): Promise<string | null> =>
  new Promise((done) => execFile("git", ["status", "--porcelain"], { cwd: folder, timeout: 5_000, encoding: "utf8" }, (err, stdout) => done(err ? null : String(stdout ?? ""))));

/** The host as it is, but for the session lookup and the project's name. */
export function realCopyRowHost(o: Pick<CopyRowHost, "session" | "projectName">): CopyRowHost {
  return { ...o, registry: () => readRegistry(), status: gitStatus, exists: (p) => existsSync(p), links: (id) => linksOf(id, { activeOnly: true }).length };
}

/** Who started a copy, from its record's `createdBy`. */
async function starterOf(createdBy: string, h: Pick<CopyRowHost, "session">): Promise<{ starter: CopyStarter; session: SessionSummary | null }> {
  if (createdBy === "operator") return { starter: { kind: "operator", label: "the operator" }, session: null };
  const [kind, ...rest] = createdBy.split(":");
  const id = rest.join(":");
  if (kind === "session" && id) {
    const s = await h.session(id).catch(() => null);
    return { starter: { kind: "session", id, title: s?.title ?? id }, session: s };
  }
  if (kind === "overseer") return { starter: { kind: "overseer", label: "the Overseer" }, session: null };
  if (kind === "project-overseer") return { starter: { kind: "overseer", label: "the project overseer" }, session: null };
  if (kind === "conform") return { starter: { kind: "conform", label: "conformance" }, session: null };
  return { starter: { kind: "other", label: createdBy }, session: null };
}

/** A copy's card row, or why it can't be one: no such instance (null), or the main copy. `root`: only this project's. */
export async function copyItem(ref: string, h: CopyRowHost, root?: string): Promise<CopyItem | { refused: string } | null> {
  const rec = h.registry().instances.find((i) => i.id === ref.trim());
  if (!rec) return null;
  if (rec.slot === 0) return { refused: `${rec.id}: ${MAIN_COPY_REFUSAL}` };
  if (root !== undefined && rec.project !== root) return { refused: `${rec.id} is a copy of another project (${rec.project}); a card here lists only this project's copies.` };
  const { starter, session } = await starterOf(rec.createdBy, h);
  const gone = !h.exists(rec.checkout);
  const status = gone ? null : await h.status(rec.checkout);
  const edits: CopyItem["edits"] = gone ? "folder-gone" : status?.trim() ? "uncommitted" : "clean";
  const running = Object.values(rec.desired).some((d) => d === "running");
  return {
    kind: "copy",
    id: rec.id,
    project: rec.project,
    projectName: h.projectName(rec.project),
    slot: rec.slot,
    branch: rec.branch,
    checkout: rec.checkout,
    state: gone ? "broken" : running ? "running" : "stopped",
    startedBy: starter,
    edits,
    links: h.links(rec.id),
    ...(session && (session.busy || session.activity?.state === "working") ? { working: true } : {}),
  };
}

/** A leftover process's card row: the process on `port` of `project` when Sova calls it safe to stop, else why not. */
export async function leftoverItem(project: string, port: number, h: LeftoverHost, projectName: (root: string) => string): Promise<LeftoverItem | { refused: string }> {
  const r = await leftoverOn(project, port, h);
  if ("error" in r) return { refused: r.error === LEFTOVER_UNSUPPORTED ? r.error : `port ${port} of ${project}: ${r.error}.` };
  if (!r.verdict.safe) return { refused: `port ${port} of ${project} is held by pid ${r.pid}, which is in use: ${r.verdict.why}. A card lists only a process safe to stop.` };
  return {
    kind: "leftover",
    id: `${r.port}:${r.pid}:${r.start}`,
    project,
    projectName: projectName(project),
    slot: r.slot,
    port: r.port,
    pid: r.pid,
    start: r.start,
    command: r.command,
    folder: r.folder,
    reason: r.verdict.reason,
    ...(r.unit ? { unit: r.unit } : {}),
  };
}

/**
 * What the click that opened this run chose, per row (§app.overseer/copies): the latest user message on the branch
 * is exactly a message a click on card `card` composes (the click's mark names it), and the card was open when it
 * arrived; each row it touched with the label it chose. Null otherwise: typed text, a Retry (no mark), a closed card.
 * `text` is the message's text as the people-facing gate reads it (joinedText, without images). Pure.
 */
export function confirmedClicks(card: string | null, branch: readonly HEntry[], text: (h: HEntry) => string): ClickChoice[] | null {
  if (!card) return null;
  let last = branch.length - 1;
  while (last >= 0 && branch[last]!.kind !== "user") last--;
  if (last < 0) return null;
  const c = cardsOnBranch(branch.slice(0, last)).find((x) => x.id === card);
  if (!c || c.phase !== "open") return null;
  const click = matchCardClick(c, text(branch[last]!).trim());
  return click ? clickChoices(c, click) : null;
}

/** Whether the click that opened the turn approved `act` on copy `rec`: a copy row of that instance whose chosen
    label names the act. Never slot 0. */
export function clickApproves(clicks: readonly ClickChoice[] | null, act: Exclude<CopyAct, "stop-leftover">, rec: Pick<InstanceRecord, "id" | "slot" | "project">, root?: string): boolean {
  if (!clicks || rec.slot === 0 || (root !== undefined && rec.project !== root)) return false;
  return clicks.some((c) => c.item.kind === "copy" && c.item.id === rec.id && choiceNames(c.choice, act));
}

/** The engine's approval hook over the turn's click (read per call, so it holds only in that turn). */
export const copyApproval = (clicks: () => readonly ClickChoice[] | null, root?: () => string): CopyApproval => (verb, rec) => clickApproves(clicks(), verb, rec, root?.());

/** The leftover row the click approved stopping on `port` of `project`, or null. */
export function approvedLeftover(clicks: readonly ClickChoice[] | null, project: string, port: number): LeftoverItem | null {
  for (const c of clicks ?? []) if (c.item.kind === "leftover" && c.item.project === project && c.item.port === port && choiceNames(c.choice, "stop-leftover")) return c.item as LeftoverItem;
  return null;
}

export const LEFTOVER_CLICK_REFUSAL =
  "Stopping a leftover process runs only in the turn the user's click on a card listing it opens: ask with sova_card, listing it under leftovers ({project, port}) with a Stop choice.";

/** A project's name for its rows: the registered one, else its folder's. */
export const nameOr = (names: () => { root: string; name: string }[]) => (root: string) => names().find((p) => p.root === root)?.name ?? (basename(root) || root);

/** The leftover finder's host as it is: a copy's own process is one inside a unit of a registered copy or shared
    service (the engine's driver), a chat process is told by its command line. */
export function liveLeftoverHost(engine: ProjectEngine): LeftoverHost {
  const units = (): string[] => {
    const r = readRegistry();
    return [
      ...r.instances.flatMap((i) => Object.keys({ ...i.desired, ...i.ports }).map((svc) => engine.unitOf(i.id, svc))),
      ...r.shared.flatMap((sh) => Object.keys({ ...sh.desired, ...sh.ports }).map((svc) => engine.unitOf(sh.id, svc))),
    ];
  };
  return realLeftoverHost({
    ownedByCopy: (pid) => units().some((u) => engine.driver.owns(u, pid)),
    isChatProcess: (pid) => chatProcessAlive(pid),
    redact: (t) => serverRedactor().redact(t),
    stopUnit: (unit) =>
      new Promise((done) =>
        execFile("systemctl", ["--user", "stop", unit], { timeout: 60_000, encoding: "utf8" }, (err, _out, stderr) =>
          done({ code: err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0, stderr: String(stderr ?? "") }),
        ),
      ),
  });
}
