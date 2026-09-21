import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { GROUP_NAME_MAX, type BatchRefusal, type BatchRefusalCode, type FanoutRequest, type FanoutResult, type GroupSeed, type SessionGroup, type SessionSummary } from "../shared/protocol";
import { activeConfigFailure, heldChat } from "./chat-manager";
import { readLive } from "./live";
import { listModels } from "./models";
import { canonicalPath, resolveSessionPath, sessionPathShape } from "./paths";
import { adoptGroupSeed, assignSession, cleanGroupName, createGroup, deleteGroup, readGroup } from "./session-groups";
import { getSessionSummary } from "./sessions-index";
import { addWebSession } from "./web-sessions";
import { markOwned, recentForeignWriteAgeSec } from "./write-guard";
import { promptGroup } from "./group-prompt";
import { normalizeEntry, readActiveBranch } from "./transcript";

/**
 * POST /api/session-groups/fanout (spec/14b-fanout.md): N sessions from one starting point, as
 * one group. Fork mode branches every member from the same entry of one source; fresh mode makes
 * N independent sessions in a folder. Nothing here is a fan-out of one runtime — see forkMember.
 */

/** The current session file format. A source in an older one is refused rather than migrated. */
const CURRENT_SESSION_VERSION = 3;
/** Enough for the header line. The leaf needs the whole file (see renderedActiveLeaf). */
const HEAD_BYTES = 16 * 1024;

const refusal = (path: string, code: BatchRefusalCode, message: string, id = "", ref?: string): BatchRefusal => ({ id, path, code, message, ...(ref ? { ref } : {}) });

export type FanoutOutcome =
  | { ok: true; result: FanoutResult }
  | { ok: false; status: 400 | 404 | 500; error: string; code?: "seed-conflict" }
  | { ok: false; status: 409; refused: BatchRefusal[] };

/** One member to make: a model ref, once. `count` in the request is expanded into repeats here,
    so the rest of the code never has to think about counts. */
export interface PlannedMember {
  ref: string;
  provider: string;
  modelId: string;
  /** "sonnet ×2" style label: the ref, plus its ordinal when the same ref repeats. */
  label: string;
}

/**
 * Everything that touches the SDK, the disk or the store, injected so the rules can be tested
 * without any of them.
 *
 * EACH COMMENT BELOW IS A SPECIFICATION, not a description: it is what a fake gets written
 * against. A wrong one is self-certifying — this interface's `sourceHead` once promised "the id
 * of the file's last entry", and any fake honouring that would have reinstated the rewound-source
 * bug with the whole suite green. Where the real behaviour is the SDK's or the disk's, prefer a
 * test that drives the real thing (server/fanout-branch.test.ts) over one more fake that can only
 * agree with us.
 */
export interface FanoutDeps {
  /** Refs the server knows, for validating `members[].ref`. */
  knownRefs(): Promise<Set<string>>;
  /** The source path as this server keys sessions, or null when it is not a session file here.
      Shape check first (no syscall), then the FULL resolve, because fanout OPENS this file —
      sessionPathShape contains by string only (server/paths.ts). */
  resolveSource(raw: string): string | null;
  /** The header's version, and the source's LEAF — the last entry its transcript RENDERS on the
      ACTIVE branch, which is what the dialog showed and so the only thing `source.leafId` can be
      compared against. NOT the file's last entry: after a rewind the file's tail is the abandoned
      branch (see renderedActiveLeaf). null when the file is unreadable. */
  sourceHead(path: string): Promise<{ version: number; leafId: string | null } | null>;
  live(path: string): boolean;
  streaming(path: string): boolean;
  foreignWriter(path: string): boolean;
  misconfigured(path: string): boolean;
  /** Branch one member off the source at `leafId`, on a manager of its own. */
  fork(sourcePath: string, leafId: string, member: PlannedMember): Promise<string>;
  /** A brand new session in `cwd` for one member. */
  fresh(cwd: string, member: PlannedMember): Promise<string>;
  /** Remove a member's own half-written file after its creation failed. */
  discard(path: string): void;
  summary(path: string): Promise<SessionSummary | null>;
  /** Create the group for this fanout. `autoDissolve` is set here and ONLY here: pi-web chose
      the name, so pi-web may remove it once emptied. The groupId path never passes it. */
  createGroup(name: string, seed?: GroupSeed, autoDissolve?: boolean): SessionGroup | null;
  /** One existing group by id, or null — for landing members in it rather than making one. */
  group(id: string): SessionGroup | null;
  /** Give a seedless group this fanout's seed. Only called after the caller has established the
      group has none; a DIFFERING seed is refused, never overwritten. */
  adoptSeed(id: string, seed: GroupSeed): SessionGroup | null;
  deleteGroup(id: string): void;
  assign(sessionId: string, groupId: string, label: string): void;
  /** The stage-2 batch path, for fresh mode's first message. */
  prompt(groupId: string, text: string): Promise<void>;
}

/** Read the header and the last entry's id without loading the whole file. */
async function readHeadAndLeaf(path: string): Promise<{ version: number; leafId: string | null } | null> {
  let fh;
  try {
    fh = await open(path, "r");
  } catch {
    return null;
  }
  try {
    const { size } = await fh.stat();
    const head = Buffer.alloc(Math.min(HEAD_BYTES, size));
    await fh.read(head, 0, head.length, 0);
    const firstLine = head.toString("utf8").split("\n", 1)[0] ?? "";
    let header: { type?: string; version?: unknown };
    try {
      header = JSON.parse(firstLine);
    } catch {
      return null;
    }
    if (header?.type !== "session") return null;
    const version = typeof header.version === "number" ? header.version : 1; // pre-versioning files
    // The version comes from the bounded head read above; the leaf needs the active branch.
    return { version, leafId: await renderedActiveLeaf(path) };
  } finally {
    await fh.close();
  }
}

/**
 * The id of the last entry pi-web would RENDER ON THE ACTIVE BRANCH — which is what the dialog
 * showed, and therefore the only thing `source.leafId` can honestly be compared against.
 *
 * TWO ways the file's last line is the wrong answer, and both are ordinary:
 * 1. HIDDEN ENTRIES. The transcript draws nothing for a top-level `usage` row (cache warming is
 *    on by default), a `role:"system"` loadout message, or pi-web's own `pi-web-rewind` marker.
 * 2. THE ABANDONED BRANCH. After a rewind, the file's TAIL is the branch that was left behind —
 *    ordinary, visible messages — while the active branch hangs off the rewind marker. Walking
 *    back from end-of-file returns the abandoned leaf, so every rewound source would be refused
 *    as stale. Rewound sessions are the ones most likely to be forked, too: the user has just
 *    navigated to the point they want to branch from.
 *
 * So: the ACTIVE branch (transcript.ts's own parentId walk, the same one the pane renders), then
 * its last entry that normalizeEntry yields a row for. Both rules are the transcript's, reused —
 * a second copy of "what pi-web shows" is precisely what drifted here the first time.
 *
 * This reads the whole file. Fanout is a rare, deliberate user action and the transcript path
 * does the same read to draw the pane; correctness first.
 */
async function renderedActiveLeaf(path: string): Promise<string | null> {
  const branch = await readActiveBranch(path);
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i]!;
    if (typeof entry.id !== "string") continue;
    if (normalizeEntry(entry).length === 0) continue; // hidden: not a leaf the user saw
    return entry.id;
  }
  return null;
}

export const realFanoutDeps: FanoutDeps = {
  async knownRefs() {
    return new Set((await listModels()).map((m) => m.ref));
  },
  resolveSource(raw) {
    if (!sessionPathShape(raw)) return null;
    const path = resolveSessionPath(raw);
    return path && existsSync(path) ? path : null;
  },
  sourceHead: readHeadAndLeaf,
  live: (path) => readLive().get(path) !== undefined,
  streaming: (path) => {
    const chat = heldChat(path);
    return !!chat && chat.session.isStreaming;
  },
  foreignWriter: (path) => {
    const chat = heldChat(path);
    return chat ? chat.hasForeignWrites() : recentForeignWriteAgeSec(path) !== null;
  },
  misconfigured: (path) => activeConfigFailure(path) !== undefined,

  /**
   * ONE FRESH MANAGER, and never the one pi-web holds for the source. createBranchedSession
   * REBINDS the manager it is called on to the new file (session-manager.js: it sets fileEntries,
   * sessionId and sessionFile), so calling it twice on one manager chains member 2 off member 1
   * instead of fanning, and calling it on the held runtime's manager would repoint a LIVE runtime
   * at a member's file — the user's next turn would land in a member's transcript.
   *
   * Two non-obvious reasons this is safe to do while pi-web HOLDS an idle runtime for the source,
   * both worth stating because a plausible refactor breaks them:
   *
   * 1. open()'s only write to a healthy current-version file is appending "\n" to a trailing
   *    partial line. That GROWS the file, so ForeignWriteGuard.check() takes its read-the-new-bytes
   *    path, finds one blank line, advances its offset and returns null — no false foreign write.
   *    A version MIGRATION is the opposite: `_rewriteFile()` trips the guard on every branch it has
   *    (shrink, same-size-new-mtime, or grown bytes that parse as unknown ids), which would mark OUR
   *    OWN write foreign and refuse the user's prompts until a &force=1 reconnect. That is why the
   *    old-format check is a PRECONDITION read with our own parser, never a recovery after open().
   * 2. A BARE SessionManager is used deliberately, not createAgentSession: the SDK appends
   *    model_change/thinking_level_change at runtime construction (the appends openSession has to
   *    defer), and those would land in the source before the branch is taken. Refactoring this to
   *    createAgentSession would reintroduce exactly that, silently.
   */
  async fork(sourcePath, leafId, member) {
    const sm = SessionManager.open(sourcePath);
    const created = sm.createBranchedSession(leafId);
    if (!created) throw new Error("Branching produced no session file");
    // The manager IS the member now, so this pins the member's model, not the source's.
    sm.appendModelChange(member.provider, member.modelId);
    // The SDK only writes the branch immediately when it contains an assistant message; otherwise
    // it waits for one. Write it by hand, wx, so the member exists on disk like every web session.
    if (!existsSync(created)) {
      const header = sm.getHeader();
      const lines = [JSON.stringify(header), ...sm.getEntries().map((e) => JSON.stringify(e))];
      writeFileSync(created, `${lines.join("\n")}\n`, { flag: "wx" });
    }
    return finishMember(created);
  },

  async fresh(cwd, member) {
    const sm = SessionManager.create(cwd);
    const created = sm.getSessionFile();
    const header = sm.getHeader();
    if (!created || !header) throw new Error("SessionManager did not produce a session file");
    writeFileSync(created, `${JSON.stringify(header)}\n`, { flag: "wx" });
    sm.appendModelChange(member.provider, member.modelId);
    return finishMember(created);
  },

  discard(path) {
    try {
      unlinkSync(path);
    } catch {
      // already gone, or never written: nothing to clean up
    }
  },
  summary: (path) => getSessionSummary(path),
  createGroup(name, seed, autoDissolve) {
    const r = createGroup(name, seed, autoDissolve);
    return r.ok ? r.group : null;
  },
  group: (id) => readGroup(id),
  adoptSeed: (id, seed) => adoptGroupSeed(id, seed),
  deleteGroup: (id) => void deleteGroup(id),
  assign: (sessionId, groupId, label) => void assignSession(sessionId, groupId, label),
  async prompt(groupId, text) {
    await promptGroup(groupId, text, undefined);
  },
};

/** The bookkeeping every new member needs: our own write, and a web-owned session. */
function finishMember(rawPath: string): string {
  const path = canonicalPath(rawPath);
  markOwned(path); // the fresh mtime is ours, not a foreign writer's
  const id = idFromPath(path);
  if (id) addWebSession(id);
  return path;
}

const idFromPath = (path: string): string => path.replace(/\.jsonl$/, "").split("_").pop() ?? "";

/** Expand `{ref, count}[]` into one entry per member, labelled, in pane order. */
export function planMembers(members: { ref: string; count: number }[]): PlannedMember[] {
  const total = new Map<string, number>();
  for (const m of members) total.set(m.ref, (total.get(m.ref) ?? 0) + m.count);
  const seen = new Map<string, number>();
  const planned: PlannedMember[] = [];
  for (const m of members) {
    for (let i = 0; i < m.count; i++) {
      const n = (seen.get(m.ref) ?? 0) + 1;
      seen.set(m.ref, n);
      const slash = m.ref.indexOf("/");
      planned.push({
        ref: m.ref,
        provider: m.ref.slice(0, slash),
        modelId: m.ref.slice(slash + 1),
        // "opus" alone when it is the only one; "opus #2" when the same ref repeats.
        label: (total.get(m.ref) ?? 1) > 1 ? `${m.ref} #${n}` : m.ref,
      });
    }
  }
  return planned;
}

/** Validate the request body. Pure except for the ref list, so every 400 is testable. */
export async function planFanout(body: FanoutRequest, deps: FanoutDeps): Promise<{ ok: true; name: string; planned: PlannedMember[] } | { ok: false; error: string }> {
  // Exactly one of name and groupId, the same shape as source XOR cwd below: a client sending
  // both is asking for a rename that this route will not do, and silence would look like one.
  if (body.groupId !== undefined && (typeof body.groupId !== "string" || !body.groupId)) return { ok: false, error: "groupId must be a group id" };
  const intoExisting = body.groupId !== undefined;
  if (intoExisting === (body.name !== undefined)) return { ok: false, error: "exactly one of name or groupId is required" };
  const name = intoExisting ? "" : cleanGroupName(body.name);
  if (name === null) return { ok: false, error: `name must be 1–${GROUP_NAME_MAX} characters` };
  if (!Array.isArray(body.members) || body.members.length === 0) return { ok: false, error: "members must be a non-empty array of { ref, count }" };
  for (const m of body.members) {
    if (typeof m?.ref !== "string" || !m.ref.includes("/")) return { ok: false, error: "each member needs a ref of the form provider/model" };
    if (!Number.isInteger(m?.count) || m.count < 1 || m.count > 9) return { ok: false, error: "each member's count must be an integer 1–9" };
  }
  const hasSource = body.source !== undefined;
  const hasCwd = body.cwd !== undefined;
  // Exactly one starting point: a fanout with none is not a thing the dialog can produce, and one
  // with both is two different requests wearing one body.
  if (hasSource === hasCwd) return { ok: false, error: "exactly one of source or cwd is required" };
  if (hasSource) {
    if (typeof body.source?.path !== "string" || typeof body.source?.leafId !== "string" || !body.source.leafId)
      return { ok: false, error: "source must be { path, leafId }" };
    if (body.text !== undefined || body.cwd !== undefined) return { ok: false, error: "text and cwd belong to fresh mode, not fork mode" };
  } else {
    if (typeof body.cwd !== "string" || !body.cwd) return { ok: false, error: "cwd must be an absolute path" };
    if (typeof body.text !== "string" || !body.text.trim()) return { ok: false, error: "fresh mode needs a first message" };
  }
  const known = await deps.knownRefs();
  const unknown = body.members.find((m) => !known.has(m.ref));
  if (unknown) return { ok: false, error: `No such model: ${unknown.ref}` };
  return { ok: true, name, planned: planMembers(body.members) };
}

/**
 * The quiet source a fork needs. Sourcing N managers means READING the source file N times, and
 * SessionManager.open() is not free of side effects (it appends a newline to a torn last line and
 * may rewrite the whole file to migrate an old version) — so every writer, and every format that
 * would provoke a rewrite, is grounds to refuse rather than proceed.
 *
 * No syscall here touches a session's cwd: the path is validated by shape, and the only read is
 * the source's own JSONL under the sessions directory.
 */
export async function checkSource(path: string, leafId: string, deps: FanoutDeps): Promise<BatchRefusal | null> {
  if (deps.live(path)) return refusal(path, "tui-live", "It is open in a terminal, so this server must not read it out from under that process.");
  if (deps.streaming(path)) return refusal(path, "mid-turn", "It is mid-turn here. Wait for the turn to finish, then fan out.");
  if (deps.foreignWriter(path)) return refusal(path, "busy", "Another process wrote to it just now.");
  if (deps.misconfigured(path)) return refusal(path, "config", "Its working directory is gone, so it cannot be opened.");
  const head = await deps.sourceHead(path);
  if (!head) return refusal(path, "missing", "Its session file could not be read.");
  // A rewrite-on-open would look like a foreign write to a runtime we hold for this session and
  // lock the user out of their own chat, so the version is a PRECONDITION, never a recovery.
  if (head.version !== CURRENT_SESSION_VERSION)
    return refusal(path, "old-format", "It is in an older session format. Open it for chat once to update it, then fan out.");
  // The client sends the leaf it showed the user; forking from a point they didn't approve would
  // break the fork marker's only promise.
  if (head.leafId !== leafId) return refusal(path, "stale-leaf", "It has moved on since the dialog opened. Close this and fan out again from the new last message.");
  return null;
}

/**
 * Create the members, then the group. Rollback boundary (confirmed with spec): a member that
 * fails DURING creation has its own half-written file unlinked, because a header with no session
 * behind it is a sidebar row that opens onto nothing; a member that already exists is never
 * unmade, because it is work the user can already read.
 */
export async function runFanout(body: FanoutRequest, deps: FanoutDeps = realFanoutDeps): Promise<FanoutOutcome> {
  const plan = await planFanout(body, deps);
  if (!plan.ok) return { ok: false, status: 400, error: plan.error };

  let sourcePath: string | null = null;
  if (body.source) {
    sourcePath = deps.resolveSource(body.source.path);
    if (!sourcePath) return { ok: false, status: 404, error: "Session file not found" };
    const refused = await checkSource(sourcePath, body.source.leafId, deps);
    if (refused) return { ok: false, status: 409, refused: [refused] };
  }

  // The target group, and whether it can take this fanout, are settled BEFORE anything is made:
  // a 404 or a seed conflict must leave no sessions behind.
  const seed: GroupSeed | undefined = sourcePath ? { parentSessionPath: sourcePath, leafId: body.source!.leafId } : undefined;
  let target: SessionGroup | null = null;
  if (body.groupId) {
    target = deps.group(body.groupId);
    if (!target) return { ok: false, status: 404, error: "Group not found" };
    // One group carries one seed: the fork marker and Align to Fork read it, so a mixed-lineage
    // group would make the marker assert a divergence point it cannot know. Refuse rather than
    // fabricate. (Fresh mode has no seed of its own, so it can never conflict.)
    if (seed && target.seed && (target.seed.parentSessionPath !== seed.parentSessionPath || target.seed.leafId !== seed.leafId))
      return {
        ok: false,
        status: 400,
        code: "seed-conflict",
        error: `“${target.name}” was forked from a different point, and a group can only have one fork point.`,
      };
  }

  const created: SessionSummary[] = [];
  const failed: BatchRefusal[] = [];
  for (const member of plan.planned) {
    let path: string | null = null;
    try {
      path = sourcePath ? await deps.fork(sourcePath, body.source!.leafId, member) : await deps.fresh(body.cwd!, member);
      const summary = await deps.summary(path);
      if (!summary) throw new Error("the new session could not be read back");
      created.push(summary);
    } catch (err) {
      if (path) deps.discard(path); // its own debris only; nothing that succeeded is touched
      // `ref` is the only handle on a member that never existed: no session, so no id and no
      // path. The message stays the server's bare reason — the banner composes "{model} couldn't
      // start: {message}" itself, so prefixing the ref here would render the model twice.
      const said = (err instanceof Error ? err.message : String(err)).trim();
      // The banner reads "{model} couldn't start: {message}", so everything before the colon is
      // already pi-web's claim and the message has to answer WHY. A restatement ("it could not be
      // started") stutters and tells the reader nothing they didn't have from the first clause.
      failed.push(refusal("", "internal", said || "The runtime gave no reason.", "", member.ref));
    }
  }
  // A group with no members is debris, not a result.
  if (created.length === 0) return { ok: false, status: 500, error: failed[0]?.message ?? "No member could be created" };

  // An existing target takes the members; a seedless one adopts this fanout's lineage first,
  // which is also how it becomes auto-dissolving (spec §14) — the cost of the honesty.
  // A group pi-web NAMED may dissolve when emptied; one the user named never does, even after it
  // adopts this fanout's lineage. Adoption gives the marker its datum, not a licence to delete.
  const group = target
    ? seed && !target.seed
      ? (deps.adoptSeed(target.id, seed) ?? target)
      : target
    // pi-web may remove only what it both made AND named. The client reports which; we record the
    // answer either way, never leaving it absent — an absent flag on a seeded group is the
    // on-disk signature of a pre-flag fanout group, and the legacy rule would dissolve it.
    // Spelled `=== "generated"` deliberately: `!== "user"` reads as equally correct and would
    // treat an ABSENT field as pi-web's, deleting a name an older client never claimed.
    : deps.createGroup(plan.name, seed, body.named === "generated");
  if (!group) return { ok: false, status: 500, error: "The group could not be created" };
  created.forEach((summary, i) => deps.assign(summary.id, group.id, plan.planned[i]!.label));

  // Fresh mode's first message goes through the stage-2 batch path. A refusal there keeps every
  // member: they are real, empty, grouped sessions the user can prompt with a retry.
  if (body.text) await deps.prompt(group.id, body.text);

  return { ok: true, result: { group: { ...group, ...(group.seed ?? seed ? { seed: group.seed ?? seed } : {}) }, created, failed } };
}
