import type { Theme } from "@earendil-works/pi-coding-agent";
import { Input, KeybindingsManager, TUI_KEYBINDINGS, fuzzyFilter, matchesKey, truncateToWidth, visibleWidth, type Component, type Focusable } from "@earendil-works/pi-tui";

export interface SessionRow {
  id: string;
  name: string;
  cwd: string;
  model: string;
  status: string;
  since: number;
  self: boolean;
  unseen: boolean;
  stale: boolean;
  preview: string;
  outline?: { now?: string; overall?: string; topics?: string[]; state?: string; generatedAt?: number; lastHeading?: string };
  workers: { id: string; name: string; status: string; model?: string; preview?: string }[];
  canFocus: boolean;
}

type Entry = { key: string; row: SessionRow; worker?: SessionRow["workers"][number] };
const key = (id: string, worker?: string) => JSON.stringify([id, worker ?? null]);

// Never permit remote terminal commands, C0/C1 controls, or bidi overrides.
// Preserve only explicit preview newlines; labels must remain single-line.
function clean(value: string, multiline = false): string {
  return value.slice(0, 32768)
    .replace(/\r\n/g, "\n")
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/[\n\u2028\u2029]/g, multiline ? "\n" : " ");
}

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

export class SessionsOverlay implements Component, Focusable {
  private readonly input: Input;
  private rows: SessionRow[] = [];
  private matches: SessionRow[] = [];
  private expanded = new Set<string>();
  private selected: string | undefined;
  private scroll = 0;
  private preview = false;
  private connection = "disconnected";
  private closed = false;

  constructor(
    private readonly theme: Theme,
    private readonly refresh: () => void,
    private readonly height: () => number,
    private readonly done: (id: string | undefined) => void,
    private readonly keys: KeybindingsManager = new KeybindingsManager(TUI_KEYBINDINGS),
  ) {
    this.input = new Input({ prompt: "Search: ", placeholder: "name or cwd", placeholderStyle: s => theme.fg("dim", s) });
  }

  get focused(): boolean { return this.input.focused; }
  set focused(value: boolean) { this.input.focused = value; }

  update(rows: SessionRow[], connection: string): void {
    if (this.closed) return;
    const before = this.entries();
    const oldRows = new Map(this.rows.map(row => [row.id, row]));
    const snapshots = rows.map(row => ({
      ...row,
      name: clean(row.name), cwd: clean(row.cwd), model: clean(row.model), status: clean(row.status),
      preview: clean(row.preview, true),
      workers: stable(oldRows.get(row.id)?.workers ?? [], row.workers.map(worker => ({
        ...worker, name: clean(worker.name), status: clean(worker.status),
        model: clean(worker.model ?? ""), preview: clean(worker.preview ?? "", true),
      }))),
    }));
    this.rows = stable(this.rows, snapshots);
    this.connection = clean(connection);
    this.matches = stable(this.matches, this.filter());
    this.expanded = new Set([...this.expanded].filter(id => this.rows.some(row => row.id === id)));
    this.reconcile(before);
    this.refresh();
  }

  private filter(): SessionRow[] {
    return fuzzyFilter(this.rows, this.input.getValue(), row => `${row.name} ${row.cwd}`);
  }

  private entries(): Entry[] {
    return this.matches.flatMap(row => [
      { key: key(row.id), row },
      ...(this.expanded.has(row.id) ? row.workers.map(worker => ({ key: key(row.id, worker.id), row, worker })) : []),
    ]);
  }

  private reconcile(before: Entry[]): void {
    const entries = this.entries();
    if (entries.some(entry => entry.key === this.selected)) return;
    const index = before.findIndex(entry => entry.key === this.selected);
    const old = before[index];
    this.selected = (old?.worker && entries.find(entry => entry.key === key(old.row.id))?.key)
      || entries[Math.max(0, Math.min(index, entries.length - 1))]?.key;
  }

  handleInput(data: string): void {
    if (this.closed) return;
    const entries = this.entries();
    const index = entries.findIndex(entry => entry.key === this.selected);
    const current = entries[index];
    if (this.keys.matches(data, "tui.select.cancel")) {
      this.closed = true;
      this.done(undefined);
      return;
    } else if (this.keys.matches(data, "tui.select.up") || this.keys.matches(data, "tui.select.down")) {
      const delta = this.keys.matches(data, "tui.select.up") ? -1 : 1;
      this.selected = entries[Math.max(0, Math.min(entries.length - 1, index + delta))]?.key;
    } else if (matchesKey(data, "right")) {
      if (current) this.expanded.add(current.row.id);
    } else if (matchesKey(data, "left")) {
      if (current) {
        this.expanded.delete(current.row.id);
        this.selected = key(current.row.id);
      }
    } else if (matchesKey(data, "tab")) {
      this.preview = !this.preview;
    } else if (this.keys.matches(data, "tui.select.confirm")) {
      if (current?.worker) this.preview = true;
      else if (current?.row.canFocus) {
        this.closed = true;
        this.done(current.row.id);
        return;
      }
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

  render(width: number): string[] {
    width = Math.max(0, Math.floor(width));
    const height = Math.max(0, Math.floor(this.height()));
    if (!height) return [];
    if (!width) return [""];
    const clip = (line: string) => truncateToWidth(line, width, "");
    const entries = this.entries();
    const index = Math.max(0, entries.findIndex(entry => entry.key === this.selected));
    const current = entries[index];
    const label = (entry: Entry): string => {
      const { row, worker } = entry;
      if (worker) return `  └ ${worker.name} · ${worker.status} · ${worker.model || ""}`;
      const running = row.workers.filter(child => child.status === "running").length;
      const flags = [row.workers.length && `${running}/${row.workers.length} workers running`, row.self && "self", row.stale && "stale", row.unseen && "● unseen finished", !row.canFocus && "preview only"].filter(Boolean);
      const age = Number.isFinite(row.since) && row.since > 0 ? ` · ${Math.max(0, Math.floor((Date.now() - row.since) / 1000))}s` : "";
      const outlineNow = !row.stale && row.outline?.now ? ` · ▶ ${row.outline.now}` : "";
      return `${row.workers.length ? (this.expanded.has(row.id) ? "▾" : "▸") : " "} ${row.name}${flags.length ? ` [${flags.join(", ")}]` : ""} · ${row.status}${age}${outlineNow} · ${row.model} · ${row.cwd}`;
    };
    // Latest user `#` heading, appended muted after the unchanged label (parent rows only).
    const heading = (entry: Entry): string => !entry.worker && !entry.row.stale && entry.row.outline?.lastHeading ? ` · # ${clean(entry.row.outline.lastHeading)}` : "";
    const rowLine = (entry: Entry) => {
      const selected = entry.key === this.selected;
      const suffix = heading(entry);
      // Reserve room for the heading before clipping the label — it is the one
      // piece of text that identifies the session, and a full-width label
      // would otherwise silently drop it.
      const reserve = suffix ? Math.min(visibleWidth(suffix), Math.max(24, Math.floor(width * 0.45))) : 0;
      const text = truncateToWidth(`${selected ? ">" : " "} ${label(entry)}`, Math.max(0, width - reserve), "");
      const room = width - visibleWidth(text);
      if (suffix && room > 0) {
        const tail = truncateToWidth(suffix, room, "");
        const main = selected ? this.theme.fg("accent", text) : this.theme.fg("text", text);
        return selected ? this.theme.bg("selectedBg", main + this.theme.fg("muted", tail)) : main + this.theme.fg("muted", tail);
      }
      return selected ? this.theme.bg("selectedBg", this.theme.fg("accent", text)) : this.theme.fg(entry.row.stale ? "dim" : "text", text);
    };
    // On extremely short terminals, prioritize the selected row over decoration.
    if (height <= 2) return [current ? rowLine(current) : clip("No matching sessions")];
    const lines = [this.theme.fg("accent", clip(`Sessions · ${this.connection}`)), clip(this.input.render(Math.max(8, width))[0] ?? "")];
    const footer = height >= 5 ? 1 : 0;
    const space = height - lines.length - footer;
    const previewLimit = this.preview && current ? Math.min(7, Math.max(0, Math.floor(space / 2))) : 0;
    let previewLines: string[] = [];
    if (previewLimit && current) {
      const outline = !current.worker && !current.row.stale ? current.row.outline : undefined;
      const outlineLines = outline ? [
        ...(outline.now ? [this.theme.fg("muted", clip(`Now: ${outline.now}`))] : []),
        ...(outline.overall ? [this.theme.fg("dim", clip(`Outline: ${outline.overall}`))] : []),
        ...(outline.topics?.length ? [this.theme.fg("dim", clip(`Topics: ${outline.topics.join(" · ")}`))] : []),
      ] : [];
      const remaining = Math.max(0, previewLimit - 1 - outlineLines.length);
      const body = (current.worker?.preview ?? current.row.preview).split("\n").slice(0, remaining);
      previewLines = [
        this.theme.fg("muted", clip(`Preview · ${current.worker?.name ?? current.row.name}`)),
        ...outlineLines,
        ...body.map(line => this.theme.fg("muted", clip(line))),
      ];
    }
    const listHeight = Math.max(1, space - previewLines.length);
    this.scroll = Math.max(0, Math.min(this.scroll, entries.length - listHeight));
    if (index < this.scroll) this.scroll = index;
    if (index >= this.scroll + listHeight) this.scroll = index - listHeight + 1;
    lines.push(...(entries.length ? entries.slice(this.scroll, this.scroll + listHeight).map(rowLine) : [this.theme.fg("dim", "No matching sessions")]));
    lines.push(...previewLines);
    if (footer) {
      const up = this.keys.getKeys("tui.select.up").join("/");
      const down = this.keys.getKeys("tui.select.down").join("/");
      const confirm = this.keys.getKeys("tui.select.confirm").join("/");
      const cancel = this.keys.getKeys("tui.select.cancel").join("/");
      lines.push(this.theme.fg("dim", `${up}/${down} select · ←→ workers · Tab preview · ${confirm} focus · ${cancel} close · ${entries.length ? index + 1 : 0}/${entries.length}`));
    }
    return lines.slice(0, height).map(clip);
  }
}
