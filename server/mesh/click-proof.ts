import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { notPage } from "../page-only";
import { judgedPath } from "./paths";
import { CLICK_PROOF_HEADER, PROXIED_HEADER } from "./proxy";

/**
 * A click on this page that approves something on another of your computers (§app.access/your-click: a schedule,
 * Apply, and the merge queue's acts: Land, answers, Remove from Queue and the other merge verbs only the page takes,
 * the Overseer's Merge Branch, Merge Branch on a proposed run). The other computer can't see this page, and being a peer proves nothing: any program on this machine
 * reaches its peer listener under this machine's identity. So the page's request is judged HERE, by the same test as
 * a local click, as it passes this host's proxy. Only then does this host mint a random one-time id, kept in memory,
 * bound to that peer and to the exact request body. The other computer asks this host about the id over the peer
 * link, under the identity the request came with, and it is burnt by the asking. So a chat on this machine must get
 * past the local test to have one, the same bar as a local click; a header it invents names nothing here; another
 * peer can't spend it; and it can't be replayed or moved to another schedule or pin. No keys, no clocks between hosts.
 */

const PROVEN_DOORS = [
  /^\/api\/schedules\/approve$/,
  /^\/api\/project-services\/apply$/,
  /^\/api\/projects\/[^/]+\/services\/apply$/,
  // The merge queue's other acts a page click may take (§app.access/your-click): the Overseer's Merge Branch on a coding
  // worktree and Merge Branch on a proposed run (a Setup proposal's route still takes this machine's page only).
  /^\/api\/projects\/[^/]+\/overseer\/worktrees\/merge$/,
  /^\/api\/projects\/[^/]+\/runtime\/merge$/,
];
/** A merge verb's door: proven only for the verbs only the user's page takes (Land, answers, Remove, …), never a read. */
const MERGE_VERB_DOOR = /^\/api\/(?:project-services|projects\/[^/]+\/services)\/(merge\.[a-z.-]+)$/;

async function provenDoor(path: string): Promise<boolean> {
  if (PROVEN_DOORS.some((d) => d.test(path))) return true;
  const verb = MERGE_VERB_DOOR.exec(path)?.[1];
  if (!verb) return false;
  // Imported here: the merge queue's routes reach the engine.
  return (await import("../merge-queue/routes")).pageOnlyMergeVerb(verb);
}
const TTL_MS = 60_000;

interface Minted {
  peer: string;
  digest: string;
  until: number;
}
const minted = new Map<string, Minted>();

const digestOf = (body: string): string => createHash("sha256").update(body).digest("hex");

function forget(now: number): void {
  for (const [id, m] of minted) if (m.until <= now) minted.delete(id);
}

/** A proof for this relayed request: only for a door that takes one, and only from this host's own page. */
export async function clickProofFor(c: Context, peerId: string, tail: string, now = Date.now()): Promise<string | undefined> {
  if (c.req.method !== "POST" || notPage(c) !== null || !(await provenDoor(judgedPath(tail) ?? ""))) return undefined;
  forget(now);
  const id = randomBytes(32).toString("base64url");
  minted.set(id, { peer: peerId, digest: digestOf(await c.req.raw.clone().text()), until: now + TTL_MS });
  return id;
}

/** The peer's question: true once, for the peer it was minted for and the body it was minted over. Any asking burns it. */
export function takeClick(proof: unknown, peerId: string, digest: unknown, now = Date.now()): boolean {
  if (typeof proof !== "string" || typeof digest !== "string") return false;
  const m = minted.get(proof);
  if (!m) return false;
  minted.delete(proof);
  const a = Buffer.from(m.digest);
  const b = Buffer.from(digest);
  return m.until > now && m.peer === peerId && a.length === b.length && timingSafeEqual(a, b);
}

type PeerFetch = (peerId: string, path: string, init?: RequestInit) => Promise<Response>;

/** On the computer the schedule is on: whether this request is a click its sender's own page made. Any doubt is no. */
export async function peerClickProven(c: Context, body: string, peerFetch: PeerFetch): Promise<boolean> {
  const peer = (c.env as { meshPeer?: { id?: string } } | undefined)?.meshPeer?.id;
  const proof = c.req.header(CLICK_PROOF_HEADER);
  if (!peer || !proof || !c.req.header(PROXIED_HEADER)) return false;
  try {
    const res = await peerFetch(peer, "/api/peer/click-proof", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ proof, digest: digestOf(body) }),
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok && ((await res.json()) as { ok?: unknown }).ok === true;
  } catch {
    return false;
  }
}

let askForTest: PeerFetch | null = null;
/** Tests: stand in for the peer link; null restores it. */
export function setClickAskForTest(ask: PeerFetch | null): void {
  askForTest = ask;
}

/** Whether this request is neither the page here nor a proven click from another of your computers' page. */
export async function notPageNorProven(c: Context, body: string): Promise<boolean> {
  if (notPage(c) === null) return false;
  // Imported here: the mesh's own routes reach the engine.
  return !(await peerClickProven(c, body, askForTest ?? (await import("./index")).peerFetch));
}
