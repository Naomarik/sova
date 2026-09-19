import type { Theme } from "@earendil-works/pi-coding-agent";
import { Input, KeybindingsManager, TUI_KEYBINDINGS, fuzzyFilter, matchesKey, truncateToWidth, type Component, type Focusable } from "@earendil-works/pi-tui";
import { VIEW_GROUPS, type SessionView, type ViewGroup } from "./state.ts";
import type { WorkerEntry } from "./schema.ts";
import { clean, detailLines, frame, frameInner, frameOverhead, groupHeader, rowLines, sortWorkers, workerLine,
  type DetailMode, type RenderTokens } from "./render.ts";

type Mode = DetailMode | "off";
const MODES: readonly Mode[] = ["detail", "preview", "off"];
type Entry =
  | { kind: "header"; key: string; group: ViewGroup }
  | { kind: "row"; key: string; view: SessionView }
  | { kind: "worker"; key: string; view: SessionView; worker: WorkerEntry };
type Selectable = Exclude<Entry, { kind: "header" }>;
const key = (id: string, worker?: string) => JSON.stringify([id, worker ?? null]);
const PAGE = 10;
const KEY_LABEL: Record<string, string> = { up: "↑", down: "↓", enter: "Enter", escape: "Esc", tab: "Tab" };

export interface SessionsOverlayOptions { initialQuery?: string; onMarkAllSeen?: () => void }

/** Stable order: query edits rank matches; snapshots only remove or append IDs. */
function stable<T extends { id: string }>(previous: T[], incoming: T[]): T[] {
  const remaining = new Map(incoming.map(item => [item.id, item]));
  const result: T[] = [];
  for (const old of previous) {
    const next = remaining.get(old.id);
    if (next) { result.push(next); remaining.delete(old.id); }
  }
  return result.concat([...remaining.values()]);
}

/** Every incoming string field is untrusted peer data. */
function sanitize(view: SessionView, old?: SessionView): SessionView {
  const o = view.outline;
  const a = view.activity;
  const opt = (s: string | undefined) => s === undefined ? undefined : clean(s);
  return {
    ...view,
    name: clean(view.name), cwd: clean(view.cwd), model: clean(view.model), host: opt(view.host),
    statusLabel: clean(view.statusLabel), tools: view.tools?.map(t => clean(t)), toolDetail: opt(view.toolDetail),
    preview: clean(view.preview, true), focusReason: opt(view.focusReason),
    outline: o && { ...o, now: opt(o.now), overall: opt(o.overall), lastHeading: opt(o.lastHeading),
      topics: o.topics?.map(t => clean(t)),
      detail: o.detail?.map(d => ({ heading: clean(d.heading), bullets: d.bullets.map(b => clean(b)) })) },
    activity: a && { ...a, tools: a.tools?.map(t => clean(t)), toolDetail: opt(a.toolDetail), error: opt(a.error) },
    workers: sortWorkers(stable(old?.workers ?? [], view.workers.map(w => ({
      ...w, name: clean(w.name), status: clean(w.status), model: opt(w.model), backend: opt(w.backend),
      preview: w.preview === undefined ? undefined : clean(w.preview, true),
    })))),
  };
}

export class SessionsOverlay implements Component, Focusable {
  private readonly input: Input;
  private readonly tokens: RenderTokens;
  private views: SessionView[] = [];
  private matches: SessionView[] = [];
  private expanded = new Set<string>();
  private selected: string | undefined;
  private scroll = 0;
  private mode: Mode = "detail";
  /** Narrow layouts keep the list until the user asks for detail. */
  private touched = false;
  private connection = "disconnected";
  private closed = false;

  constructor(
    private readonly theme: Theme,
    private readonly refresh: () => void,
    private readonly height: () => number,
    private readonly done: (id: string | undefined) => void,
    private readonly keys: KeybindingsManager = new KeybindingsManager(TUI_KEYBINDINGS),
    private readonly opts: SessionsOverlayOptions = {},
  ) {
    this.tokens = theme as unknown as RenderTokens;
    this.input = new Input({ prompt: "Search: ", placeholder: "name or cwd", placeholderStyle: s => theme.fg("dim", s) });
    if (opts.initialQuery) this.input.setValue(clean(opts.initialQuery));
  }

  get focused(): boolean { return this.input.focused; }
  set focused(value: boolean) { this.input.focused = value; }

  update(views: SessionView[], connection: string): void {
    if (this.closed) return;
    const before = this.selectable();
    const old = new Map(this.views.map(view => [view.id, view]));
    this.views = views.map(view => sanitize(view, old.get(view.id)));
    this.connection = clean(connection);
    // Live publishes must not re-rank what the user is looking at while searching.
    this.matches = stable(this.matches, this.filter());
    this.expanded = new Set([...this.expanded].filter(id => this.views.some(view => view.id === id)));
    this.reconcile(before);
    this.refresh();
  }

  setQuery(text: string): void {
    if (this.closed) return;
    const before = this.selectable();
    this.input.setValue(clean(text));
    this.matches = this.filter();
    this.reconcile(before);
    this.scroll = 0;
    this.refresh();
  }

  private query(): string { return this.input.getValue().trim(); }

  private filter(): SessionView[] {
    return this.query() ? fuzzyFilter(this.views, this.query(), view => `${view.name} ${view.cwd}`) : [];
  }

  private rows(view: SessionView): Entry[] {
    return [{ kind: "row", key: key(view.id), view },
      ...(this.expanded.has(view.id) ? view.workers.map(worker => ({ kind: "worker" as const, key: key(view.id, worker.id), view, worker })) : [])];
  }

  /** Grouped with non-selectable headers; a flat ranked list while searching. */
  private entries(): Entry[] {
    if (this.query()) return this.matches.flatMap(view => this.rows(view));
    return VIEW_GROUPS.flatMap(group => {
      const views = this.views.filter(view => view.group === group);
      return views.length ? [{ kind: "header" as const, key: `header:${group}`, group }, ...views.flatMap(view => this.rows(view))] : [];
    });
  }

  private selectable(entries = this.entries()): Selectable[] {
    return entries.filter((entry): entry is Selectable => entry.kind !== "header");
  }

  private reconcile(before: Selectable[]): void {
    const entries = this.selectable();
    if (entries.some(entry => entry.key === this.selected)) return;
    const index = before.findIndex(entry => entry.key === this.selected);
    const old = before[index];
    this.selected = (old?.kind === "worker" && entries.find(entry => entry.key === key(old.view.id))?.key)
      || entries[Math.max(0, Math.min(index, entries.length - 1))]?.key;
  }

  handleInput(data: string): void {
    if (this.closed) return;
    const entries = this.selectable();
    const index = entries.findIndex(entry => entry.key === this.selected);
    const current = entries[index];
    const move = (delta: number) => {
      if (entries.length) this.selected = entries[Math.max(0, Math.min(entries.length - 1, (index < 0 ? 0 : index) + delta))].key;
    };
    if (this.keys.matches(data, "tui.select.cancel")) {
      this.closed = true;
      this.done(undefined);
      return;
    } else if (this.keys.matches(data, "tui.select.up")) move(-1);
    else if (this.keys.matches(data, "tui.select.down")) move(1);
    else if (this.keys.matches(data, "tui.select.pageUp")) move(-PAGE);
    else if (this.keys.matches(data, "tui.select.pageDown")) move(PAGE);
    else if (matchesKey(data, "right")) {
      if (current?.kind === "row" && current.view.workers.length) this.expanded.add(current.view.id);
    } else if (matchesKey(data, "left")) {
      if (current) {
        this.expanded.delete(current.view.id);
        this.selected = key(current.view.id);
      }
    } else if (matchesKey(data, "tab")) {
      this.mode = MODES[(MODES.indexOf(this.mode) + 1) % MODES.length];
      this.touched = true;
    } else if (this.keys.matches(data, "tui.select.confirm")) {
      if (current?.kind === "worker" || (current && !current.view.canFocus)) {
        this.mode = "preview";
        this.touched = true;
      } else if (current) {
        this.closed = true;
        this.done(current.view.id);
        return;
      }
    } else if (this.opts.onMarkAllSeen && matchesKey(data, "ctrl+u")) {
      this.opts.onMarkAllSeen();
      // Optimistic until the host publishes fresh views.
      this.views = this.views.map(view => view.unseen ? { ...view, unseen: false } : view);
      this.matches = this.matches.map(view => this.views.find(v => v.id === view.id) ?? view);
    } else {
      const query = this.input.getValue();
      this.input.handleInput(data);
      const safe = clean(this.input.getValue());
      if (safe !== this.input.getValue()) this.input.setValue(safe);
      if (query !== safe) {
        this.matches = this.filter();
        this.reconcile(entries);
        this.scroll = 0;
      }
    }
    this.refresh();
  }

  invalidate(): void { this.input.invalidate(); }

  private entryLines(entry: Entry, width: number, twoLine: boolean, now: number): string[] {
    const selected = entry.key === this.selected;
    if (entry.kind === "header") return [groupHeader(entry.group, this.views, width, this.tokens)];
    if (entry.kind === "worker") {
      return [workerLine(entry.worker, width, this.tokens, { selected, indent: `${selected ? ">" : " "}  └ `, now })];
    }
    return rowLines(entry.view, { selected, twoLine, now, expanded: this.expanded.has(entry.view.id) }, width, this.tokens);
  }

  /** Scroll-clipped list; `fill` pads to exactly `height` lines. */
  private list(entries: Entry[], width: number, height: number, twoLine: boolean, headers: boolean, now: number): string[] {
    if (height <= 0) return [];
    const shown = headers ? entries : entries.filter(entry => entry.kind !== "header");
    if (!shown.length) return [this.theme.fg("dim", this.views.length || this.query() ? "No matching sessions" : "No live sessions")];
    const lines: string[] = [];
    let start = 0, end = 0, headerStart = -1;
    shown.forEach((entry, i) => {
      if (entry.key === this.selected) {
        start = lines.length;
        headerStart = shown[i - 1]?.kind === "header" ? start - 1 : -1;
      }
      lines.push(...this.entryLines(entry, width, twoLine, now));
      if (entry.key === this.selected) end = lines.length - 1;
    });
    this.scroll = Math.max(0, Math.min(this.scroll, lines.length - height));
    // Scrolling up to a group's first row also reveals its header.
    const top = headerStart >= 0 && end - headerStart < height ? headerStart : start;
    if (top < this.scroll) this.scroll = top;
    if (end >= this.scroll + height) this.scroll = end - height + 1;
    return lines.slice(this.scroll, this.scroll + height);
  }

  private detail(current: Selectable | undefined, width: number, height: number, now: number): string[] {
    if (!current) return [this.theme.fg("dim", "No session selected")];
    const mode: DetailMode = this.mode === "preview" ? "preview" : "detail";
    return detailLines(current.view, width, height, this.tokens, mode, { worker: current.kind === "worker" ? current.worker : undefined, now });
  }

  private detailTitle(current: Selectable | undefined): string {
    if (!current) return "Detail";
    const name = current.kind === "worker" ? `${current.view.name} › ${current.worker.name}` : current.view.name;
    return `${name} · ${this.mode === "preview" ? "Preview" : "Detail"}`;
  }

  render(width: number): string[] {
    width = Math.max(0, Math.floor(width));
    const height = Math.max(0, Math.floor(this.height()));
    if (!height) return [];
    if (!width) return [""];
    const now = Date.now();
    const clip = (line: string) => truncateToWidth(line, width, "");
    const all = this.entries();
    const entries = this.selectable(all);
    const index = entries.findIndex(entry => entry.key === this.selected);
    const current = entries[index];
    // On extremely short terminals, prioritize the selected row over decoration.
    if (height <= 2) return [current ? clip(this.entryLines(current, width, false, now)[0]) : clip(this.theme.fg("dim", "No matching sessions"))];

    const count = (group: ViewGroup) => this.views.filter(view => view.group === group).length;
    const unseen = this.views.filter(view => view.unseen).length;
    const tally = [count("working") && `●${count("working")}`, count("needs-input") && `⚑${count("needs-input")}`,
      unseen && `✦${unseen} unseen`].filter(Boolean).join(" ");
    const lines = [
      this.theme.fg("accent", clip(`Sessions · ${this.views.length - count("unreachable")} live${tally ? ` · ${tally}` : ""} · ${this.connection}`)),
      clip(this.input.render(Math.max(8, width))[0] ?? ""),
    ];
    const footer = height >= 5 ? 1 : 0;
    const bodyHeight = height - lines.length - footer;
    const listTitle = this.query() ? `Matches · ${entries.length}` : "Sessions";
    const frameOf = (content: string[], w: number, inner: number, title: string, fill: boolean) =>
      frame(fill ? [...content, ...Array(Math.max(0, inner - content.length)).fill("")] : content, w, title, this.tokens);

    if (width >= 140 && this.mode !== "off" && bodyHeight >= 3) {
      // Two panes side by side, both filling the body height.
      const listWidth = Math.min(86, Math.floor(width * 0.55));
      const detailWidth = width - listWidth;
      const inner = bodyHeight - 2;
      const left = frameOf(this.list(all, frameInner(listWidth), inner, true, true, now), listWidth, inner, listTitle, true);
      const right = frameOf(this.detail(current, frameInner(detailWidth), inner, now), detailWidth, inner, this.detailTitle(current), true);
      lines.push(...left.map((line, i) => line + (right[i] ?? "")));
    } else if (width >= 100 && bodyHeight >= 3) {
      // One column; the detail pane stacks below the list unless Tab turned it off.
      const overhead = frameOverhead(width);
      const withDetail = this.mode !== "off" && bodyHeight >= 10;
      const listCap = withDetail ? Math.max(3, Math.floor((bodyHeight - 2 * overhead) * 0.55)) : bodyHeight - overhead;
      const list = this.list(all, frameInner(width), listCap, true, true, now);
      lines.push(...frameOf(list, width, list.length, listTitle, false));
      if (withDetail) {
        const inner = bodyHeight - list.length - 2 * overhead;
        lines.push(...frameOf(this.detail(current, frameInner(width), inner, now), width, inner, this.detailTitle(current), true));
      }
    } else if (bodyHeight > 0) {
      // Narrow: one-line rows; Tab swaps the list for the detail text entirely.
      const framed = bodyHeight >= 6;
      const inner = framed ? bodyHeight - frameOverhead(width) : bodyHeight;
      const innerWidth = framed ? frameInner(width) : width;
      const showDetail = this.mode !== "off" && this.touched;
      const content = showDetail ? this.detail(current, innerWidth, inner, now) : this.list(all, innerWidth, inner, false, inner >= 8, now);
      lines.push(...(framed ? frameOf(content, width, content.length, showDetail ? this.detailTitle(current) : listTitle, false) : content));
    }
    if (footer) {
      const label = (name: string) => (this.keys.getKeys(name as never)[0] as string | undefined) ?? "";
      const pretty = (k: string) => KEY_LABEL[k] ?? k;
      const up = pretty(label("tui.select.up")), down = pretty(label("tui.select.down"));
      const hints = [
        `${up === "↑" && down === "↓" ? "↑↓" : `${up}/${down}`} select`, "←→ workers", "Tab detail",
        `${pretty(label("tui.select.confirm"))} focus`,
        ...(this.opts.onMarkAllSeen && unseen ? ["Ctrl+U seen"] : []),
        `${pretty(label("tui.select.cancel"))} close`,
        `${entries.length ? index + 1 : 0}/${entries.length}`,
      ];
      lines.push(this.theme.fg("dim", hints.join(" · ")));
    }
    return lines.slice(0, height).map(clip);
  }
}
