// The destination's side of a transport (§app.transport/arrival, §app.transport/switch): it takes the
// source's offer (a sessions route, with the click that started it proven back), gets ready (the
// Transport agent, when there is one), pulls the package with the one-time ticket, checks every file,
// rebuilds every worktree and points the home at this device, all in staging, and publishes only when
// the source sends its commit: the worktrees go to their folders and the home appears in one rename.
// A failure leaves nothing published; Cancel removes what arrived.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Pulls, TransferError } from "../mesh/links-transfer";
import { tarMembers } from "../mesh/tar-list";
import { stateRoot, agentRoot } from "../state-root";
import { markOwned } from "../write-guard";
import { chatHome, HOME_FILE, homesRoot } from "../chat-homes/root";
import { registerArrivedHome } from "../chat-homes/place";
import { reloadHome } from "../chat-homes/records";
import { compressedChats, dropCompressed, sidecarOf } from "../archive-compress/store";
import { dropStages, git, havesOf, type KeptFile, publishTrees, rebuildWorktrees, SnapshotError, type StagedTree } from "./git-snapshot";
import { afterArrival, knob, prepareDestination, type PrepareRequest } from "./hooks";
import { verifyHome, type PackageManifest } from "./package";
import { findConversation, relocateHome, sessionIdOfName } from "./relocate";
import { createTransport, logName, readTransport, stepDone, type TransportRecord, updateTransport } from "./store";
import { checkMembers } from "./tar";
import { type OfferBody, peerPath, type ReadyBody, type StatusBody, TICKET_HEADER } from "./wire";

const log = (line: string) => console.log(`[transport] ${line}`);

/** This server's code root: where a worker's extensions load from here. */
const OWN_CODE = resolve(import.meta.dirname, "..", "..");

/** What the destination needs from the rest of the server (the real ones in routes.ts; tests swap them). */
export interface DestinationDeps {
  peerFetch(peerId: string, path: string, init?: RequestInit): Promise<Response>;
  /** Whether the source really minted this click proof for this body (asked back once, burnt). */
  clickProven(peerId: string, proof: string, body: string): Promise<boolean>;
  /** After the home is in place: list it, track its helpers. */
  adopt(homeId: string): void;
  /** The chat came back to a device it once moved away from: that old Moved mark goes. */
  cameBack(homeId: string): void;
  /** The arrived chat opened, its note written (no turn starts). */
  openWithNote(path: string, text: string): Promise<void>;
  /** A helper told to carry on (it moved while working). */
  tellHelper(chatId: string, text: string, key: string): Promise<void>;
  /** The note a moved helper hears. */
  helperNote(device: string, interrupted: boolean): string;
  /** Bring a moved chat's usage cut in, apart from this device's own records: what it counted. */
  importUsage(bytes: Buffer, from: string): Record<string, number>;
}

let deps: DestinationDeps | null = null;
export const setDestinationDeps = (d: DestinationDeps): void => void (deps = d);
const need = (): DestinationDeps => {
  if (!deps) throw new Error("Transport isn't wired on this server.");
  return deps;
};

/** Staging, beside the homes root (the same filesystem, so the publishing rename is one step) and outside every
    home, which only Sova's own records and a chat's shared folder fill. */
export const incomingRoot = (): string => `${homesRoot()}.incoming`;
const incomingOf = (tid: string) => join(incomingRoot(), tid);

/**
 * The chat comes home to a device where its old copy was compressed (a Moved row's safety copy after 7 days): that
 * compressed copy would hide the arrived chat and keep it from opening. It is moved aside, never deleted, to
 * `<homes root>.superseded/<id>-<tid>.tar.gz` with its entry beside it, and its entry leaves the list.
 */
async function supersedeCompressed(id: string, tid: string): Promise<void> {
  const e = compressedChats()[id];
  if (!e) return;
  const aside = `${homesRoot()}.superseded`;
  mkdirSync(aside, { recursive: true, mode: 0o700 });
  const base = join(aside, `${id}-${tid}`);
  await writeFile(`${base}.compressed.json`, `${JSON.stringify(e, null, 2)}\n`, { mode: 0o600 });
  if (e.kind === "home" && e.archive && existsSync(e.archive)) {
    await rename(e.archive, `${base}.tar.gz`);
    await rm(sidecarOf(e.archive), { force: true });
  }
  dropCompressed(id);
  log(`${tid}: its earlier compressed copy here is kept aside at ${base}.*`);
}

const pulls = new Pulls({
  root: () => join(stateRoot(), "transport"),
  fetchTar: async ({ offerId, senderNodeId, path, headers, signal }) => {
    const r = readTransport(offerId);
    if (!r?.ticket) throw new TransferError("internal", "This transport has no ticket here.");
    return need().peerFetch(senderNodeId, path, { headers: { ...headers, [TICKET_HEADER]: r.ticket }, signal });
  },
  log: (line) => log(line.replace(/^\[links\] /, "")),
});

const canonical = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};
const within = (p: string, dir: string) => p === dir || p.startsWith(`${dir}/`);

/** Why a folder the source named may not be used here, or null: absolute, under this user's home, never in Sova's own state. */
export function folderRefusal(folder: unknown): string | null {
  if (typeof folder !== "string" || !isAbsolute(folder) || folder.includes("\0")) return "The folder must be an absolute path on that device.";
  const f = resolve(folder);
  const real = canonical(dirname(f));
  const home = canonical(homedir());
  if (!within(f, home) && !within(real, home)) return `${folder} isn't inside this device's home folder.`;
  for (const own of [stateRoot(), agentRoot(), homesRoot()].map(canonical)) if (within(f, own) || within(real, own) || within(own, f)) return `${folder} is inside Sova's own state on this device.`;
  return null;
}

const ok = (body: unknown, status = 200) => ({ status, body });

/** The source's offer (POST /api/peer/transport/offer), from peer `from`. */
export async function takeOffer(from: { id: string; label: string }, raw: string, proof: string): Promise<{ status: number; body: unknown }> {
  let b: OfferBody;
  try {
    b = JSON.parse(raw) as OfferBody;
  } catch {
    return ok({ error: "Bad offer" }, 400);
  }
  if (b?.v !== 1 || !/^tr_[a-z0-9]{6,32}$/.test(String(b.tid)) || typeof b.ticket !== "string" || b.ticket.length < 32 || (b.mode !== "move" && b.mode !== "copy") || !b.chat?.id) return ok({ error: "Bad offer" }, 400);
  const known = readTransport(b.tid);
  if (known) return known.peer === from.id ? ok({ ok: true, again: true }) : ok({ error: "Not yours" }, 403);
  // A person pressed it on the source's own page: the source minted a proof over this very offer, asked back once.
  if (!proof || !(await need().clickProven(from.id, proof, raw))) return ok({ error: "Only you start a transport, from this device's page. Nothing was sent." }, 403);
  // `~/…` is this device's home.
  if (typeof b.folder === "string" && (b.folder === "~" || b.folder.startsWith("~/"))) b.folder = join(homedir(), b.folder.slice(2));
  const why = folderRefusal(b.folder);
  if (why) return ok({ error: why }, 400);
  for (const t of b.trees ?? []) if (typeof t.rel !== "string" || t.rel.split("/").includes("..") || isAbsolute(t.rel)) return ok({ error: "Bad worktree path" }, 400);
  if (b.mode === "move" && existsSync(chatHome(b.chat.id))) return ok({ error: "This device still holds a copy of this chat (its Moved row). Delete that here first." }, 409);
  createTransport({
    tid: b.tid,
    side: "destination",
    mode: b.mode,
    chatId: b.chat.id,
    sourceChatId: b.chat.id,
    title: b.chat.title,
    peer: from.id,
    peerLabel: b.sourceLabel || from.label,
    path: "",
    folder: resolve(b.folder),
    state: "preparing",
    ticket: b.ticket,
    // The folders that aren't here yet: one the Transport agent then makes is this transport's to take over.
    ext: { absentAtOffer: (b.trees ?? []).map((t) => (t.rel ? resolve(dirname(resolve(b.folder)), t.rel) : resolve(b.folder))).filter((p) => !existsSync(p)), offer: { trees: b.trees, repoRel: b.repoRel, project: b.project, ...(b.model ? { model: b.model } : {}), ...(typeof b.chatModel === "string" && b.chatModel.length < 200 ? { chatModel: b.chatModel } : {}) } },
  });
  stepDone(b.tid, "offered");
  log(`${b.tid}: offered by ${from.label} (${b.mode} of ${b.chat.id})`);
  void prepare(b.tid);
  return ok({ ok: true });
}

interface OfferExt {
  trees: OfferBody["trees"];
  repoRel: string | null;
  project: OfferBody["project"];
  model?: string;
  chatModel?: string;
}
/** The chat's own tree (the folder) first, as the Transport agent reads the list. */
const ownFirst = <T extends { rel: string }>(trees: readonly T[]): T[] => [...trees].sort((a, b) => (a.rel === "" ? 0 : 1) - (b.rel === "" ? 0 : 1));
const offerOf = (r: TransportRecord): OfferExt => (r.ext?.offer ?? { trees: [], repoRel: null, project: { remotes: [], roots: [] } }) as OfferExt;

/** Where the repository is here for a chat whose tree is a linked worktree; null when the package builds it whole. */
function repoPathOf(r: TransportRecord): string | null {
  const o = offerOf(r);
  if (o.trees.some((t) => t.main) || o.repoRel === null) return null;
  return resolve(dirname(r.folder), o.repoRel);
}

const controllers = new Map<string, AbortController>();

/** Get ready (the Transport agent, when one is wired), then tell the source the commits here. */
async function prepare(tid: string): Promise<void> {
  const r = readTransport(tid);
  if (!r) return;
  const ctl = new AbortController();
  controllers.set(tid, ctl);
  try {
    const o = offerOf(r);
    const repo = repoPathOf(r);
    const req: PrepareRequest = {
      tid,
      sourcePeer: r.peer,
      sourceLabel: r.peerLabel,
      sourceChatId: r.sourceChatId,
      title: r.title,
      project: { remotes: o.project.remotes, ...(o.project.roots[0] ? { firstCommit: o.project.roots[0] } : {}), path: repo ?? r.folder },
      worktrees: ownFirst(o.trees).map((t) => ({ name: t.name, branch: t.branch, ...(typeof t.head === "string" && /^[0-9a-f]{40,64}$/.test(t.head) ? { head: t.head } : {}) })),
      ...(o.model ? { model: o.model } : {}),
      ...(o.chatModel ? { chatModel: o.chatModel } : {}),
    };
    const p = await prepareDestination(req, { signal: ctl.signal });
    if ("needsYou" in p) return void needsYou(tid, p.needsYou);
    if (repo) {
      if (existsSync(repo)) {
        if (!existsSync(join(repo, ".git"))) return void needsYou(tid, `${repo} exists here and isn't a git repository`);
        const roots = (await git(repo, ["rev-list", "--max-parents=0", "HEAD"])).stdout.split("\n").filter(Boolean);
        if (o.project.roots.length && roots.length && !roots.some((x) => o.project.roots.includes(x))) return void needsYou(tid, `${repo} here holds another project`);
      } else {
        mkdirSync(repo, { recursive: true });
        await git(repo, ["init", "-q"]);
      }
    }
    await knob(tid, "prepared");
    stepDone(tid, "prepared", { haves: repo ? await havesOf(repo) : [], state: "preparing" });
  } catch (err) {
    needsYou(tid, err instanceof Error ? err.message : String(err));
  } finally {
    controllers.delete(tid);
  }
}

function needsYou(tid: string, reason: string): void {
  log(`${tid}: needs you: ${reason}`);
  updateTransport(tid, { state: "needs-you", needsYou: { reason, at: new Date().toISOString() } });
}

/** The source's package is ready (POST …/ready): pull it, check it, rebuild in staging. */
export function packageReady(from: { id: string }, tid: string, b: ReadyBody): { status: number; body: unknown } {
  const r = readTransport(tid);
  if (!r || r.side !== "destination" || r.peer !== from.id) return ok({ error: "No such transport" }, 404);
  if (!/^[0-9a-f]{64}$/.test(String(b?.sha256)) || !Number.isSafeInteger(b?.size) || b.size <= 0) return ok({ error: "Bad package" }, 400);
  if (r.steps.verified && r.pkg?.sha256 === b.sha256) return ok({ ok: true, again: true });
  updateTransport(tid, { pkg: { sha256: b.sha256, size: b.size }, state: "sending", needsYou: undefined, steps: { ...r.steps, pulled: undefined, staged: undefined, verified: undefined } });
  void arrive(tid);
  return ok({ ok: true });
}

const arriving = new Set<string>();

/** Pull, check, rebuild, relocate: everything but the publish. Safe to run again (a retry continues). */
async function arrive(tid: string): Promise<void> {
  if (arriving.has(tid)) return;
  arriving.add(tid);
  try {
    let r = readTransport(tid);
    if (!r?.pkg) return;
    const pkg = r.pkg;
    const at = incomingOf(tid);
    // A run that died after the relocation began left the staged home rewritten (a file maybe half written):
    // it no longer matches the package's hashes, so the package is pulled and unpacked again.
    if (r.steps.pulled && !r.steps.verified && (r.ext as { relocating?: string } | undefined)?.relocating === pkg.sha256) {
      log(`${tid}: the last attempt stopped while relocating; pulling the package again`);
      r = updateTransport(tid, { steps: { ...r.steps, pulled: undefined, staged: undefined }, ext: { relocating: "" } })!;
    }
    if (!r.steps.pulled) {
      await rm(at, { recursive: true, force: true });
      mkdirSync(at, { recursive: true, mode: 0o700 });
      await pulls.pull({
        offerId: tid,
        linkId: tid,
        from: r.peer,
        path: peerPath.package(tid),
        snapshot: pkg,
        resolvedDest: at,
        rootNames: ["package.json", "home", "code", "usage.json"],
        onProgress: (p) => void updateTransport(tid, { received: p.received }),
        prescan: async (members) => {
          const all: { name: string; flag: string; mode: number }[] = [];
          for await (const m of members) all.push({ name: m.name, flag: m.type === "file" ? "0" : m.type === "dir" ? "5" : m.type === "symlink" ? "2" : "?", mode: 0 });
          const why = checkMembers(all);
          if (why) throw new TransferError("protected", `The package was refused: ${why}.`);
        },
      });
      await knob(tid, "pulled");
      stepDone(tid, "pulled", { state: "checking", received: pkg.size });
    }
    const manifest = JSON.parse(await readFile(join(at, "package.json"), "utf8")) as PackageManifest;
    if (manifest.tid !== tid) throw new Error("The package is another transport's.");
    const bad = await verifyHome(at, manifest);
    if (bad) throw new Error(bad);
    // The worktrees, rebuilt beside their folders and checked (nothing in place yet).
    const cur = readTransport(tid)!;
    const o = offerOf(cur);
    const targets: Record<string, string> = {};
    for (const t of o.trees) targets[t.name] = t.rel ? resolve(dirname(cur.folder), t.rel) : cur.folder;
    const repo = repoPathOf(cur);
    let staged: StagedTree[] = [];
    if (manifest.worktrees.length) staged = await rebuildWorktrees({ repo, codeDir: join(at, "code"), tid, metas: manifest.worktrees.map((w) => w.meta), targets, ours: ((cur.ext ?? {}) as { absentAtOffer?: string[] }).absentAtOffer ?? [] });
    await knob(tid, "staged");
    stepDone(tid, "staged", { ext: { staged, targets } });
    // The home, pointed at this device: a Copy's conversations get ids of their own.
    const ids: Record<string, string> = {};
    if (cur.mode === "copy") for (const n of await readdir(join(at, "home", "sessions")).catch(() => [] as string[])) {
      const id = sessionIdOfName(n);
      if (id) ids[id] = randomUUID();
    }
    const arrivedId = ids[manifest.chat.id] ?? manifest.chat.id;
    const home = chatHome(arrivedId);
    const map: [string, string][] = [[manifest.source.home, home]];
    for (const w of manifest.worktrees) if (targets[w.name]) map.push([w.path, targets[w.name]!]);
    const chatTree = manifest.worktrees.find((w) => o.trees.find((t) => t.name === w.name)?.rel === "");
    if (!chatTree && manifest.chat.cwd) map.push([manifest.chat.cwd, cur.folder]);
    if (repo && manifest.worktrees[0]) {
      const srcMain = sourceMainOf(manifest, o);
      if (srcMain) map.push([srcMain, repo]);
    }
    const broad: [string, string][] = [[manifest.source.agentDir, agentRoot()], [manifest.source.stateRoot, canonical(stateRoot())], [manifest.source.homeDir, homedir()]];
    updateTransport(tid, { ext: { relocating: pkg.sha256 } });
    const moved = await relocateHome(join(at, "home"), { map, ids, code: OWN_CODE, broad });
    await fixManifest(join(at, "home"), arrivedId, cur.mode);
    log(`${tid}: relocated ${moved.conversations} conversations, ${moved.workers} helper records, ${moved.records} records`);
    await knob(tid, "verified");
    // The source's own spellings of its folders: a private file still holding one goes to the Transport agent.
    const sourceValues = [...new Set([manifest.source.homeDir, manifest.source.home, manifest.source.agentDir, manifest.source.stateRoot, ...(manifest.chat.cwd ? [manifest.chat.cwd] : []), ...manifest.worktrees.map((w) => w.path)].filter((v): v is string => typeof v === "string" && v.length > 1))];
    stepDone(tid, "verified", { ext: { sourceValues }, state: "switching", arrivedId, renamed: staged.filter((s) => s.renamedFrom).map((s) => ({ from: s.renamedFrom!, to: s.branch! })) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof SnapshotError && err.reason === "needs-base") updateTransport(tid, { haves: [] });
    needsYou(tid, msg);
  } finally {
    arriving.delete(tid);
  }
}

/** The source's main checkout, from the offer's relative layout. */
function sourceMainOf(m: PackageManifest, o: OfferExt): string | null {
  const own = o.trees.find((t) => t.rel === "");
  const w = own ? m.worktrees.find((x) => x.name === own.name) : null;
  return w && o.repoRel !== null ? resolve(dirname(w.path), o.repoRel) : null;
}

/** The home's manifest names this state root (or the home isn't listed here) and, for a Copy, its new id. */
async function fixManifest(home: string, id: string, mode: "move" | "copy"): Promise<void> {
  const f = join(home, HOME_FILE);
  if (!existsSync(f)) return;
  const m = JSON.parse(await readFile(f, "utf8")) as Record<string, unknown>;
  m.id = id;
  m.stateRoot = canonical(stateRoot());
  if (mode === "copy") m.copiedFrom = { at: new Date().toISOString() };
  await writeFile(f, `${JSON.stringify(m, null, 2)}\n`, { mode: 0o600 });
  // Group membership is dropped (§app.transport/edge-cases); a Copy's team starts idle.
  const meta = join(home, "chat", "meta.json");
  if (existsSync(meta)) {
    const v = JSON.parse(await readFile(meta, "utf8")) as Record<string, unknown>;
    delete v.group;
    delete v.archived;
    await writeFile(meta, `${JSON.stringify(v, null, 2)}\n`, { mode: 0o600 });
  }
  if (mode === "copy")
    for (const n of await readdir(join(home, "workers")).catch(() => [] as string[])) {
      const p = join(home, "workers", n);
      const rec = JSON.parse(await readFile(p, "utf8")) as { state?: string };
      if (rec.state === "open") {
        rec.state = "idle";
        await writeFile(p, `${JSON.stringify(rec)}\n`, { mode: 0o600 });
      }
    }
}

/** The source's commit (POST …/commit): publish, open the chat, tell it what moved. Idempotent. */
export async function commit(from: { id: string }, tid: string, body: { stopped?: { jobs: string[]; copies: string[] }; interrupted?: string[]; wrapped?: string[] }): Promise<{ status: number; body: unknown }> {
  const r = readTransport(tid);
  if (!r || r.side !== "destination" || r.peer !== from.id) return ok({ error: "No such transport" }, 404);
  if (r.steps.opened) return ok({ ok: true, again: true, arrivedId: r.arrivedId });
  if (!r.steps.verified || !r.arrivedId) return ok({ error: "Nothing verified to publish yet" }, 409);
  try {
    await knob(tid, "decided");
    const ext = (r.ext ?? {}) as { staged?: StagedTree[] };
    if (!r.steps.published) {
      if (ext.staged?.length) {
        const put = await publishTrees(ext.staged, tid, { from: r.peerLabel });
        updateTransport(tid, { ext: { privateFiles: put.privateFiles, kept: put.kept } });
      }
      const home = chatHome(r.arrivedId);
      const staged = join(incomingOf(tid), "home");
      if (existsSync(staged)) {
        if (existsSync(home)) throw new Error("This device already has a chat with that id.");
        await supersedeCompressed(r.arrivedId, tid);
        await rename(staged, home);
      }
      // Its cost, before it is listed: kept apart from this device's own records (a retry counts it once).
      const usage = join(incomingOf(tid), "usage.json");
      if (existsSync(usage))
        try {
          const n = need().importUsage(await readFile(usage), r.peerLabel);
          log(`${tid}: usage brought in: ${Object.entries(n).map(([k, v]) => `${v} ${k}`).join(", ")}`);
        } catch (err) {
          log(`${tid}: its usage records weren't brought in: ${err instanceof Error ? err.message : String(err)}`);
        }
      // Listed (its home.json names this state root), the list bumped, chat.created said; then its helpers tracked.
      // Its records (meta, seen, names…) read now, not at the next restart.
      reloadHome(r.arrivedId);
      if (!registerArrivedHome(r.arrivedId)) throw new Error("The arrived home isn't this device's (its home.json).");
      need().adopt(r.arrivedId);
      await knob(tid, "published");
      stepDone(tid, "published");
      await rm(incomingOf(tid), { recursive: true, force: true });
    }
    // A chat coming home to a device it once moved away from: that old Moved mark would keep it from opening (also on a Retry).
    need().cameBack(r.arrivedId);
    const home = chatHome(r.arrivedId);
    const file = await findConversation(home, r.arrivedId);
    if (!file) throw new Error("The arrived chat's conversation isn't in its home.");
    // This server wrote every conversation of the home (the arrival's relocation): its write guard must not take
    // them for a foreign process's and refuse the chat's next prompt.
    for (const n of await readdir(join(home, "sessions")).catch(() => [] as string[])) if (n.endsWith(".jsonl")) markOwned(join(home, "sessions", n));
    updateTransport(tid, { path: file });
    const stopped = [...(body?.stopped?.jobs ?? []), ...(body?.stopped?.copies ?? [])];
    const renamedNotes = (readTransport(tid)?.renamed ?? []).map((x) => ` Its branch was ${x.from} there; that name was taken, so it is ${x.to}.`).join("");
    const done = (readTransport(tid)?.ext ?? {}) as { kept?: KeptFile[]; privateFiles?: string[]; sourceValues?: string[]; targets?: Record<string, string> };
    const keptNotes = (done.kept ?? []).map((k) => ` ${k.tree}/${k.path} was already here and differs, so it was kept; the one from ${r.peerLabel} is ${k.tree}/${k.beside}.`).join("");
    const note = `${r.mode === "move" ? "Moved" : "Copied"} from ${r.peerLabel}.${stopped.length ? ` Stopped there: ${stopped.join(", ")}.` : ""}${renamedNotes}${keptNotes}`;
    // Once only: a run that died after writing it (before "opened") finds it there.
    // Looked for only past where the conversation ended before this transport's first try (an earlier Move's note may read the same).
    const text = await readFile(file, "utf8").catch(() => "");
    const from = ((readTransport(tid)?.ext ?? {}) as { noteFrom?: number }).noteFrom ?? (updateTransport(tid, { ext: { noteFrom: Buffer.byteLength(text) } }), Buffer.byteLength(text));
    const said = Buffer.from(text).subarray(from).toString("utf8").split("\n").some((l) => l.includes('"sova-transport-arrival"') && l.includes(JSON.stringify(note).slice(1, -1)));
    if (!said) await need().openWithNote(file, note);
    await knob(tid, "opened");
    // Its size once the note is in: any later growth is a turn here, and Move Back is gone (§app.transport/moved-row).
    stepDone(tid, "opened", { state: "done", ext: { openedPrint: await fingerprint(readTransport(tid)!) } });
    // A moved team carries on: each helper that was working is told it moved; an idle one stays idle.
    if (r.mode === "move")
      for (const [list, interrupted] of [[body?.interrupted ?? [], true], [body?.wrapped ?? [], false]] as const)
        for (const chatId of list) await need().tellHelper(chatId, need().helperNote(r.peerLabel, interrupted), `${tid}:moved:${chatId}`).catch((err) => log(`${tid}: ${chatId} wasn't told it moved: ${err instanceof Error ? err.message : String(err)}`));
    const o = offerOf(r);
    afterArrival({
      tid,
      sourcePeer: r.peer,
      sourceLabel: r.peerLabel,
      sourceChatId: r.sourceChatId,
      title: r.title,
      project: { remotes: o.project.remotes, path: repoPathOf(r) ?? r.folder },
      worktrees: ownFirst(o.trees).map((t) => ({ name: t.name, branch: t.branch, ...(typeof t.head === "string" && /^[0-9a-f]{40,64}$/.test(t.head) ? { head: t.head } : {}) })),
      ...(o.model ? { model: o.model } : {}),
      ...(o.chatModel ? { chatModel: o.chatModel } : {}),
      privateFiles: done.privateFiles ?? [],
      sourceValues: done.sourceValues ?? [],
    });
    log(`${logName(r)}: arrived as ${r.arrivedId}`);
    return ok({ ok: true, arrivedId: r.arrivedId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    needsYou(tid, msg);
    return ok({ error: msg }, 500);
  }
}

/** How far it is (GET …/:tid). */
export async function statusOf(from: { id: string }, tid: string): Promise<StatusBody> {
  const r = readTransport(tid);
  if (!r || r.side !== "destination" || r.peer !== from.id) return { tid, state: "unknown", steps: {} };
  return {
    tid,
    state: r.state,
    steps: r.steps as Record<string, string>,
    ...(r.steps.prepared ? { haves: r.haves ?? [] } : {}),
    ...(r.needsYou ? { needsYou: r.needsYou.reason } : {}),
    ...(r.received !== undefined ? { received: r.received } : {}),
    ...(r.arrivedId ? { arrivedId: r.arrivedId } : {}),
    ...(r.renamed?.length ? { renamed: r.renamed } : {}),
    ...(r.steps.opened && r.path ? { path: r.path, turned: await turnedHere(r) } : {}),
  };
}

/** What a chat's turns change here: every conversation, its shared folder, mailboxes and helper records, and each
    arrived worktree's HEAD and tracked status. */
export async function fingerprint(r: TransportRecord): Promise<string> {
  const home = chatHome(r.arrivedId ?? r.chatId);
  const parts: string[] = [];
  const walk = (dir: string, rel: string) => {
    let names: string[];
    try {
      names = readdirSync(join(dir, rel)).sort();
    } catch {
      return;
    }
    for (const n of names) {
      const p = rel ? `${rel}/${n}` : n;
      const st = lstatSafe(join(dir, p));
      if (!st) continue;
      if (st.isDirectory()) walk(dir, p);
      else parts.push(`${p} ${st.size} ${Math.floor(st.mtimeMs)}`);
    }
  };
  for (const d of ["sessions", "shared", "teams", "workers"]) walk(home, d);
  const targets = ((r.ext ?? {}) as { targets?: Record<string, string> }).targets ?? {};
  for (const t of Object.values(targets).sort()) {
    const head = (await git(t, ["rev-parse", "-q", "--verify", "HEAD"])).stdout.trim();
    const status = (await git(t, ["status", "--porcelain=v1", "-z", "-uno"])).stdout;
    parts.push(`${t} ${head} ${createHash("sha256").update(status).digest("hex")}`);
  }
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

const lstatSafe = (p: string) => {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
};


/** Whether anything happened to the arrived chat here since it opened: a turn of the chat or any helper, a file in its
    shared folder, its mailboxes or records, or its worktrees (§app.transport/moved-row: Move Back only while nothing did). */
async function turnedHere(r: TransportRecord): Promise<boolean> {
  const was = ((r.ext ?? {}) as { openedPrint?: string }).openedPrint;
  return was === undefined || (await fingerprint(r)) !== was;
}

/** What Move Back does here (the device the chat is on): stop it, become the Moved side. Injected by routes.ts. */
export interface MoveBackHere {
  (r: TransportRecord, back: { path: string }): Promise<void>;
}
let moveBackHere: MoveBackHere | null = null;
export const setMoveBackHere = (fn: MoveBackHere): void => void (moveBackHere = fn);

/** Move Back, asked by the device the chat came from (POST …/move-back): only while nothing happened here. */
export async function moveBack(from: { id: string }, tid: string, body: { path?: unknown }): Promise<{ status: number; body: unknown }> {
  const r = readTransport(tid);
  if (!r || r.side !== "destination" || r.peer !== from.id || r.mode !== "move" || !r.steps.opened) return ok({ error: "No such transport" }, 404);
  if (((r.ext ?? {}) as { movedBack?: string }).movedBack) return ok({ ok: true, again: true });
  if (await turnedHere(r)) return ok({ error: "It has changed here since it arrived, so only a Copy can bring it back.", turned: true }, 409);
  if (typeof body?.path !== "string") return ok({ error: "Bad request" }, 400);
  try {
    await moveBackHere!(r, { path: body.path });
    updateTransport(tid, { ext: { movedBack: new Date().toISOString() } });
    log(`${tid}: moved back to ${r.peerLabel}`);
    return ok({ ok: true });
  } catch (err) {
    return ok({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}

/** Retry (POST …/retry): continue from what arrived. */
export function retry(from: { id: string }, tid: string): { status: number; body: unknown } {
  const r = readTransport(tid);
  if (!r || r.side !== "destination" || r.peer !== from.id) return ok({ error: "No such transport" }, 404);
  if (r.state === "done" || r.state === "cancelled") return ok({ ok: true, state: r.state });
  updateTransport(tid, { needsYou: undefined, state: r.steps.verified ? "switching" : r.pkg ? "sending" : "preparing", attempt: r.attempt + 1 });
  if (!r.steps.prepared) void prepare(tid);
  else if (r.pkg && !r.steps.verified) void arrive(tid);
  return ok({ ok: true });
}

/** Cancel (POST …/cancel): what arrived is removed; refused once the chat is published here. */
export async function cancel(from: { id: string }, tid: string): Promise<{ status: number; body: unknown }> {
  const r = readTransport(tid);
  if (!r || r.side !== "destination" || r.peer !== from.id) return ok({ ok: true, gone: true });
  if (r.steps.published) return ok({ error: "It already arrived here.", published: true }, 409);
  controllers.get(tid)?.abort();
  pulls.cancel(tid);
  const staged = ((r.ext ?? {}) as { staged?: StagedTree[] }).staged ?? [];
  await dropStages(staged, repoPathOf(r), tid).catch(() => {});
  await rm(incomingOf(tid), { recursive: true, force: true });
  updateTransport(tid, { state: "cancelled", ticket: undefined, ticketBurnt: true });
  log(`${tid}: cancelled; what arrived was removed`);
  return ok({ ok: true });
}

/** At start: transports this server was in the middle of go on from where they were. */
export function resumeDestinations(list: readonly TransportRecord[]): void {
  for (const r of list) {
    if (r.side !== "destination" || r.state === "done" || r.state === "cancelled" || r.state === "needs-you") continue;
    if (!r.steps.prepared) void prepare(r.tid);
    else if (r.pkg && !r.steps.verified) void arrive(r.tid);
  }
}

