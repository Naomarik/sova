// Start: the person's own click on the card (the route checks the door) freezes the
// revision they saw into the run's plan, writes each helper's brief and every team's layout into the run
// folder, sets up the conducting chat (this one, or a new one when the playbook asks for powers of its own),
// gives it one message (the playbook block and the run block) and marks the chats it touched.
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { HEntry, StateKind } from "../../shared/harness";
import type { PlaybookSpec } from "../../shared/playbook-format";
import type { PlaybookInfo } from "../../shared/protocol";
import type { PlaybookRunView } from "../../shared/playbook-run";
import { PROFILE_MINOR_MODES, type ProfileMinorMode, type SnapshotProfile } from "../../shared/profiles";
import type { ChatModePatch } from "../../shared/chat-runtime";
import { chatSharedFolder } from "../../pi-config/extensions/sandbox/shared-folder.ts";
import { acquireChatHandle } from "../chat-handle";
import { MODE, PLAYBOOK_RUN } from "../harness/state-kinds";
import { playbookPayload } from "../playbook-payload";
import { projectOf } from "../project-root";
import { inlineChoice } from "../session-profile";
import { applyProfile } from "../session-profile-routes";
import { promptSession } from "../session-prompt";
import { writeAutoTitle } from "../session-titles";
import { getSessionSummary } from "../sessions-index";
import { projectOverseerOfPath } from "../project-overseer-store";
import { answersKey, saveAnswers } from "./answers";
import { liveEnv, loadPlaybook, SOVA_SCRIPT } from "./env";
import { runBlock, runMessage, type ContentsSection } from "./message";
import { cardFlow, effectiveEdits, freezePlan, runCard, runsInNewChat, type CardEnv } from "./plan";
import { changeRun, oneRunRefusal, runById, runHolding, type PlaybookRunRecord } from "./store";
import { runView } from "./view";

export class RunRefused extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 500,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

type AppRequest = (path: string, init?: RequestInit) => Response | Promise<Response>;

/** What Start does to a chat, as a chat handle offers it (server/chat-handle.ts). */
export interface StartChat {
  readonly mirror: { model: { ref: string } | null; thinking: string; mode: { mode: string; minorModes: readonly string[] }; cwd: string };
  setModel(ref: string): Promise<unknown>;
  setThinking(level: string): Promise<unknown>;
  switchMode(patch: ChatModePatch): Promise<unknown>;
  pinMode(): Promise<unknown>;
  branch(): Promise<readonly HEntry[]>;
  appendState<T>(kind: StateKind<T>, data: T): Promise<unknown>;
}

/** The seams Start reaches the rest of Sova through; each defaults to the real one. */
export interface StartHost {
  chat(path: string): Promise<StartChat>;
  prompt(path: string, text: string): Promise<{ ok: true } | { ok: false; error: string }>;
  applyProfile(path: string, snapshot: SnapshotProfile): Promise<{ ok: true } | { ok: false; error: string }>;
  title(id: string, title: string): void;
  /** Why this chat would refuse the run's message, known before anything in it changes (a terminal holds it, it
      is archived, it is an overseer's or a baton's); null: nothing known against it. */
  preflight(path: string): Promise<string | null>;
  env(spec: PlaybookSpec, info: PlaybookInfo, chatPath: string | undefined, cwd: string): Promise<CardEnv>;
}

const realHost: StartHost = {
  chat: (path) => acquireChatHandle(path),
  prompt: async (path, text) => {
    const r = await promptSession(path, text);
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  },
  applyProfile: async (path, snapshot) => {
    const r = await applyProfile(path, inlineChoice(snapshot), "start");
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  },
  title: (id, title) => void writeAutoTitle(id, title),
  preflight: async (path) => {
    const s = await getSessionSummary(path);
    if (!s) return "This chat's file is gone.";
    if (s.live) return `This chat is open in a terminal (pid ${s.live.pid}), so Sova must not write to it.`;
    if (s.archived) return "This chat is archived: open it again first.";
    if (s.overseer || s.baton || projectOverseerOfPath(path)) return "This chat runs no playbooks.";
    return null;
  },
  env: (spec, info, chatPath, cwd) => liveEnv(spec, info, chatPath, cwd),
};

export interface StartDeps {
  /** The app's own routes, in process: a new chat is made the way the list makes one. */
  request: AppRequest;
  /** The playbook contents page's sections (Create's playbooks topic). */
  contents: () => ContentsSection[];
  /** Tests only: stand-ins for the chat, the prompt and this computer's models. */
  host?: Partial<StartHost>;
}

/** The project a folder belongs to (its main checkout's root), else the folder: the key your answers are kept under. */
export async function projectKeyOf(cwd: string): Promise<string> {
  if (!cwd) return "";
  const p = await projectOf(cwd).catch(() => null);
  return p && p.state === "ok" ? p.root : cwd;
}

/** The snapshot a playbook's own chat is made with: its permissions, as an automation's chat gets them. */
function playbookSnapshot(r: PlaybookRunRecord, spec: PlaybookSpec, root: string): SnapshotProfile {
  const p = spec.run.permissions!;
  const minors = spec.run.minorModes?.filter((m): m is ProfileMinorMode => (PROFILE_MINOR_MODES as readonly string[]).includes(m));
  return {
    id: `playbook-${r.playbook.id}`,
    label: r.playbook.title,
    icon: "branch",
    description: `Runs the playbook ${r.playbook.title}.`,
    remove: [...p.remove],
    grant: [...p.grant],
    singleton: p.oneAtATime,
    limits: { ...p.limits },
    overseerMayStart: p.overseerMayStart,
    ...(spec.run.mode ? { mode: spec.run.mode } : {}),
    ...(minors ? { minorModes: minors } : {}),
    source: r.playbook.source === "project" ? "project" : "user",
    ...(r.playbook.source === "project" ? { project: root, projectName: basename(root) } : {}),
  } as SnapshotProfile;
}

/** Make the conducting chat's mode the playbook's, where it differs; true when its mode was switched (and pinned).
    Its model and effort stay yours: the main chat runs on what you chose. */
async function setUpChat(chat: StartChat, spec: PlaybookSpec): Promise<boolean> {
  const want = spec.run.mode;
  const minors = spec.run.minorModes;
  const now = chat.mirror.mode;
  const modeDiffers = (want && now.mode !== want) || (minors && [...now.minorModes].sort().join(",") !== [...minors].sort().join(","));
  if (modeDiffers) {
    await chat.switchMode({ ...(want ? { mode: want } : {}), ...(minors ? { minorModes: minors as ChatModePatch["minorModes"] } : {}) });
    await chat.pinMode();
    return true;
  }
  return false;
}

async function newChat(request: AppRequest, cwd: string): Promise<{ id: string; path: string }> {
  const res = await request("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd }) });
  const made = (await res.json().catch(() => null)) as { id?: string; path?: string; error?: string } | null;
  if (res.status !== 201 || !made?.id || !made.path) throw new Error(`The run's chat couldn't be made: ${made?.error ?? `HTTP ${res.status}`}`);
  return { id: made.id, path: made.path };
}

/** The run folder: in the conducting chat's shared folder, which its helpers and teams can read. */
export const runFolderOf = (chatId: string, runId: string): string => join(chatSharedFolder(chatId), "playbook-runs", runId);

function writeFiles(folder: string, files: Record<string, string>, contents: ContentsSection[]): ContentsSection[] {
  for (const [rel, text] of Object.entries(files)) {
    const f = join(folder, rel);
    mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
    writeFileSync(f, text, { mode: 0o600 });
  }
  // The contents pages, copied: the run reads them where its sandbox can, as they were at Start.
  const out: ContentsSection[] = [];
  for (const s of contents) {
    const f = join(folder, "know-how", `${s.name}.md`);
    try {
      mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
      copyFileSync(s.file, f);
      out.push({ ...s, file: f });
    } catch {
      out.push(s);
    }
  }
  return out;
}

export async function startRun(runId: string, revision: number, deps: StartDeps): Promise<PlaybookRunView> {
  const r = runById(runId);
  if (!r || r.closed) throw new RunRefused(404, "No such playbook run.");
  if (r.state !== "draft") throw new RunRefused(409, r.state === "starting" ? "This run is starting." : "This run has already started.", { run: await runView(r) });
  if (revision !== r.revision) throw new RunRefused(409, "The card changed since you saw it. Here it is as it is now: check it and press Start again.", { run: await runView(r) });
  // A chat runs one playbook at most: neither the card's chat nor a chat an earlier Start made may hold another.
  for (const chat of [r.shownIn, r.halfMade]) {
    const holding = chat ? runHolding(chat.id, r.id) : undefined;
    if (holding) throw new RunRefused(409, oneRunRefusal(holding), { run: await runView(r), holding: holding.id });
  }
  // Claimed before the first wait, so a second click (or a second tab) finds it starting and starts nothing.
  changeRun(r.id, (x) => {
    x.state = "starting";
    delete x.startError;
  });
  const back = async (status: 400 | 409, why: string, extra: Record<string, unknown> = {}): Promise<never> => {
    changeRun(r.id, (x) => {
      x.state = "draft";
    });
    throw new RunRefused(status, why, { ...extra, run: await runView(runById(r.id)!) });
  };
  const loaded = await loadPlaybook(r.playbook, r.cwd).catch(() => null);
  if (!loaded?.spec) return back(409, loaded?.error ? `The playbook's description can't be read: ${loaded.error}` : "The playbook is gone.");
  const spec = loaded.spec;
  const host: StartHost = { ...realHost, ...deps.host };
  let env: CardEnv;
  try {
    env = await host.env(spec, loaded.info, r.shownIn?.path, r.cwd);
  } catch (err) {
    return back(409, `This computer's models and settings couldn't be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  const card = runCard({ ...r, state: "draft" }, spec, env);
  if (card.view.startBlocked) return back(400, card.view.startBlocked, { startBlocked: card.view.startBlocked });

  // What this Start changed, so a failure halfway can say it or put it back.
  let made: { id: string; path: string } | null = r.halfMade ?? null;
  let before: { path: string; mode: { mode: string; minorModes: string[] }; pinned: boolean; modeSwitched?: true } | null = null;
  try {
    const at = new Date().toISOString();
    const toNew = runsInNewChat(spec, r);
    const root = await projectKeyOf(r.cwd);
    let chat: { id: string; path: string };
    if (toNew) {
      // A chat an earlier Start made and then failed in is used again, never a second one.
      chat = made ?? (await newChat(deps.request, r.cwd));
      if (!made) {
        made = chat;
        changeRun(r.id, (x) => {
          x.halfMade = chat;
        });
      }
      if (spec.run.permissions) {
        const applied = await host.applyProfile(chat.path, playbookSnapshot(r, spec, root));
        if (!applied.ok) throw new Error(`The run's chat was made, but its permissions were not set: ${applied.error}`);
      }
      host.title(chat.id, `${r.playbook.title} (playbook)`);
    } else chat = r.shownIn!;
    if (!toNew) {
      // What would refuse the message is asked first, so a chat that can't take the run is never changed.
      const refused = await host.preflight(chat.path);
      if (refused) throw new Error(refused);
    }
    const conducting = await host.chat(chat.path);
    if (!toNew) {
      // A chat with no mode entry follows the default mode; one with an entry is pinned to it.
      const pinned = (await conducting.branch()).some((h) => h.kind === "state" && h.key === MODE.type);
      before = { path: chat.path, mode: { mode: conducting.mirror.mode.mode, minorModes: [...conducting.mirror.mode.minorModes] }, pinned };
    }
    const switched = await setUpChat(conducting, spec);
    if (switched && before) before.modeSwitched = true;

    const folder = runFolderOf(chat.id, r.id);
    const frozen = freezePlan(r, spec, env, card, toNew, at);
    const contents = writeFiles(folder, frozen.files, deps.contents());
    const bundle = { id: loaded.info.id, dir: loaded.info.dir, entry: loaded.info.entry };
    const branch = toNew ? null : await conducting.branch();
    const block = playbookPayload(bundle, branch ? { branch, cwd: conducting.mirror.cwd || r.cwd } : null).block;
    // A chat with no message and no name yet is named for the run, never by the run message's first words.
    if (branch && !branch.some((h) => h.kind === "user" || (h.kind === "setting" && h.what === "name"))) host.title(chat.id, `${r.playbook.title} (playbook)`);
    const text = runMessage(frozen.plan, block, runBlock(frozen.plan, folder, { contents, sovaScript: SOVA_SCRIPT }));
    const sent = await host.prompt(chat.path, text);
    if (!sent.ok) throw new Error(`The run's message was refused: ${sent.error}`);

    const started = {
      at,
      revision: r.revision,
      chat: { ...chat, ...(toNew ? { title: `${r.playbook.title} (playbook)` } : {}) },
      newChat: toNew,
      ...(r.shownIn && r.shownIn.id !== chat.id ? { fromChat: r.shownIn } : {}),
      folder,
    };
    changeRun(r.id, (x) => {
      x.state = "started";
      delete x.halfMade;
      x.started = started;
      // The record's drawing says what it can't show: the run started, and which step it's on isn't tracked.
      x.plan = { ...frozen.plan, view: { ...frozen.plan.view, state: "started", started, startBlocked: null, flow: cardFlow(spec, effectiveEdits(r), { state: "started" }) } };
    });
    // The marks on the chats' own files, best effort: the store is what the card reads.
    const mark = { v: 1 as const, runId: r.id, at, playbook: { source: r.playbook.source, id: r.playbook.id, title: r.playbook.title } };
    void (async () => {
      await (await host.chat(chat.path)).appendState(PLAYBOOK_RUN, { ...mark, conducts: true });
      if (started.fromChat) await (await host.chat(started.fromChat.path)).appendState(PLAYBOOK_RUN, { ...mark, conducts: false, chat });
    })().catch((err) => console.warn(`[playbook-runs] ${r.id}: the run's marks were not written: ${err instanceof Error ? err.message : String(err)}`));
    try {
      const e = effectiveEdits(r);
      saveAnswers(answersKey(r.playbook, root), "last", { choices: e.choices ?? {}, ...(e.roles ? { roles: e.roles } : {}), ...(e.stops ? { stops: e.stops } : {}), ...(e.cycle ? { cycle: e.cycle } : {}) });
    } catch (err) {
      console.warn(`[playbook-runs] ${r.id}: the last answers were not saved: ${err instanceof Error ? err.message : String(err)}`);
    }
    return runView(runById(r.id)!);
  } catch (err) {
    let why = err instanceof Error ? err.message : String(err);
    // This chat's mode goes back to what it was (pinned again as it was); a chat made for the run stays, and is named.
    if (before?.modeSwitched) {
      try {
        const held = await host.chat(before.path);
        // The switch back writes a mode entry of its own: a chat that followed the default mode is now held at the
        // mode it had (entries are never taken out of a chat's history). Re-pinned only when it was pinned before.
        if (before.modeSwitched) {
          await held.switchMode({ mode: before.mode.mode as ChatModePatch["mode"], minorModes: before.mode.minorModes as ChatModePatch["minorModes"] });
          if (before.pinned) await held.pinMode();
        }
      } catch {
        why += " This chat's mode may have changed: check it before you start again.";
      }
    }
    if (made) why += ` A chat was made for the run (${made.id}); pressing Start again uses it.`;
    changeRun(r.id, (x) => {
      x.state = "draft";
      x.startError = why;
    });
    // Refused, not broken: the card is a draft again and says why (a model without a sign-in here, a chat a terminal holds).
    throw new RunRefused(409, why, { run: await runView(runById(r.id)!) });
  }
}

