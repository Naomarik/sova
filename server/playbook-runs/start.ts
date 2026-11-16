// Start: the person's own click on the card (the route checks the door) freezes the
// revision they saw into the run's plan, writes each helper's brief and every team's layout into the run
// folder, sets up the conducting chat (this one, or a new one when the playbook asks for powers of its own),
// gives it one message (the playbook block and the run block) and marks the chats it touched.
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { MAIN_ROLE, type PlaybookSpec } from "../../shared/playbook-format";
import type { PlaybookRunView } from "../../shared/playbook-run";
import { PROFILE_MINOR_MODES, type ProfileMinorMode, type SnapshotProfile } from "../../shared/profiles";
import type { ChatModePatch } from "../../shared/chat-runtime";
import { chatSharedFolder } from "../../pi-config/extensions/sandbox/shared-folder.ts";
import { acquireChatHandle } from "../chat-handle";
import { PLAYBOOK_RUN } from "../harness/state-kinds";
import { playbookPayload } from "../playbook-payload";
import { projectOf } from "../project-root";
import { inlineChoice } from "../session-profile";
import { applyProfile } from "../session-profile-routes";
import { promptSession } from "../session-prompt";
import { writeAutoTitle } from "../session-titles";
import { answersKey, saveAnswers } from "./answers";
import { chatRefOf, liveEnv, loadPlaybook, SOVA_SCRIPT } from "./env";
import { runBlock, runMessage, type ContentsSection } from "./message";
import { effectiveEdits, freezePlan, runCard, runsInNewChat } from "./plan";
import { changeRun, runById, type PlaybookRunRecord } from "./store";
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

export interface StartDeps {
  /** The app's own routes, in process: a new chat is made the way the list makes one. */
  request: AppRequest;
  /** The playbook contents page's sections (Create's playbooks topic). */
  contents: () => ContentsSection[];
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

/** Make the conducting chat's model, effort and mode the plan's, where they differ. */
async function setUpChat(path: string, use: { model: string; effort?: string } | null, spec: PlaybookSpec): Promise<void> {
  const chat = await acquireChatHandle(path);
  if (use) {
    if (chat.mirror.model?.ref !== use.model) await chat.setModel(use.model);
    if (use.effort && chat.mirror.thinking !== use.effort) await chat.setThinking(use.effort);
  }
  const want = spec.run.mode;
  const minors = spec.run.minorModes;
  const now = chat.mirror.mode;
  const modeDiffers = (want && now.mode !== want) || (minors && [...now.minorModes].sort().join(",") !== [...minors].sort().join(","));
  if (modeDiffers) {
    await chat.switchMode({ ...(want ? { mode: want } : {}), ...(minors ? { minorModes: minors as ChatModePatch["minorModes"] } : {}) });
    await chat.pinMode();
  }
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
  const loaded = await loadPlaybook(r.playbook, r.cwd);
  if (!loaded?.spec) throw new RunRefused(409, loaded?.error ? `The playbook's description can't be read: ${loaded.error}` : "The playbook is gone.", { run: await runView(r) });
  const spec = loaded.spec;
  const env = await liveEnv(spec, loaded.info, r.shownIn?.path);
  const card = runCard(r, spec, env);
  if (card.view.startBlocked) throw new RunRefused(400, card.view.startBlocked, { startBlocked: card.view.startBlocked, run: card.view });

  changeRun(r.id, (x) => {
    x.state = "starting";
    delete x.startError;
  });
  try {
    const at = new Date().toISOString();
    const toNew = runsInNewChat(spec, r);
    const root = await projectKeyOf(r.cwd);
    let chat: { id: string; path: string };
    if (toNew) {
      chat = await newChat(deps.request, r.cwd);
      if (spec.run.permissions) {
        const applied = await applyProfile(chat.path, inlineChoice(playbookSnapshot(r, spec, root)), "start");
        if (!applied.ok) throw new Error(`The run's chat was made, but its permissions were not set: ${applied.error}`);
      }
      writeAutoTitle(chat.id, `${r.playbook.title} (playbook)`);
    } else chat = r.shownIn!;
    const main = card.resolved[MAIN_ROLE]?.use ?? null;
    await setUpChat(chat.path, main ? { model: chatRefOf(main), ...(main.effort ? { effort: main.effort } : {}) } : null, spec);

    const folder = runFolderOf(chat.id, r.id);
    const frozen = freezePlan(r, spec, env, card, toNew, at, folder);
    const contents = writeFiles(folder, frozen.files, deps.contents());
    const bundle = { id: loaded.info.id, dir: loaded.info.dir, entry: loaded.info.entry };
    const held = toNew ? null : await acquireChatHandle(chat.path);
    const block = playbookPayload(bundle, held ? { branch: await held.branch(), cwd: held.mirror.cwd || r.cwd } : null).block;
    const text = runMessage(frozen.plan, block, runBlock(frozen.plan, folder, { contents, sovaScript: SOVA_SCRIPT }));
    const sent = await promptSession(chat.path, text);
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
      x.started = started;
      x.plan = { ...frozen.plan, view: { ...frozen.plan.view, state: "started", started, startBlocked: null } };
    });
    // The marks on the chats' own files, best effort: the store is what the card reads.
    const mark = { v: 1 as const, runId: r.id, at, playbook: { source: r.playbook.source, id: r.playbook.id, title: r.playbook.title } };
    void (async () => {
      await (await acquireChatHandle(chat.path)).appendState(PLAYBOOK_RUN, { ...mark, conducts: true });
      if (started.fromChat) await (await acquireChatHandle(started.fromChat.path)).appendState(PLAYBOOK_RUN, { ...mark, conducts: false, chat });
    })().catch((err) => console.warn(`[playbook-runs] ${r.id}: the run's marks were not written: ${err instanceof Error ? err.message : String(err)}`));
    try {
      const e = effectiveEdits(r);
      saveAnswers(answersKey(r.playbook, root), "last", { choices: e.choices ?? {}, ...(e.roles ? { roles: e.roles } : {}), ...(e.stops ? { stops: e.stops } : {}), ...(e.cycle ? { cycle: e.cycle } : {}) });
    } catch (err) {
      console.warn(`[playbook-runs] ${r.id}: the last answers were not saved: ${err instanceof Error ? err.message : String(err)}`);
    }
    return runView(runById(r.id)!);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    changeRun(r.id, (x) => {
      x.state = "draft";
      x.startError = why;
    });
    throw new RunRefused(500, why, { run: await runView(runById(r.id)!) });
  }
}

