import { createEffect, createMemo, createResource, createSignal, For, Index, Match, on, Show, Switch } from "solid-js";
import type { SessionSkills, TeamInfo, WorkerInfo } from "../../shared/protocol";
import { fetchHiddenWorkers, fetchSessionContextView, fetchSetupFile } from "../lib/api";
import { relativeTime } from "../lib/format";
import { overviewMeta, readBeforeCompaction, skillsOverview, type SkillOverviewRow, type SkillReaderSource } from "../lib/skills-overview";
import {
  approxTokens,
  contextHeadline,
  contextLayout,
  contextRoom,
  flatParts,
  groupSheet,
  inWindow,
  meterShares,
  OTHER_META,
  partLang,
  partMeta,
  partNote,
  partOpens,
  partSubtitle,
  shareOf,
  workerReplyKey,
  type ContextLine,
  type ContextLineKind,
  type ContextPart,
} from "../lib/context-parts";
import { ForKey } from "../lib/for-key";
import { fileShape, type FileShape, type MarkdownView } from "../lib/markdown-viewer";
import { OPEN_FILE_FAILED } from "../lib/session-setup";
import { toast } from "../lib/ui-state";
import { workerLabel } from "../lib/workers";
import { ReaderDoc, ReaderTools } from "./ReaderDoc";
import { Icon } from "./ui";
import "./ContextTab.css";

/** A part as read when its level opened: never read again while it stays open. */
interface Doc {
  shape: FileShape;
  markdown: string;
}
/** One level of the sheet: a group, a part of one with its text, or (Everyone) one skill's readers. */
type Level =
  | { line: ContextLineKind; label: string }
  | { line: ContextLineKind; label: string; part: ContextPart; doc: Doc }
  | { skill: string; label: string };
type GroupLevelOf = Extract<Level, { line: ContextLineKind }>;
const isPart = (l: Level): l is Extract<Level, { part: ContextPart }> => "part" in l;
const isSkill = (l: Level): l is Extract<Level, { skill: string }> => "skill" in l;

/** Whose context's value for Everyone: never a session path. */
const EVERYONE = ":everyone";

/** A row's size: a file or skill not in the window yet shows what it would add, and a skill /skill: ran
    unoffered has no listing there at all. */
const sizeOf = (p: ContextPart) => (inWindow(p) ? approxTokens(p.tokens) : p.group === "skills" && p.read ? approxTokens(0) : `+${approxTokens(p.tokens)}`);
/** Paths and tool names are machine names. */
const monoName = (p: ContextPart) => p.group === "instructions" || p.group === "subfolder" || p.group === "tools";

/**
 * The Context tab: what fills this chat's window (or one of its workers'), as of the last reply.
 * The total is the reply's own usage; each part is an estimate, and Other is what the estimates
 * don't explain. Every top line is a group and opens the same way, whatever it holds: one sheet
 * over the tab, with a breadcrumb and Back, where a group lists its parts and a part reads in
 * place. It reads once on open and again on each change to the session's file (`changed`, the pane's
 * insight signal) and, for a picked worker, when one of its replies ends (`workerReplyKey`); never
 * polls. A part open in the sheet isn't read again.
 */
export function ContextTab(props: {
  path: string;
  workers: WorkerInfo[];
  teams?: TeamInfo[];
  changed: number;
  /** This chat's whole-history skills record (the insight's `skills`). */
  skills?: SessionSkills;
  /** Each worker's, by worker id (the insight's `workerSkills`): every worker of the chat, not only the listed ones. */
  workerSkills?: Record<string, SessionSkills>;
}) {
  /** Workers the insight's list leaves out but whose skills it sends, read from the session file once Everyone
      needs their names. Kept per chat, so a reader picked from Everyone stays in Whose context. */
  const [unlisted, setUnlisted] = createSignal<{ path: string; workers: WorkerInfo[] } | null>(null);
  const pickable = createMemo(() => {
    const listed = props.workers.filter((w) => w.sessionFile);
    const more = unlisted();
    if (!more || more.path !== props.path) return listed;
    const ids = new Set(listed.map((w) => w.id));
    return [...listed, ...more.workers.filter((w) => w.sessionFile && !ids.has(w.id))];
  });
  const [who, setWho] = createSignal(props.path);
  const everyone = () => who() === EVERYONE && pickable().length > 0;
  /** The session read: this chat, or the picked worker while it is still listed. */
  const target = createMemo(() => (pickable().some((w) => w.sessionFile === who()) ? who() : props.path));
  /** What the tab shows: Everyone, or one chat's window. */
  const shown = createMemo(() => (everyone() ? EVERYONE : target()));
  /** A picked worker's own reply-end signal: its replies don't move the parent's file. */
  const workerKey = createMemo(() => workerReplyKey(pickable().find((w) => w.sessionFile === target())));
  const [view] = createResource(
    () => (everyone() ? null : `${props.changed}\u0002${workerKey()}\u0001${target()}`),
    (key) => fetchSessionContextView(key.slice(key.indexOf("\u0001") + 1)),
  );
  const ok = createMemo(() => {
    const v = view.latest;
    return v?.state === "ok" ? v : null;
  });
  /** The whole-history record of the chat whose window shows. */
  const historyOf = (path: string) => {
    if (path === props.path) return props.skills;
    const w = pickable().find((x) => x.sessionFile === path);
    return w ? props.workerSkills?.[w.id] : undefined;
  };
  const layout = createMemo(() => {
    const v = ok();
    if (!v) return null;
    const used = historyOf(target())?.used;
    // A skill read only before the latest compaction says so instead of Not read yet.
    const parts = flatParts(v).map((p) => (readBeforeCompaction(p, used) ? { ...p, readBefore: true } : p));
    return contextLayout({ parts, conversation: v.conversation, total: v.total, window: v.window });
  });

  // ---- Everyone ------------------------------------------------------------------------------
  /** Worker ids with a skills record the list can't name yet. */
  const unnamed = createMemo(() => {
    if (!everyone()) return "";
    const known = new Set(pickable().map((w) => w.id));
    return Object.keys(props.workerSkills ?? {}).filter((id) => !known.has(id)).sort().join("\n");
  });
  createEffect(
    on(unnamed, (ids) => {
      if (!ids) return;
      const path = props.path;
      fetchHiddenWorkers(path)
        .then((res) => {
          if (path === props.path) setUnlisted({ path, workers: res.workers });
        })
        .catch(() => {}); // unnamed workers stay out until the next try: the counts of the rest still stand
    }),
  );
  const sources = createMemo<SkillReaderSource[]>(() => [
    { key: props.path, label: "This chat", skills: props.skills },
    ...pickable().flatMap((w) => (props.workerSkills?.[w.id] ? [{ key: w.sessionFile!, label: workerLabel(w, props.teams), skills: props.workerSkills[w.id] }] : [])),
  ]);
  const overview = createMemo(() => skillsOverview(sources()));
  const skillRow = (id: string) => overview().read.find((r) => r.id === id);
  const windowSize = () => ok()?.window ?? null;
  const lineOf = (id: ContextLineKind) => layout()?.lines.find((l) => l.id === id);

  // ---- The sheet ---------------------------------------------------------------------------
  const [stack, setStack] = createSignal<Level[]>([]);
  const [docView, setDocView] = createSignal<MarkdownView>("rendered");
  let root!: HTMLDivElement;
  let picker: HTMLSelectElement | undefined;
  let back: HTMLButtonElement | undefined;
  let body: HTMLDivElement | undefined;
  /** Bumped by every move, so a slow read that lands after the reader moved on opens nothing. */
  let moves = 0;

  const focusKey = (key: string) => queueMicrotask(() => root?.querySelector<HTMLElement>(`[data-ctx-key="${CSS.escape(key)}"]`)?.focus());
  const opened = () =>
    queueMicrotask(() => {
      if (body) body.scrollTop = 0;
      back?.focus();
    });
  /** Back to `depth` levels (0 closes the sheet); focus returns to the row the first left level was opened from. */
  const backTo = (depth: number) => {
    moves++;
    const left = stack()[depth];
    if (!left) return;
    setStack(stack().slice(0, depth));
    focusKey(isPart(left) ? `part:${left.part.id}` : isSkill(left) ? `skill:${left.skill}` : `line:${left.line}`);
    if (depth > 0) queueMicrotask(() => body && (body.scrollTop = 0));
  };
  const openLine = (l: ContextLine) => {
    moves++;
    setStack([{ line: l.id, label: l.label }]);
    opened();
  };
  const openSkill = (r: SkillOverviewRow) => {
    moves++;
    setStack([{ skill: r.id, label: r.name }]);
    opened();
  };
  const openPart = async (l: GroupLevelOf, p: ContextPart) => {
    const mine = ++moves;
    let text: string;
    if (p.text !== undefined) text = p.text;
    else if (p.path !== undefined) {
      try {
        text = (await fetchSetupFile(target(), p.path)).text;
      } catch (err) {
        toast(`${OPEN_FILE_FAILED} ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      if (mine !== moves) return;
    } else return;
    setDocView("rendered");
    setStack([...stack(), { line: l.line, label: l.label, part: p, doc: { markdown: text, shape: fileShape(p.path ?? p.id, text, partLang(p)) } }]);
    opened();
  };
  // Another chat or window closes the sheet; so does a fresh read whose group is gone.
  createEffect(on(shown, () => setStack([]), { defer: true }));
  createEffect(() => {
    const first = stack()[0];
    if (!first) return;
    if (isSkill(first) ? !skillRow(first.skill) : layout() && !lineOf(first.line)) setStack([]);
  });
  const onSheetKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    // Taken here, so the pane (which closes on Escape) sees it handled.
    e.preventDefault();
    backTo(stack().length - 1);
  };

  // ---- Rows ---------------------------------------------------------------------------------
  /** One row, the same for a group and a part: name, short line, share of the window, ≈ size, and an
      arrow only when it opens. */
  const Row = (r: { key: string; name: string; mono?: boolean; chip?: { word: string; done: boolean }; beside?: string; meta?: string; share: number | null; size: string; opens: boolean; onOpen?: () => void; label?: string; noSheet?: boolean }) => {
    const inner = () => (
      <>
        <span class="list-main context-row-main">
          <span class="list-title context-row-name" classList={{ "text-mono": !!r.mono }}>
            {r.name}
          </span>
          <Show when={r.chip || r.meta}>
            <span class="context-row-meta">
              <Show when={r.chip}>
                {(c) => (
                  <span class={c().done ? "chip chip-count chip-success" : "chip chip-count"}>
                    <span class="chip-dot" />
                    {c().word}
                  </span>
                )}
              </Show>
              <Show when={r.beside}>
                <span class="context-row-beside">{r.beside}</span>
              </Show>
              <Show when={r.meta}>
                <span class="context-row-meta-text">{r.meta}</span>
              </Show>
            </span>
          </Show>
          <Show when={r.share !== null}>
            <span class="context-share" aria-hidden="true">
              <span style={{ width: `${r.share}%` }} />
            </span>
          </Show>
        </span>
        <span class="context-row-size">{r.size}</span>
        <Show when={r.opens} fallback={<span class="context-row-chevron" aria-hidden="true" />}>
          <Icon name="chevron-right" small class="context-row-chevron" />
        </Show>
      </>
    );
    return (
      <li>
        <Show when={r.opens} fallback={<div class="list-row context-row context-row-static">{inner()}</div>}>
          <button type="button" class="list-row list-row-interactive context-row" data-ctx-key={r.key} aria-haspopup={r.noSheet ? undefined : "dialog"} aria-label={r.label} onClick={() => r.onOpen?.()}>
            {inner()}
          </button>
        </Show>
      </li>
    );
  };
  const PartRows = (r: { level: GroupLevelOf; parts: ContextPart[] }) => (
    <ForKey each={r.parts} by={(p) => p.id}>
      {(p) => (
        <Row
          key={`part:${p().id}`}
          name={p().label}
          mono={monoName(p())}
          chip={partMeta(p()).chip}
          beside={partMeta(p()).beside}
          meta={partMeta(p()).text || undefined}
          share={shareOf(p().tokens, windowSize(), inWindow(p()))}
          size={sizeOf(p())}
          opens={partOpens(p())}
          onOpen={() => void openPart(r.level, p())}
        />
      )}
    </ForKey>
  );

  // ---- The sheet's levels --------------------------------------------------------------------
  const top = () => stack().at(-1);
  /** One skill's readers, most openings first; pressing one shows that chat's window. */
  const SkillLevel = (s: { row: SkillOverviewRow }) => (
    <>
      <p class="context-sheet-sub">{overviewMeta(s.row)}</p>
      <Show when={s.row.location}>{(loc) => <p class="context-sheet-sub text-mono">{loc()}</p>}</Show>
      <ul class="list context-list" aria-label={`Who read ${s.row.name}`}>
        <ForKey each={s.row.readers} by={(r) => r.key}>
          {(r) => (
            <Row
              key={`reader:${r().key}`}
              name={r().label}
              meta={[`${r().count} ${r().count === 1 ? "opening" : "openings"}`, r().lastAt ? `last ${relativeTime(r().lastAt)}` : ""].filter(Boolean).join(" · ")}
              share={null}
              size=""
              opens
              noSheet
              label={`Show ${r().label}'s context`}
              onOpen={() => {
                setWho(r().key);
                queueMicrotask(() => picker?.focus());
              }}
            />
          )}
        </ForKey>
      </ul>
    </>
  );
  const GroupLevel = (g: { level: GroupLevelOf; line: ContextLine }) => {
    const sheet = createMemo(() => groupSheet(g.line));
    return (
      <>
        <Show when={sheet().sub}>
          <p class="context-sheet-sub">{sheet().sub}</p>
        </Show>
        <Show when={sheet().above.length > 0}>
          <ul class="list context-list" aria-label={g.line.label}>
            <PartRows level={g.level} parts={sheet().above} />
          </ul>
        </Show>
        <For each={[sheet().below, sheet().last].flatMap((s) => s ?? [])}>
          {(below) => (
            <section class="stack-2" aria-labelledby={below.id}>
              <h4 class="text-eyebrow context-sheet-eyebrow" id={below.id}>
                {below.heading}
              </h4>
              <p class="usage-note text-muted">{below.note}</p>
              <ul class="list context-list" aria-labelledby={below.id}>
                <PartRows level={g.level} parts={below.parts} />
              </ul>
            </section>
          )}
        </For>
        <Show when={(g.line.kind === "instructions" || g.line.kind === "skills") && ok()?.nestedIncomplete}>
          <p class="usage-note text-muted">This list may be incomplete.</p>
        </Show>
      </>
    );
  };
  const PartLevel = (l: { level: Extract<Level, { part: ContextPart }> }) => {
    const note = () => partNote(l.level.part);
    return (
      <>
        <p class="context-sheet-sub" classList={{ "text-mono": l.level.part.path !== undefined }}>
          {partSubtitle(l.level.part, { label: l.level.label })}
        </p>
        <Show when={note()}>
          <p class="usage-note text-muted">{note()}</p>
        </Show>
        <Show when={l.level.doc.shape.kind !== "note"}>
          <div class="context-sheet-actions">
            <ReaderTools shape={l.level.doc.shape} markdown={l.level.doc.markdown} view={docView()} onView={setDocView} full />
          </div>
        </Show>
        <ReaderDoc shape={l.level.doc.shape} markdown={l.level.doc.markdown} view={docView()} />
      </>
    );
  };
  const levelName = (l: Level) => (isPart(l) ? l.part.label : l.label);
  const topMono = () => {
    const t = top();
    return !!t && isPart(t) && monoName(t.part);
  };
  const levelSize = (l: Level) => {
    if (isSkill(l)) return "";
    if (isPart(l)) return sizeOf(l.part);
    const line = lineOf(l.line);
    return line ? approxTokens(line.tokens) : "";
  };

  return (
    <div class="context-tab" ref={root}>
      <div class="session-panel-scroll" tabindex="0" inert={stack().length > 0 ? true : undefined}>
        <div class="stack">
          <Show when={pickable().length > 0}>
            <label class="field">
              <span class="field-label">Whose context</span>
              <span class="select-wrap">
                <select ref={picker} class="select" onChange={(e) => setWho(e.currentTarget.value)}>
                  <option value={props.path} selected={!everyone() && target() === props.path}>
                    This chat
                  </option>
                  <option value={EVERYONE} selected={everyone()}>
                    Everyone
                  </option>
                  <For each={pickable()}>
                    {(w) => (
                      <option value={w.sessionFile} selected={!everyone() && target() === w.sessionFile}>
                        {workerLabel(w, props.teams)}
                      </option>
                    )}
                  </For>
                </select>
                <span class="select-caret" aria-hidden="true">
                  <Icon name="chevron-down" small />
                </span>
              </span>
            </label>
          </Show>

          <Switch>
            <Match when={everyone()}>
              <section class="stack-2" aria-labelledby="context-everyone-label">
                <h3 class="text-eyebrow" id="context-everyone-label">
                  Skills read
                </h3>
                <p class="usage-note text-muted">Counts every opening in each chat's whole history, not only what its window holds now.</p>
                <Show when={overview().read.length > 0} fallback={<p class="usage-note text-muted">This chat and its workers haven't opened a skill yet.</p>}>
                  <ul class="list context-list" aria-labelledby="context-everyone-label">
                    <ForKey each={overview().read} by={(r) => r.id}>
                      {(r) => (
                        <Row
                          key={`skill:${r().id}`}
                          name={r().name}
                          meta={`${overviewMeta(r())}: ${r().readers.map((x) => x.label).join(", ")}${r().location ? ` · ${r().location}` : ""}`}
                          share={null}
                          size=""
                          opens
                          onOpen={() => openSkill(r())}
                        />
                      )}
                    </ForKey>
                  </ul>
                </Show>
                <Show when={overview().notRead.length > 0}>
                  <section class="stack-2 context-apart" aria-labelledby="context-unread-label">
                    <h4 class="text-eyebrow context-sheet-eyebrow" id="context-unread-label">
                      Not read by anyone
                    </h4>
                    <ul class="list context-list" aria-labelledby="context-unread-label">
                      <ForKey each={overview().notRead} by={(s) => s.name}>
                        {(s) => <Row key={`unread:${s().name}`} name={s().name} meta={s().description} share={null} size="" opens={false} />}
                      </ForKey>
                    </ul>
                  </section>
                </Show>
              </section>
            </Match>
            <Match when={!view.latest && view.error}>
              <p class="usage-note field-error">Couldn't read this chat's context. {String(view.error instanceof Error ? view.error.message : view.error)}</p>
            </Match>
            <Match when={!view.latest}>
              <p class="usage-note text-muted">Reading this chat's context.</p>
            </Match>
            <Match when={view.latest?.state === "remote"}>
              <p class="usage-note text-muted">This chat runs on another machine, so its context can't be read here.</p>
            </Match>
            <Match when={view.latest?.state === "unavailable" && view.latest}>
              {(v) => <p class="usage-note text-muted">{v().state === "unavailable" ? (v() as { reason: string }).reason : ""}</p>}
            </Match>
            <Match when={ok() && layout()}>
              {(lay) => (
                <section class="stack-2" aria-labelledby="context-window-label">
                  <h3 class="text-eyebrow" id="context-window-label">
                    Context window
                  </h3>
                  <p class="context-headline">
                    {contextHeadline(ok()!.total, ok()!.window)}
                    <Show when={contextRoom(ok()!.total, ok()!.window)}>{(r) => <span class="text-muted"> · {r()}</span>}</Show>
                  </p>
                  <Show when={lay().free !== null}>
                    <div class="context-meter" aria-hidden="true">
                      <For each={meterShares(lay(), windowSize())}>
                        {(s) => <span class="context-meter-part" classList={{ "context-meter-other": s.id === "other" }} style={{ width: `${s.pct}%` }} />}
                      </For>
                    </div>
                  </Show>
                  <p class="usage-note text-muted">
                    {ok()!.total === null ? "Each size below is an estimate (≈)." : "As of the last reply. Each part is an estimate (≈); Other is what the estimates don't explain."}
                    <Show when={!ok()!.prompt}> This chat isn't running here, so its mode, rules and tools are unknown and fall under Other.</Show>
                  </p>
                  <ul class="list context-list" aria-labelledby="context-window-label">
                    <ForKey each={lay().lines} by={(l) => l.id}>
                      {(l) => (
                        <Row
                          key={`line:${l().id}`}
                          name={l().label}
                          meta={l().meta || undefined}
                          share={shareOf(l().tokens, windowSize())}
                          size={approxTokens(l().tokens)}
                          opens={l().parts.length > 0}
                          onOpen={() => openLine(l())}
                        />
                      )}
                    </ForKey>
                  </ul>
                  <Show when={lay().other !== null}>
                    <ul class="list context-list context-apart" aria-label="Other">
                      <Row key="line:other" name="Other" meta={OTHER_META} share={shareOf(lay().other!, windowSize())} size={approxTokens(lay().other!)} opens={false} />
                    </ul>
                  </Show>
                </section>
              )}
            </Match>
          </Switch>
        </div>
      </div>

      <Show when={top()}>
        <div class="context-scrim" aria-hidden="true" onClick={() => backTo(0)} />
        <section class="context-sheet" role="dialog" aria-labelledby="context-sheet-title" onKeyDown={onSheetKey}>
          <header class="context-sheet-head">
            <nav class="context-crumbs" aria-label="Breadcrumb">
              <button ref={back} type="button" class="button button-icon button-ghost" aria-label="Back" title="Back" onClick={() => backTo(stack().length - 1)}>
                <Icon name="chevron-left" />
              </button>
              <ol>
                <li>
                  <button type="button" class="context-crumb" onClick={() => backTo(0)}>
                    Context
                  </button>
                  <span class="context-crumb-sep" aria-hidden="true">
                    ›
                  </span>
                </li>
                <Index each={stack().slice(0, -1)}>
                  {(l, i) => (
                    <li>
                      <button type="button" class="context-crumb" onClick={() => backTo(i + 1)}>
                        {levelName(l())}
                      </button>
                      <span class="context-crumb-sep" aria-hidden="true">
                        ›
                      </span>
                    </li>
                  )}
                </Index>
                <li>
                  <span class="context-crumb-current" aria-current="page">
                    {levelName(top()!)}
                  </span>
                </li>
              </ol>
            </nav>
            <div class="context-sheet-titles">
              <h3 class="context-sheet-title" id="context-sheet-title" classList={{ "text-mono": topMono() }}>
                {levelName(top()!)}
              </h3>
              <span class="context-row-size">{levelSize(top()!)}</span>
            </div>
          </header>
          <div class="context-sheet-body" ref={body} tabindex="0" aria-labelledby="context-sheet-title">
            <Show when={top()} keyed>
              {(t) => (
                <Switch>
                  <Match when={isSkill(t) && t}>{(s) => <Show when={skillRow(s().skill)}>{(row) => <SkillLevel row={row()} />}</Show>}</Match>
                  <Match when={isPart(t) && t}>{(p) => <PartLevel level={p()} />}</Match>
                  <Match when={!isSkill(t) && !isPart(t) && t}>{(g) => <Show when={lineOf(g().line)}>{(line) => <GroupLevel level={g()} line={line()} />}</Show>}</Match>
                </Switch>
              )}
            </Show>
          </div>
        </section>
      </Show>
    </div>
  );
}
