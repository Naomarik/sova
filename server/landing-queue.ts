import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SessionSummary } from "../shared/protocol";
import { CAPTAIN_PROFILE } from "./merge-board";
import { OfferRefusal, showOffer, type ShowInput } from "./session-offers";
import { stateRoot } from "./state-root";

/**
 * The merge captain's landing queue (§chat.merge-round/round, §chat.offers/sova-landing): the round's
 * driver (`round.mjs ask`) appends `{id, branch, path, head, owner, captain, at}` to
 * `<state root>/landing-queue.json` when the captain queues a branch that is Ready to land; Sova reads
 * it and shows the owner's session the project's Landing offer itself, from the captain's chat, for
 * that worktree at that head. No agent gets a tool or a permission for it: the captain only queues.
 * Each entry is answered once, in `<state root>/landing-shown.json` (`{id: {at, card?} | {at, refused}}`),
 * which the driver reads back.
 */

export const LANDING_OFFER = "landing";
/** Entries older than this are never shown (a queue the captain left behind). */
export const QUEUE_MAX_AGE_MS = 24 * 3600_000;
/** How often the server looks at the queue file (a stat; it is read only when it changed). */
export const QUEUE_POLL_MS = 3_000;

export interface QueueEntry {
  id: string;
  branch: string;
  /** The worktree's path. */
  path: string;
  /** The full head sha it was queued at. */
  head: string;
  /** The owner session's id. */
  owner: string;
  /** The captain session's id. */
  captain: string;
  /** ms epoch. */
  at: number;
}

export type QueueResult = { at: number; card: string } | { at: number; refused: string };

export const landingQueueFile = () => join(stateRoot(), "landing-queue.json");
export const landingShownFile = () => join(stateRoot(), "landing-shown.json");

const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** The queue file's entries, strictly (a bad entry is dropped). */
export function readQueue(file = landingQueueFile()): QueueEntry[] {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!isRec(raw) || raw.v !== 1 || !Array.isArray(raw.entries)) return [];
    return raw.entries.flatMap((e): QueueEntry[] =>
      isRec(e) && typeof e.id === "string" && typeof e.branch === "string" && typeof e.path === "string" && typeof e.head === "string" && SHA.test(e.head) && typeof e.owner === "string" && typeof e.captain === "string" && typeof e.at === "number"
        ? [{ id: e.id, branch: e.branch, path: e.path, head: e.head, owner: e.owner, captain: e.captain, at: e.at }]
        : [],
    );
  } catch {
    return [];
  }
}

export function readShown(file = landingShownFile()): Record<string, QueueResult> {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return isRec(raw) && raw.v === 1 && isRec(raw.results) ? (raw.results as Record<string, QueueResult>) : {};
  } catch {
    return {};
  }
}

function writeShown(file: string, results: Record<string, QueueResult>): void {
  mkdirSync(dirname(file), { recursive: true });
  const keep = Object.entries(results).sort((a, b) => b[1].at - a[1].at).slice(0, 500);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ v: 1, results: Object.fromEntries(keep) }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

export interface QueueDeps {
  pathOf(id: string): Promise<string | undefined>;
  summary(path: string): Promise<SessionSummary | null>;
  /** The worktree's current head sha, or undefined. */
  head(path: string): Promise<string | undefined>;
  show(input: ShowInput): Promise<{ id: string }>;
  now(): number;
  queueFile(): string;
  shownFile(): string;
}

const gitHead = (cwd: string): Promise<string | undefined> =>
  new Promise((done) => execFile("git", ["rev-parse", "HEAD"], { cwd, timeout: 5_000 }, (err, out) => done(err ? undefined : String(out).trim() || undefined)));

const defaults: QueueDeps = {
  async pathOf(id) {
    return (await import("./sessions-index")).indexedSessionPaths().get(id);
  },
  async summary(path) {
    return (await import("./sessions-index")).getSessionSummary(path);
  },
  head: gitHead,
  show: (input) => showOffer(input),
  now: Date.now,
  queueFile: landingQueueFile,
  shownFile: landingShownFile,
};

/** One entry: shown, or why not. */
async function answer(e: QueueEntry, d: QueueDeps): Promise<QueueResult> {
  const at = d.now();
  const refused = (why: string): QueueResult => ({ at, refused: why });
  if (at - e.at > QUEUE_MAX_AGE_MS) return refused("Queued more than a day ago: queue it again.");
  const captainPath = await d.pathOf(e.captain);
  const captain = captainPath ? await d.summary(captainPath) : null;
  if (!captain || captain.profile?.id !== CAPTAIN_PROFILE) return refused("Only a Merge Captain session's queue shows the Landing card.");
  const ownerPath = await d.pathOf(e.owner);
  if (!ownerPath) return refused(`No session ${e.owner}.`);
  const head = await d.head(e.path);
  if (head !== e.head) return refused(head ? `${e.branch} moved to ${head.slice(0, 7)} since it was queued at ${e.head.slice(0, 7)}.` : `Git can't read ${e.branch}'s worktree.`);
  try {
    const card = await d.show({ path: ownerPath, sessionId: e.owner, offer: LANDING_OFFER, by: "another-chat", from: captainPath!, tree: e.path });
    return { at, card: card.id };
  } catch (err) {
    if (err instanceof OfferRefusal) return refused(err.message);
    return refused(`Sova couldn't show it: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Answer every entry not answered yet. Returns how many it answered. */
export async function processLandingQueue(over: Partial<QueueDeps> = {}): Promise<number> {
  const d = { ...defaults, ...over };
  const entries = readQueue(d.queueFile());
  if (!entries.length) return 0;
  const shown = readShown(d.shownFile());
  let n = 0;
  for (const e of entries) {
    if (shown[e.id]) continue;
    shown[e.id] = await answer(e, d);
    n++;
  }
  if (n) writeShown(d.shownFile(), shown);
  return n;
}

let timer: ReturnType<typeof setInterval> | null = null;
let lastStamp = "";
let running = false;

/** index.ts: look at the queue every QUEUE_POLL_MS (a stat; read only when it changed). */
export function startLandingQueue(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (running) return;
    let stamp = "";
    try {
      const st = statSync(landingQueueFile());
      stamp = `${st.mtimeMs}:${st.size}`;
    } catch {
      return;
    }
    if (stamp === lastStamp) return;
    running = true;
    processLandingQueue()
      .then(() => {
        lastStamp = stamp;
      })
      .catch((err) => console.warn("[landing-queue]", err instanceof Error ? err.message : String(err)))
      .finally(() => {
        running = false;
      });
  }, QUEUE_POLL_MS);
  timer.unref?.();
}

export function stopLandingQueue(): void {
  if (timer) clearInterval(timer);
  timer = null;
  lastStamp = "";
}
