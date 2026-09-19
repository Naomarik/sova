import type { Theme } from "@earendil-works/pi-coding-agent";
import { Input, SelectList, fuzzyFilter, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi,
  type Component, type Focusable, type KeybindingsManager } from "@earendil-works/pi-tui";

export interface MenuItem {
  id: string;
  label: string;
  description?: string;
  children?: MenuItem[];
  run?: () => void | Promise<void>;
  value?: () => string;
  adjust?: (direction: -1 | 1) => void;
  modelGroup?: boolean;
  favorite?: { isFavorite: () => boolean; toggle: () => void };
  /** Enter flips this in place; the palette stays open. */
  toggle?: { isOn: () => boolean; toggle: () => void };
}
interface Frame { title: string; items: MenuItem[]; query: string; selected: number; modelGroup?: boolean }
interface Match { item: MenuItem; path: string }

// Search descendants as well as the current level, so "rename" works at the root.
export function searchItems(items: MenuItem[], query: string, include: (item: MenuItem) => boolean = () => true): Match[] {
  if (!query.trim()) return items.filter(include).map(item => ({ item, path: "" }));
  const all: Match[] = [];
  const walk = (nodes: MenuItem[], path: string) => {
    for (const item of nodes) {
      if (!include(item)) continue;
      all.push({ item, path });
      if (item.children) walk(item.children, path ? `${path} › ${item.label}` : item.label);
    }
  };
  walk(items, "");
  const text = (m: Match) => `${m.item.label} ${m.item.description ?? ""} ${m.path}`;
  const matches = fuzzyFilter(all, query.trim(), text);
  const tokens = query.toLowerCase().trim().split(/[\s/]+/).filter(Boolean);
  // Pi's greedy fuzzy scorer can prefer scattered letters in a provider/name
  // over a literal model name later in the label (e.g. "opus"). Keep its order
  // within each tier, but put matches containing every literal token first.
  const literal: Match[] = [], fuzzy: Match[] = [];
  for (const match of matches) {
    const haystack = text(match).toLowerCase();
    (tokens.every(token => haystack.includes(token)) ? literal : fuzzy).push(match);
  }
  return [...literal, ...fuzzy];
}

export class Palette implements Component, Focusable {
  private input = new Input({ prompt: "❯ ", placeholder: "Type to search commands…" });
  private stack: Frame[];
  private matches: Match[] = [];
  private list!: SelectList;
  private rows = 10;
  private closed = false;
  private showAllModels = false;
  private error = "";
  private get modelControls(): boolean {
    const containsModels = (items: MenuItem[]): boolean => items.some(item =>
      item.modelGroup || item.favorite || (item.children && containsModels(item.children)));
    return !!this.frame.modelGroup || containsModels(this.frame.items);
  }
  get focused() { return this.input.focused; }
  set focused(value: boolean) { this.input.focused = value; }
  private get frame() { return this.stack[this.stack.length - 1]!; }

  constructor(items: MenuItem[], private theme: Theme, private keys: KeybindingsManager,
    private redraw: () => void, private height: () => number,
    private done: (item: MenuItem | undefined) => void, initialPath?: string[]) {
    this.stack = [{ title: "Commands", items, query: "", selected: 0 }];
    // Deep link: descend while each id (case-insensitive) names a category.
    for (const id of initialPath ?? []) {
      const item = this.frame.items.find(entry => entry.children && entry.id.toLowerCase() === id.toLowerCase());
      if (!item) break;
      this.stack.push({ title: item.label, items: item.children!, query: "", selected: 0, modelGroup: item.modelGroup });
    }
    this.rebuild();
  }
  private rebuild(preferred?: MenuItem) {
    this.matches = searchItems(this.frame.items, this.frame.query,
      item => !item.favorite || this.showAllModels || item.favorite.isFavorite());
    const retained = preferred ? this.matches.findIndex(match => match.item === preferred) : -1;
    if (retained >= 0) this.frame.selected = retained;
    this.frame.selected = Math.max(0, Math.min(this.frame.selected, this.matches.length - 1));
    this.list = new SelectList(this.matches.map(({ item, path }, index) => ({
      value: String(index), label: `${item.favorite ? (item.favorite.isFavorite() ? "★ " : "☆ ") : ""}${item.toggle ? (item.toggle.isOn() ? "◉ " : "○ ") : ""}${item.value ? `${item.value()}  ` : ""}${item.label}${item.children ? "  ›" : ""}`,
      description: item.value ? item.description : path || item.description,
    })), this.rows, {
      selectedPrefix: s => this.theme.fg("accent", s),
      selectedText: s => this.theme.fg("accent", this.theme.bold(s)),
      description: s => this.theme.fg("muted", s),
      scrollInfo: s => this.theme.fg("dim", s),
      noMatch: s => this.theme.fg("warning", s),
    }, this.matches.some(({ item }) => item.value) ? {
      minPrimaryColumnWidth: 32, maxPrimaryColumnWidth: 72,
      truncatePrimary: ({ text, maxWidth }) => truncateToWidth(text, maxWidth, "…"),
    } : undefined);
    this.list.setSelectedIndex(this.frame.selected);
  }
  private close(item?: MenuItem) {
    if (!this.closed) { this.closed = true; this.done(item); }
  }
  private back() {
    if (this.stack.length === 1) { this.close(); return; }
    this.stack.pop();
    this.input.setValue(this.frame.query);
    this.rebuild();
  }
  handleInput(data: string) {
    if (this.closed) return;
    if (matchesKey(data, "ctrl+p") || matchesKey(data, "ctrl+c")) this.close();
    else if (this.keys.matches(data, "tui.select.cancel") || matchesKey(data, "alt+left") ||
      (matchesKey(data, "backspace") && !this.input.getValue())) this.back();
    else if (this.modelControls && matchesKey(data, "ctrl+a")) {
      const selected = this.matches[this.frame.selected]?.item;
      this.showAllModels = !this.showAllModels;
      this.error = "";
      this.rebuild(selected);
    } else if (this.modelControls && matchesKey(data, "ctrl+f")) {
      const selected = this.matches[this.frame.selected]?.item;
      if (selected?.favorite) {
        try { selected.favorite.toggle(); this.error = ""; }
        catch (error) { this.error = `Could not save favorite: ${error instanceof Error ? error.message : String(error)}`; }
        this.rebuild(selected);
      }
    } else if (this.keys.matches(data, "tui.select.confirm")) {
      const item = this.matches[this.frame.selected]?.item;
      if (item?.children) {
        this.stack.push({ title: item.label, items: item.children, query: "", selected: 0, modelGroup: item.modelGroup });
        this.input.setValue("");
        this.rebuild();
      } else if (item?.toggle) {
        try { item.toggle.toggle(); this.error = ""; }
        catch (error) { this.error = `Could not toggle ${item.label}: ${error instanceof Error ? error.message : String(error)}`; }
        this.rebuild(item);
      } else if (item?.run) this.close(item);
    } else if (this.matches[this.frame.selected]?.item.adjust &&
      (matchesKey(data, "left") || matchesKey(data, "right"))) {
      this.matches[this.frame.selected]!.item.adjust!(matchesKey(data, "left") ? -1 : 1);
      this.rebuild();
    } else {
      let move = 0;
      if (this.keys.matches(data, "tui.select.up") || matchesKey(data, "ctrl+k")) move = -1;
      else if (this.keys.matches(data, "tui.select.down") || matchesKey(data, "ctrl+j")) move = 1;
      else if (this.keys.matches(data, "tui.select.pageUp")) move = -this.rows;
      else if (this.keys.matches(data, "tui.select.pageDown")) move = this.rows;
      if (move) {
        this.frame.selected = Math.max(0, Math.min(this.matches.length - 1, this.frame.selected + move));
        this.list.setSelectedIndex(this.frame.selected);
      } else {
        this.input.handleInput(data);
        if (this.frame.query !== this.input.getValue()) {
          this.frame.query = this.input.getValue();
          this.frame.selected = 0;
          this.rebuild();
        }
      }
    }
    this.redraw();
  }
  render(width: number): string[] {
    const height = Math.max(1, this.height());
    if (width < 6 || height < 7) {
      return [truncateToWidth("Palette: enlarge terminal; Esc closes", width)];
    }
    const inner = width - 2;
    const hints = this.modelControls ? wrapTextWithAnsi(
      `Ctrl+A ${this.showAllModels ? "favorites" : "show all"} · Ctrl+F toggle favorite`, inner - 2) : [];
    const extra = hints.length + (this.error ? 1 : 0);
    // SelectList adds a scroll indicator below its visible rows.
    if (height < 8 + extra) return [truncateToWidth("Palette: enlarge terminal; Ctrl+A all; Esc back", width)];
    const rows = Math.max(1, Math.min(12, height - 8 - extra));
    if (rows !== this.rows) { this.rows = rows; this.rebuild(); }
    const row = (text: string) => {
      const clipped = truncateToWidth(text, inner, "…");
      return this.theme.fg("borderAccent", "│") + clipped + " ".repeat(Math.max(0, inner - visibleWidth(clipped))) + this.theme.fg("borderAccent", "│");
    };
    const lines = [this.theme.fg("borderAccent", `╭${"─".repeat(inner)}╮`),
      row(" " + this.theme.fg("accent", this.theme.bold(this.stack.map(f => f.title).join(" › ") +
        (this.modelControls ? (this.showAllModels ? " · All models" : " · Favorites") : "")))),
      ...this.input.render(inner - 2).map(s => row(" " + s)),
      row(this.theme.fg("borderMuted", "─".repeat(inner))),
      ...(!this.matches.length && this.frame.modelGroup
        ? [this.theme.fg("warning", this.showAllModels ? "No matching models." :
          this.frame.query.trim() ? "No matching favorites. Ctrl+A shows all." : "No favorite models. Ctrl+A shows all.")]
        : this.list.render(inner - 2)).map(s => row(" " + s)),
      ...(this.error ? [row(" " + this.theme.fg("error", this.error))] : []),
      ...hints.map(hint => row(" " + this.theme.fg("dim", hint))),
      row(this.theme.fg("dim", this.matches[this.frame.selected]?.item.value
        ? " ←→ thinking · Enter apply · Esc back · Ctrl+P close"
        : this.matches[this.frame.selected]?.item.toggle ? " Enter toggle · Esc back · Ctrl+P close"
        : " ↑↓ move · Enter select · Esc back · Ctrl+P close")),
      this.theme.fg("borderAccent", `╰${"─".repeat(inner)}╯`)];
    return lines;
  }
  invalidate() { this.input.invalidate(); this.list.invalidate(); }
}
