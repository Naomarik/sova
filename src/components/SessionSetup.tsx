import { batch, createEffect, createMemo, createSignal, For, Index, Match, on, onCleanup, Show, Switch, untrack } from "solid-js";
import type { GitSummary, SessionSetup, SessionSetupFile, SessionSetupSkill } from "../../shared/protocol";
import { fetchSessionSetup, fetchSessionTools, fetchSetupFile, setFolderApprovals, setSessionLoadout, undoFolderApprovals } from "../lib/api";
import { ABOVE_PROJECT, changedPhrase, decideAll, flipTo, groupDoneLine, groupFlip, groupState, isOn, itemsPhrase, markOf, newOffPhrase, onPhrase, type Approval, type Decidable, type Decision, type ItemKind, type Mark } from "../lib/approvals";
import { acked, begin, EMPTY, failed, inOrder, queueOf, setupHold, readLanded, type Overlay } from "../lib/approval-overlay";
import { keptLine, MCP_THIS_CHAT, rowApproval, SLASH_NOTE, slashHeading, type Row } from "../lib/setup-approvals";
import { ChangedLine, GroupHead, GroupSwitch, NewChip, PartialNote, RowSwitch, showsChanged, showsNew, SizeButton, UndoLine } from "./ApprovalSwitches";
import { askReread, noteSeenNew, rereadAsked, setHold } from "../lib/approval-hold";
import { dropUndo, setUndoLine, undoFor } from "../lib/approval-undo";
import { FolderApprovalsDialog } from "./FolderApprovalsDialog";
import { mcpFlips, NOT_PROJECT, setupLine, setupOffLine, setupShows, setupSwitchLabel, setupTokens, SETUP_LABEL } from "../lib/mcp";
import { openMarkdown } from "../lib/markdown-viewer";
import { loadGitSummary, UPSTREAM_TITLE } from "../lib/git-summary";
import {
  CONTEXT_NONE,
  contextHeading,
  contextNote,
  contextRows,
  contextSum,
  contextSwitchLabel,
  fileFacts,
  gitView,
  isOff,
  isSumEmpty,
  loadoutView,
  offSets,
  OPEN_FILE_FAILED,
  openFileLabel,
  skillProblemsLine,
  skillsHeading,
  skillsNone,
  skillFacts,
  skillsNote,
  skillsSum,
  skillSwitchLabel,
  sumFacts,
  tokenFacts,
  SYSTEM_CONTEXT_LABEL,
  SYSTEM_CONTEXT_TITLE,
  systemContextSum,
} from "../lib/session-setup";
import type { ToolsView } from "../lib/session-tools";
import { createToolsReads } from "../lib/tools-reads";
import { setSetupContextOpen, setupContextOpen } from "../lib/setup-fold";
import { home, toast } from "../lib/ui-state";
import { Icon } from "./ui";
import type { SetupMcp } from "../../shared/mcp";

type Answer<T> = { ok: T } | { error: string };
/** After a saved decision's read failed, the one more read's wait. */
const REREAD_MS = 1500;

/**
 * The setup card of a new, empty session: what pi loads into
 * the prompt, the skills it offers, and the repository around the folder. One aggregate line opens
 * it — the whole loadout, which the Context and Skills sections below add up to — then a section
 * per thing summed, each carrying its own total beside its label. Read once when the empty state
 * appears; nothing here polls or links. The card lands whole, once both reads have answered, so it
 * never grows in two steps under the title.
 *
 * Before the first message of a session this server hosts, each context file and skill row carries
 * a switch (§chat.transcript/setup-card-toggles). `editable` is the chat's own word that the window
 * is open (the Profile picker's: pickable and not locked). A flip sends the whole off set and draws
 * the server's fresh read in place.
 *
 * Everything but Repository is one fold, closed by default, whose summary is the System context
 * line; its open state lives per session in lib/setup-fold, so a redraw after a pick keeps it.
 */
export function SessionSetupCard(props: { path: string; editable?: boolean; toolsKey?: string; /** lib/mcp setupServersKey. */ serversKey?: string }) {
  const [setup, setSetup] = createSignal<Answer<SessionSetup> | null>(null);
  const [git, setGit] = createSignal<Answer<GitSummary> | null>(null);
  const [landed, setLanded] = createSignal(false);
  // `run` is the session being read (a new path, or the card going away, drops every answer in
  // flight); `rev` counts the loadout answers drawn since, so the first read never draws over a
  // newer one (a re-read when the window opened, or a flip's answer).
  let run = 0;
  let rev = 0;
  const settle = <T,>(p: Promise<T>): Promise<Answer<T>> => p.then((ok) => ({ ok }), (err: Error) => ({ error: err.message }));
  // Decisions shown at the click while their save runs (lib/approval-overlay); `reads` numbers the
  // loadout reads started, so only a read that began after a save answered retires its rows.
  const [overlay, setOverlay] = createSignal<Overlay>(EMPTY);
  let reads = 0;
  let saves = 0;
  const readSetup = (p: string, fresh?: boolean): Promise<{ answer: Answer<SessionSetup>; n: number }> => {
    const n = ++reads;
    return settle(fresh ? fetchSessionSetup(p, true) : fetchSessionSetup(p)).then((answer) => ({ answer, n }));
  };
  /** A later read's answer, drawn in place: the rows stay mounted and only what changed redraws. */
  const draw = (next: Answer<SessionSetup>, n: number) =>
    batch(() => {
      rev++;
      setSetup(next);
      setOverlay((o) => readLanded(o, n));
    });
  // The Tools group's reads (§chat.transcript/setup-card-tools): the first is one of the card's three;
  // later ones redraw only the group, an older answer never over a newer one.
  const tools = createToolsReads(fetchSessionTools);
  // A memo, so a new props object for the same session never reads as a new session.
  const path = createMemo(() => props.path);
  createEffect(
    on(path, (p) => {
      const mine = ++run;
      const seen = rev;
      setLanded(false);
      setOverlay(EMPTY);
      tools.reset();
      void Promise.all([readSetup(p), settle(loadGitSummary(p)), tools.read(p)]).then(([{ answer: s, n }, g]) => {
        if (mine !== run) return;
        if (seen === rev) {
          setSetup(s);
          setOverlay((o) => readLanded(o, n));
        }
        setGit(g);
        setLanded(true);
      });
    }),
  );
  onCleanup(() => {
    run++; // an answer that lands after the empty state went writes to nothing
    tools.reset();
  });

  // The chat's model, mode, minor modes, strict flag or connection changed: the declared tools may
  // have, so the Tools group (only) reads again. A memo of a string, so only a new VALUE re-reads.
  const toolsKey = createMemo(() => props.toolsKey);
  createEffect(on(toolsKey, () => void tools.read(path()), { defer: true }));

  // The chat says the window opened after the card read (the runtime wasn't held yet, or it was
  // rebuilt by a flip from another tab): read again, so the switches the server allows appear.
  const editable = createMemo(() => !!props.editable);
  createEffect(
    on(editable, (now, before) => {
      if (!now || before === undefined) return;
      const s = setup();
      if (s && "ok" in s && s.ok.state === "ok" && s.ok.toggleable) return;
      const mine = run;
      void readSetup(path(), true).then(({ answer: next, n }) => {
        if (mine !== run || !("ok" in next)) return;
        draw(next, n);
      });
    }),
  );

  // A profile pick or a sandbox change can move what the server group says: it reads again. The fold
  // and everything else on the card stay as they are.
  const serversKey = createMemo(() => props.serversKey);
  createEffect(
    on(
      serversKey,
      () => {
        const mine = run;
        void readSetup(path(), true).then(({ answer: next, n }) => {
          if (mine !== run || !("ok" in next)) return;
          draw(next, n);
        });
      },
      { defer: true },
    ),
  );

  const [applying, setApplying] = createSignal(false);
  /** A row's name opens its file in the markdown viewer (§chat.transcript/setup-card-open-file):
      read now, never cached; a failure is a toast and the viewer stays shut. */
  const openFile = async (name: string, file: string) => {
    try {
      const r = await fetchSetupFile(path(), file);
      openMarkdown({ title: name, subtitle: r.path, name: r.path, markdown: r.text });
    } catch (err) {
      toast(`${OPEN_FILE_FAILED} ${(err as Error).message}`);
    }
  };
  /** A server's switch (§chat.transcript/setup-card-toggles): this chat's only. It sends the whole set, the
      context files and skills as they stand (none of them flipped for this chat). */
  const flipMcp = (name: string, input: HTMLInputElement) => {
    const on = input.checked;
    const s = setup();
    if (!s || !("ok" in s) || s.ok.state !== "ok" || applying()) return;
    const set = offSets(s.ok);
    const mine = run;
    setApplying(true);
    setSessionLoadout(path(), set.offContext, set.offSkills, mcpFlips(s.ok.mcp, { name, on }))
      .then((next) => {
        if (mine !== run) return;
        rev++;
        setSetup({ ok: next });
      })
      .catch((err: Error) => {
        // Nothing was written: the switch goes back to what the server has.
        input.checked = !on;
        toast(`Couldn't switch that server. ${err.message}`);
      })
      .finally(() => setApplying(false));
  };
  const switchable = () => {
    const s = setup();
    return !!props.editable && !!s && "ok" in s && s.ok.state === "ok" && !!s.ok.toggleable;
  };

  /** This new chat's list (whose decisions its rows make) while it can still change, else null. */
  const approvals = () => {
    const s = setup();
    return switchable() && s && "ok" in s && s.ok.state === "ok" ? (s.ok.approvals ?? null) : null;
  };
  /** New items start off (the Sova-wide setting): marks are drawn, and turning on approves. */
  const asking = () => !!approvals()?.asking;
  /** The folder whose list this chat's rows belong to, before or after its first message. */
  const listFolder = () => {
    const s = setup();
    return s && "ok" in s && s.ok.state === "ok" ? (s.ok.approvals?.folder ?? null) : null;
  };
  const [folderOpen, setFolderOpen] = createSignal(false);
  /** A row's decision as shown: the one flipped here while it saves, else the server's. */
  const shownApproval = (f: SessionSetupFile): Approval => {
    const p = f.approval ? overlay()[f.approval.key] : undefined;
    return p ? p.to : rowApproval(f);
  };
  /** Whether a row reads as on: what it will be once its flip is saved, else what this chat loads. */
  const shownOn = (f: SessionSetupFile): boolean => {
    const p = f.approval ? overlay()[f.approval.key] : undefined;
    return p ? isOn(p.to, asking()) : !isOff(f);
  };
  const markShown = (f: SessionSetupFile): Mark | null => (approvals() && f.approval ? markOf(shownApproval(f), asking()) : null);
  /** The rows a group switch covers: each with a decision in the folder's list. */
  const decidable = (rows: Row[]) => rows.filter((r) => !!r.f.approval);
  const asDecidable = (rows: Row[]): (Decidable & { row: Row })[] =>
    decidable(rows).map((r) => ({ kind: r.kind, key: r.f.approval!.key, approval: shownOn(r.f) ? ("approved" as const) : ("disallowed" as const), row: r }));

  // The line a group press leaves (lib/approval-undo, one per folder), with its Undo; the next change in
  // that group drops it.
  const undoOf = (kind: ItemKind) => {
    const a = approvals();
    return a ? undoFor(queueOf(a.folder), `setup:${kind}`) : null;
  };
  const [undoing, setUndoing] = createSignal(false);
  /**
   * The rows show the flip at once (lib/approval-overlay) and the save runs behind them, in click
   * order with the folder's other saves; every row stays clickable meanwhile. Send says "Saving…"
   * until the server has it and a read started after its answer is back (the save answers once this
   * chat is rebuilt with it). A refusal or failure puts the rows back with its toast. Nothing loads
   * on the overlay: the server decides what loads.
   */
  const save = (rows: Row[], to: Decision, what: string, group?: { kind: ItemKind; text: string }) => {
    const s = setup();
    const a = approvals();
    if (!a || !s || !("ok" in s) || !rows.length) return;
    const mine = run;
    const id = ++saves;
    const cwd = s.ok.cwd;
    const queue = queueOf(a.folder);
    // Any change in a group drops its Undo line; a group save's answer replaces the folder's one Undo.
    for (const kind of new Set(rows.map((r) => r.kind))) dropUndo(queue, `setup:${kind}`);
    setOverlay((o) => begin(o, rows.map((r) => r.f.approval!.key), to, id));
    const pick = (kind: ItemKind) => decideAll(rows.filter((r) => r.kind === kind).map((r) => ({ key: r.f.approval!.key })), to);
    // An answer after its time (its rows went back): the setup is read again to show what the server did.
    const p = path();
    inOrder(queue, () => setFolderApprovals(cwd, { files: pick("context"), skills: pick("skill"), ...(group ? { group: true as const } : {}) }), { late: () => askReread(p) })
      .then((answer) => {
        if (group && answer.undo) setUndoLine({ queue, group: `setup:${group.kind}`, text: group.text, token: answer.undo });
        if (mine !== run) return;
        setOverlay((o) => acked(o, id, reads));
        return rereadAfterSave(mine);
      })
      .catch((err: Error) => {
        if (mine !== run) return;
        setOverlay((o) => failed(o, id));
        toast(`Couldn't save ${what} for ${a.folder.name}. ${err.message}`);
      });
  };
  /** After a save the setup is read again; a failed read is tried once more here, then the rebuild's
      own broadcast and each hello read it again. */
  const rereadAfterSave = (mine: number) => {
    const reread = (again: boolean): Promise<void> =>
      readSetup(path(), true).then(({ answer: next, n }) => {
        if (mine !== run) return;
        if ("ok" in next) draw(next, n);
        else if (again) setTimeout(() => void reread(false), REREAD_MS);
      });
    return reread(true);
  };
  /** One row's switch: the folder's decision for its new chats. */
  const flip = (r: Row, on: boolean, label: string) => save([r], flipTo(on, asking()), label);
  /** A group's switch: from off or mixed every row on, from on every row off; only the rows that change are saved. */
  const flipGroup = (kind: ItemKind, rows: Row[]) => {
    const g = groupFlip(asDecidable(rows), asking());
    if (!g.rows.length) return;
    save(
      g.rows.map((d) => d.row),
      g.to,
      itemsPhrase(kind === "context" ? g.rows.length : 0, kind === "skill" ? g.rows.length : 0),
      { kind, text: groupDoneLine(g.rows.length, kind, g.on) },
    );
  };
  /** Undo: every switch of that group press back exactly as it was (the server keeps what it was). */
  const runUndo = (kind: ItemKind) => {
    const u = undoOf(kind);
    const s = setup();
    if (!u || !s || !("ok" in s) || undoing()) return;
    const mine = run;
    const cwd = s.ok.cwd;
    setUndoing(true);
    inOrder(u.queue, () => undoFolderApprovals(cwd, u.token), { late: () => askReread(path()) })
      .then(() => {
        dropUndo(u.queue);
        if (mine !== run) return;
        return rereadAfterSave(mine);
      })
      .catch((err: Error) => {
        // Gone (a newer group save, a restart): the line goes, the toast says nothing changed.
        dropUndo(u.queue);
        toast(err.message);
        if (mine === run) askReread(path());
      })
      .finally(() => setUndoing(false));
  };
  // The composer's "Saving…" (lib/approval-hold) while a flip made here isn't saved and read back.
  createEffect(() => setHold(path(), setupHold(overlay())));
  onCleanup(() => setHold(untrack(path), null));
  // A decision made elsewhere (another tab, the project page) or a send refused: read again.
  createEffect(
    on(rereadAsked, (ask) => {
      if (!ask || ask.path !== untrack(path)) return;
      const mine = run;
      void readSetup(ask.path, true).then(({ answer: next, n }) => {
        if (mine !== run || !("ok" in next)) return;
        draw(next, n);
      });
    }, { defer: true }),
  );
  let card: HTMLElement | undefined;
  /** The marks and the one button under a row's name. */
  const RowMarks = (rp: { r: Row; label: string }) => (
    <>
      <Show when={showsChanged(markShown(rp.r.f)) && shownOn(rp.r.f)}>
        <ChangedLine name={rp.label} onAccept={() => save([rp.r], "approved", rp.label)} />
      </Show>
      <Show when={approvals() && rp.r.f.approval?.fingerprintPartial}>
        <PartialNote />
      </Show>
    </>
  );
  /** A row's switch, while this chat's list can still change. */
  const RowToggle = (rp: { r: Row; label: string; switchLabel: string }) => (
    <Show when={approvals() && rp.r.f.approval}>
      <RowSwitch class="setup-toggle" label={rp.switchLabel} on={shownOn(rp.r.f)} onFlip={(on) => flip(rp.r, on, rp.label)} />
    </Show>
  );

  const view = () => {
    const s = setup();
    return s && "ok" in s ? loadoutView(s.ok) : null;
  };
  const mcp = () => {
    const s = setup();
    const m = s && "ok" in s ? s.ok.mcp : undefined;
    return setupShows(m) ? m : null;
  };
  const groups = () => {
    const v = view();
    return v?.kind === "groups" ? v.setup : null;
  };
  // The fold's summary: the card's one aggregate line, which the sections inside add up to. Empty
  // files sum to zero, and a zero figure says nothing the sections don't, so it reads just the label.
  const whole = createMemo(() => {
    const g = groups();
    const sum = g ? systemContextSum(g) : null;
    return sum && !isSumEmpty(sum) ? sum : null;
  });
  const [foldOpen, setFoldOpen] = createSignal(setupContextOpen(props.path));
  createEffect(on(path, (p) => setFoldOpen(setupContextOpen(p)), { defer: true }));
  /** The folded line's words: what a new chat starts with, then how many new items stay off and how
      many changed (marks only while new items start off). */
  const folded = createMemo(() => {
    const g = groups();
    if (!g) return null;
    const all = [...g.context, ...g.skills];
    return {
      files: g.context.filter((f) => shownOn(f)).length,
      skills: g.skills.filter((k) => !k.manualOnly && shownOn(k)).length,
      fresh: all.filter((f) => showsNew(markShown(f)) && !shownOn(f)).length,
      changed: all.filter((f) => showsChanged(markShown(f)) && shownOn(f)).length,
    };
  });
  // The New rows the open list showed: once this chat's first message goes in, each still New counts
  // as left off (lib/approval-hold settles them). Rows no longer New drop out.
  createEffect(() => {
    const g = groups();
    const a = approvals();
    const s = setup();
    if (!g || !a || !s || !("ok" in s)) return;
    const fresh = [...g.context.map((f) => ({ kind: "context" as const, f })), ...g.skills.map((f) => ({ kind: "skill" as const, f }))]
      .filter((r) => r.f.approval && showsNew(markShown(r.f)) && !shownOn(r.f))
      .map((r) => ({ kind: r.kind, key: r.f.approval!.key }));
    noteSeenNew(path(), { cwd: s.ok.cwd, queue: queueOf(a.folder), fresh, open: foldOpen() });
  });

  return (
    <Show when={landed()}>
      <section ref={card} class="setup-card" aria-label="Session setup">
        <details
          class="setup-context"
          open={foldOpen()}
          onToggle={(e) => {
            const now = e.currentTarget.open;
            setSetupContextOpen(path(), now);
            setFoldOpen(now);
          }}
        >
          <summary class="setup-group setup-context-head" title={SYSTEM_CONTEXT_TITLE}>
            <span class="setup-sum">
              <span class="setup-context-title">
                <Icon name="chevron-right" small class="icon-twist" />
                <span class="setup-sum-label">{SYSTEM_CONTEXT_LABEL}</span>
              <Show when={folded()}>
                {(f) => (
                  <span class="setup-sum-parts">
                    <span class="setup-sum-sep" aria-hidden="true">
                      ·
                    </span>
                    <span>{onPhrase(f().files, f().skills)}</span>
                    <Show when={f().fresh > 0}>
                      <span class="setup-sum-sep" aria-hidden="true">
                        ·
                      </span>
                      <span class="setup-sum-new">
                        <i class="chip-dot" />
                        {newOffPhrase(f().fresh)}
                      </span>
                    </Show>
                    <Show when={f().changed > 0}>
                      <span class="setup-sum-sep" aria-hidden="true">
                        ·
                      </span>
                      <span class="setup-sum-changed">
                        <span aria-hidden="true">◆</span>
                        {changedPhrase(f().changed)}
                      </span>
                    </Show>
                  </span>
                )}
              </Show>
              </span>
              <Show when={whole()}>{(w) => <span class="setup-sum-facts">{w().tokens !== null ? tokenFacts(w().tokens!) : sumFacts(w())}</span>}</Show>
            </span>
          </summary>
          <Switch>
            <Match when={setup() && "error" in setup()! && (setup() as { error: string })}>
              {(e) => (
                <div class="setup-group">
                  <p class="setup-note">Couldn't read what pi loads here. {e().error}</p>
                </div>
              )}
            </Match>
            <Match when={groups()}>
              {(s) => {
                const rows = createMemo(() => contextRows(s(), home()));
                const context = createMemo(() => contextSum(s()));
                const skills = createMemo(() => skillsSum(s()));
                const offered = createMemo(() => s().skills.filter((k) => !k.manualOnly));
                const slash = createMemo(() => s().skills.filter((k) => k.manualOnly));
                const contextItems = createMemo((): Row[] => rows().filter((r) => r.switchable).map((r) => ({ kind: "context" as const, f: r.file })));
                const skillItems = createMemo((): Row[] => offered().map((k) => ({ kind: "skill" as const, f: k })));
                const groupOf = (items: Row[]) => groupState(asDecidable(items), asking());
                const skillsOn = () => offered().filter((k) => shownOn(k)).length;
                return (
                  <>
                    <GroupHead title={contextHeading(rows().length)} facts={!isSumEmpty(context()) ? sumFacts(context()) : undefined}>
                      <Show when={approvals() && decidable(contextItems()).length > 0}>
                        <GroupSwitch label="All context files" state={groupOf(contextItems())} onPress={() => flipGroup("context", contextItems())} />
                      </Show>
                    </GroupHead>
                    <Show when={undoOf("context")}>{(u) => <UndoLine text={u().text} busy={undoing()} onUndo={() => runUndo("context")} />}</Show>
                    <div class="setup-group setup-group-rows">
                      <Show when={rows().length > 0} fallback={<p class="setup-note">{CONTEXT_NONE}</p>}>
                        <p class="setup-note">{contextNote(s())}</p>
                        <ul class="setup-list">
                          <Index each={rows()}>
                            {(r) => (
                              <li class="setup-row" classList={{ "setup-row-off": !shownOn(r().file) }} title={r().file.path}>
                                <span class="setup-name">
                                  <button class="setup-path setup-open" type="button" aria-label={openFileLabel(r().label)} onClick={() => void openFile(r().label, r().file.path)}>
                                    {r().label}
                                  </button>
                                  <Show when={showsNew(markShown(r().file))}>
                                    <NewChip />
                                  </Show>
                                  <Show when={r().role ?? (r().file.approval?.group === "above" ? ABOVE_PROJECT : undefined)}>{(role) => <span class="setup-role">{role()}</span>}</Show>
                                </span>
                                <span class="setup-facts">{fileFacts(r().file)}</span>
                                <Show when={r().switchable}>
                                  <RowToggle r={{ kind: "context", f: r().file }} label={r().label} switchLabel={contextSwitchLabel(r().label)} />
                                </Show>
                                <RowMarks r={{ kind: "context", f: r().file }} label={r().label} />
                              </li>
                            )}
                          </Index>
                        </ul>
                      </Show>
                    </div>
                    <GroupHead
                      title={skillsHeading(offered().length)}
                      facts={offered().length > 0 ? [`${skillsOn()} of ${offered().length} on`, ...(skills().tokens ? [`${tokenFacts(skills().tokens!)} of descriptions`] : [])].join(" · ") : undefined}
                    >
                      <Show when={approvals() && decidable(skillItems()).length > 0}>
                        <GroupSwitch label="All skills" state={groupOf(skillItems())} onPress={() => flipGroup("skill", skillItems())} />
                      </Show>
                    </GroupHead>
                    <Show when={undoOf("skill")}>{(u) => <UndoLine text={u().text} busy={undoing()} onUndo={() => runUndo("skill")} />}</Show>
                    <div class="setup-group setup-group-rows">
                      <Show when={offered().length > 0} fallback={<p class="setup-note">{skillsNone(s())}</p>}>
                        <p class="setup-note">{skillsNote(s())}</p>
                        <ul class="setup-list">
                          <Index each={offered()}>
                            {(k) => (
                              <li class="setup-row" classList={{ "setup-row-off": !shownOn(k()) }} title={k().description ? `${k().path}\n${k().description}` : k().path}>
                                <span class="setup-name">
                                  <button class="setup-path setup-open" type="button" aria-label={openFileLabel(k().name)} onClick={() => void openFile(k().name, k().path)}>
                                    {k().name}
                                  </button>
                                  <Show when={showsNew(markShown(k()))}>
                                    <NewChip />
                                  </Show>
                                </span>
                                <SkillFigure skill={k()} />
                                <RowToggle r={{ kind: "skill", f: k() }} label={k().name} switchLabel={skillSwitchLabel(k().name)} />
                                <RowMarks r={{ kind: "skill", f: k() }} label={k().name} />
                              </li>
                            )}
                          </Index>
                        </ul>
                      </Show>
                      <Show when={skillProblemsLine(s())}>{(line) => <p class="setup-note">{line()}</p>}</Show>
                    </div>
                    <Show when={slash().length > 0}>
                      <div class="setup-group setup-group-rows setup-slash">
                        <p class="setup-slash-head">
                          <span class="text-eyebrow">{slashHeading(slash().length)}</span>
                          <span class="setup-note">{SLASH_NOTE}</span>
                        </p>
                        <ul class="setup-list">
                          <Index each={slash()}>
                            {(k) => (
                              <li class="setup-row" classList={{ "setup-row-off": !shownOn(k()) }} title={k().path}>
                                <span class="setup-name">
                                  <button class="setup-path setup-open" type="button" aria-label={openFileLabel(k().name)} onClick={() => void openFile(k().name, k().path)}>
                                    /skill:{k().name}
                                  </button>
                                  <Show when={showsNew(markShown(k()))}>
                                    <NewChip />
                                  </Show>
                                  <Show when={k().description}>{(d) => <span class="setup-slash-desc">{d()}</span>}</Show>
                                </span>
                                <RowToggle r={{ kind: "skill", f: k() }} label={k().name} switchLabel={skillSwitchLabel(k().name)} />
                                <RowMarks r={{ kind: "skill", f: k() }} label={k().name} />
                              </li>
                            )}
                          </Index>
                        </ul>
                      </div>
                    </Show>
                    <Show when={listFolder()}>
                      {(f) => (
                        <div class="setup-group setup-list-link">
                          <p class="setup-note">{keptLine(f().kind, approvals()?.asking)}</p>
                          <Show
                            when={f().kind === "project" && (f() as { id: string })}
                            fallback={
                              <button type="button" class="button button-sm button-ghost" onClick={() => setFolderOpen(true)}>
                                Edit Folder List
                              </button>
                            }
                          >
                            {(p) => (
                              <a class="button button-sm button-ghost" href={`#/projects/${encodeURIComponent(p().id)}/settings`}>
                                Open Project Settings
                              </a>
                            )}
                          </Show>
                        </div>
                      )}
                    </Show>
                  </>
                );
              }}
            </Match>
            <Match when={view()?.kind === "line" && (view() as { kind: "line"; text: string })}>
              {(v) => (
                <div class="setup-group">
                  <p class="setup-note">{v().text}</p>
                </div>
              )}
            </Match>
          </Switch>
          <Show when={tools.view()}>
            {(v) => (
              <div class="setup-group">
                <ToolsGroup view={v()} open={tools.groupOpen()} onToggle={tools.setGroupOpen} isOpen={tools.isOpen} onToggleRow={tools.flip} />
              </div>
            )}
          </Show>
          <Show when={mcp()}>
            {(m) => (
              <div class="setup-group">
                <McpGroup mcp={m()} switchable={switchable()} applying={applying()} onFlip={flipMcp} />
              </div>
            )}
          </Show>
        </details>
        <div class="setup-group">
          <h2 class="text-eyebrow setup-label">Repository</h2>
          <GitFacts answer={git()!} />
        </div>
        <Show when={folderOpen() && listFolder()?.kind === "folder" && setup()}>
          {(sv) => {
            const ok = sv() as { ok: { cwd: string } };
            return (
              <FolderApprovalsDialog
                cwd={ok.ok.cwd}
                name={listFolder()!.name}
                onClose={() => setFolderOpen(false)}
                onChanged={() => askReread(path())}
              />
            );
          }}
        </Show>
      </section>
    </Show>
  );
}

/** A skill row's figure: its listing, what every chat carries. With a listing size its detail opens
    as the design system's popover (description and SKILL.md); without one, the figure alone. */
function SkillFigure(props: { skill: SessionSetupSkill }) {
  return (
    <Show when={typeof props.skill.listingTokens === "number" && props.skill} fallback={<span class="setup-facts">{skillFacts(props.skill)}</span>}>
      {(k) => (
        <SizeButton
          text={skillFacts(k())}
          title={k().name}
          facts={[
            { label: "Description", when: "in every chat", value: tokenFacts(k().listingTokens!) },
            ...(typeof k().tokens === "number" ? [{ label: "SKILL.md", when: "when used", value: tokenFacts(k().tokens!) }] : []),
          ]}
        />
      )}
    </Show>
  );
}

/** The Tools group (§chat.transcript/setup-card-tools): a disclosure, closed by default, of one
    disclosure per tool; or, when they aren't listed, the plain heading and one line. */
function ToolsGroup(props: {
  view: ToolsView;
  open: boolean;
  onToggle: (open: boolean) => void;
  isOpen: (key: string) => boolean;
  onToggleRow: (key: string, open: boolean) => void;
}) {
  const list = () => (props.view.kind === "list" ? props.view : null);
  return (
    <Show
      when={list()}
      fallback={
        <>
          <h2 class="text-eyebrow setup-label">{props.view.heading}</h2>
          <p class="setup-note">{(props.view as { text: string }).text}</p>
        </>
      }
    >
      {(v) => (
        <details class="setup-tools" open={props.open} onToggle={(e) => props.onToggle(e.currentTarget.open)}>
          <summary class="setup-head setup-tools-head">
            <span class="setup-tools-title">
              <Icon name="chevron-right" small class="icon-twist" />
              <h2 class="text-eyebrow setup-label">{v().heading}</h2>
            </span>
            <span class="setup-total">{v().total}</span>
          </summary>
          <div class="setup-tools-body">
            <p class="setup-note">{v().note}</p>
            <ul class="setup-list">
              <For each={v().rows}>
                {(r) => (
                  <li>
                    <details class="setup-tool" open={props.isOpen(r.key)} onToggle={(e) => props.onToggleRow(r.key, e.currentTarget.open)}>
                      <summary class="setup-row setup-tool-head">
                        <span class="setup-name">
                          <Icon name="chevron-right" small class="icon-twist" />
                          <span class="setup-path">{r.name}</span>
                          <span class="setup-role">{r.source}</span>
                        </span>
                        <span class="setup-facts">{r.facts}</span>
                      </summary>
                      <p class="setup-tool-desc">{r.description}</p>
                    </details>
                  </li>
                )}
              </For>
            </ul>
          </div>
        </details>
      )}
    </Show>
  );
}

/** The MCP Servers group (§chat.transcript/setup-card-toggles): one row per server this chat could
    list, or one line. It adds nothing to the System context figures. */
function McpGroup(props: { mcp: SetupMcp; switchable: boolean; applying: boolean; onFlip: (name: string, input: HTMLInputElement) => void }) {
  return (
    <>
      <h2 class="text-eyebrow setup-label">{SETUP_LABEL}</h2>
      {/* Unlike context files and skills (kept for the folder), a server's switch is this chat's own. */}
      <Show when={props.switchable && !setupLine(props.mcp) && props.mcp.rows.some((r) => !r.off)}>
        <p class="setup-note">{MCP_THIS_CHAT}</p>
      </Show>
      <Show
        when={setupLine(props.mcp)}
        fallback={
          <>
            <Show when={props.mcp.notProject}>
              <p class="setup-note">{NOT_PROJECT}</p>
            </Show>
            <ul class="setup-list">
              <For each={props.mcp.rows}>
                {(r) => (
                  <li class="setup-row" classList={{ "setup-row-off": !!r.off || !r.on }}>
                    <span class="setup-name">
                      <span class="setup-path">{r.name}</span>
                    </span>
                    <Show when={setupOffLine(r)} fallback={<span class="setup-facts">{setupTokens(r.tokens)}</span>}>
                      {(why) => <span class="setup-role">{why()}</span>}
                    </Show>
                    <Show when={props.switchable && !r.off}>
                      <label class="toggle toggle-switch setup-toggle">
                        <input type="checkbox" aria-label={setupSwitchLabel(r.name)} checked={r.on} disabled={props.applying} onChange={(e) => props.onFlip(r.name, e.currentTarget)} />
                        <span class="toggle-box" />
                      </label>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </>
        }
      >
        {(line) => <p class="setup-note">{line()}</p>}
      </Show>
    </>
  );
}

function GitFacts(props: { answer: Answer<GitSummary> }) {
  const view = () => ("ok" in props.answer ? gitView(props.answer.ok, home(), Date.now()) : null);
  const repo = () => {
    const v = view();
    return v?.kind === "repo" ? v : null;
  };
  return (
    <Switch>
      <Match when={"error" in props.answer && (props.answer as { error: string })}>
        {(e) => <p class="setup-note">Couldn't read this session's repository. {e().error}</p>}
      </Match>
      <Match when={view()?.kind === "line" && (view() as { kind: "line"; text: string })}>
        {(v) => <p class="setup-note">{v().text}</p>}
      </Match>
      <Match when={repo()}>
        {(v) => (
          <>
            <p class="setup-git">
              <Icon name="branch" small />
              <span class="setup-git-head">{v().head}</span>
              <Show when={v().upstream}>
                {(u) => (
                  <>
                    <span class="setup-sep">·</span>
                    <span title={UPSTREAM_TITLE}>{u()}</span>
                  </>
                )}
              </Show>
            </p>
            <p class="setup-git">
              <Icon name="file" small />
              <span>{v().changes}</span>
              <Show when={v().lines}>
                {(l) => (
                  <span class="setup-num">
                    <span class="setup-add">+{l().added}</span> <span class="setup-del">−{l().removed}</span>
                  </span>
                )}
              </Show>
            </p>
            <Show when={v().commits.length > 0} fallback={<Show when={v().noCommit}>{(t) => <p class="setup-note">{t()}</p>}</Show>}>
              <ul class="setup-list setup-commits">
                <For each={v().commits}>
                  {(c) => (
                    <li class="setup-git setup-commit">
                      <Icon name="clock" small />
                      <span class="setup-oid">{c.oid}</span>
                      <span class="setup-subject" title={c.subject}>
                        {c.subject}
                      </span>
                      <span class="setup-ago">{c.ago}</span>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <Show when={v().gitFolder}>
              {(f) => (
                <>
                  <p class="setup-git setup-gitdir" title={f().title}>
                    <Icon name="folder" small />
                    <span>{f().label}</span>
                    <span class="setup-num">{f().size}</span>
                  </p>
                  <Show when={f().warning}>
                    {(w) => (
                      <p class="setup-git setup-gitdir-warn" title={w().title ?? undefined}>
                        <Icon name="alert-circle" small />
                        <span>{w().text}</span>
                      </p>
                    )}
                  </Show>
                </>
              )}
            </Show>
            <Show when={v().note}>{(n) => <p class="setup-note">{n()}</p>}</Show>
          </>
        )}
      </Match>
    </Switch>
  );
}
