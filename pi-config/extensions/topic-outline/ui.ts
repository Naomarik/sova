/**
 * TUI: right-side outline overlay panel and the read-only peek panel.
 * All data access goes through callbacks so the panel re-renders live state.
 */

import {
  KeybindingsManager,
  TUI_KEYBINDINGS,
  matchesKey,
  truncateToWidth,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

import type { OutlineStateName, Topic } from "./types.ts";

export interface PanelResult {
  jump?: { topicId: string };
  refresh?: boolean;
}

export interface PanelView {
  nowInstant: () => string;
  nowModel: () => string;
  overall: () => string;
  state: () => OutlineStateName;
  generatedAt: () => number;
  topics: () => Topic[];
  chainStatus: () => string;
}

function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return [""];
  const lines: string[] = [];
  let current = "";
  for (const rawWord of words) {
    let word = rawWord;
    const next = current ? `${current} ${word}` : word;
    if (next.length <= width) { current = next; continue; }
    if (current) lines.push(current);
    // Hard-break words longer than the width.
    while (word.length > width) {
      lines.push(word.slice(0, width));
      word = word.slice(width);
    }
    current = word;
  }
  if (current) lines.push(current);
  return lines;
}

function age(generatedAt: number): string {
  if (!generatedAt) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - generatedAt) / 1000));
  return seconds < 60 ? "just now" : seconds < 3600 ? `${Math.floor(seconds / 60)}m ago` : `${Math.floor(seconds / 3600)}h ago`;
}

export class OutlinePanel implements Component, Focusable {
  private readonly keys = new KeybindingsManager(TUI_KEYBINDINGS);
  private selected = 0;
  private scroll = 0;
  focused = true;

  constructor(
    private readonly theme: Theme,
    private readonly view: PanelView,
    private readonly requestRender: () => void,
    private readonly height: () => number,
    private readonly done: (result: PanelResult | undefined) => void,
  ) {}

  handleInput(data: string): void {
    const topics = this.view.topics();
    if (this.keys.matches(data, "tui.select.cancel") || matchesKey(data, "q") || matchesKey(data, "escape")) {
      this.done(undefined);
      return;
    }
    if (this.keys.matches(data, "tui.select.up") || this.keys.matches(data, "tui.select.down")) {
      const delta = this.keys.matches(data, "tui.select.up") ? -1 : 1;
      this.selected = Math.max(0, Math.min(topics.length - 1, this.selected + delta));
    } else if (this.keys.matches(data, "tui.select.confirm")) {
      const topic = topics[this.selected];
      if (topic) {
        this.done({ jump: { topicId: topic.id } });
        return;
      }
    } else if (matchesKey(data, "r")) {
      this.done({ refresh: true });
      return;
    }
    this.requestRender();
  }

  invalidate(): void {}

  render(width: number): string[] {
    width = Math.max(0, Math.floor(width));
    const height = Math.max(0, Math.floor(this.height()));
    if (!width || !height) return [""];
    const clip = (line: string) => truncateToWidth(line, width, "");
    const fg = (color: "dim" | "muted" | "accent" | "text", text: string) => this.theme.fg(color, text);
    const state = this.view.state();
    const topics = this.view.topics();
    const nowModel = this.view.nowModel();
    const overall = this.view.overall();
    const generatedAt = this.view.generatedAt();
    const chain = this.view.chainStatus();

    const lines: string[] = [
      this.theme.fg("accent", clip(`Outline · ${state}${generatedAt ? ` · ${age(generatedAt)}` : ""}`)),
      fg("text", clip(`⏵ ${this.view.nowInstant()}`)),
    ];
    if (nowModel) lines.push(fg("muted", clip(`  ${nowModel}${generatedAt ? ` (${age(generatedAt)})` : ""}`)));
    if (overall) for (const line of wrap(overall, Math.max(10, width - 2)).slice(0, 2)) lines.push(fg("dim", clip(`≡ ${line}`)));
    if (chain) lines.push(fg("dim", clip(chain)));
    lines.push(fg("dim", clip("─".repeat(Math.max(4, width - 2)))));

    const footerKeys = 1;
    const listHeight = Math.max(1, height - lines.length - footerKeys);
    if (!topics.length) {
      lines.push(fg("dim", clip("No topics yet — the outline builds as the session progresses.")));
    } else {
      // Rows need flat selection for stable keys across re-renders.
      const rows: { topicIndex: number; text: string; heading: boolean }[] = [];
      for (const [i, topic] of topics.entries()) {
        rows.push({ topicIndex: i, text: `#${topic.manual ? "!" : ""} ${topic.heading}`, heading: true });
        for (const bullet of topic.summary) {
          for (const line of wrap(bullet, Math.max(10, width - 4))) rows.push({ topicIndex: i, text: `  · ${line}`, heading: false });
        }
        if (!topic.summary.length) rows.push({ topicIndex: i, text: "  · (summary pending)", heading: false });
      }
      // Ensure the selected topic's heading row is visible.
      this.selected = Math.max(0, Math.min(topics.length - 1, this.selected));
      const selRowIdx = rows.findIndex(row => row.heading && row.topicIndex === this.selected);
      if (selRowIdx < this.scroll) this.scroll = selRowIdx;
      if (selRowIdx >= this.scroll + listHeight) this.scroll = selRowIdx - listHeight + 1;
      this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, rows.length - listHeight)));
      for (const row of rows.slice(this.scroll, this.scroll + listHeight)) {
        const selected = row.topicIndex === this.selected;
        const text = clip(`${selected && row.heading ? ">" : " "} ${row.text}`);
        lines.push(selected ? this.theme.bg("selectedBg", this.theme.fg("accent", text)) : fg(row.heading ? "text" : "muted", text));
      }
    }
    lines.push(fg("dim", clip("↑↓ select · Enter jump · r refresh · q/esc close")));
    return lines.slice(0, height).map(clip);
  }
}

/** Read-only fallback when transcript scrolling is unavailable (regular mode, compaction, other branch). */
export class PeekPanel implements Component, Focusable {
  focused = true;

  constructor(
    private readonly theme: Theme,
    private readonly heading: string,
    private readonly body: () => string,
    private readonly height: () => number,
    private readonly done: () => void,
  ) {}

  handleInput(): void { this.done(); }
  invalidate(): void {}

  render(width: number): string[] {
    width = Math.max(0, Math.floor(width));
    const height = Math.max(0, Math.floor(this.height()));
    if (!width || !height) return [""];
    const clip = (line: string) => truncateToWidth(line, width, "");
    const lines = [
      this.theme.fg("accent", clip(`§ ${this.heading}`)),
      this.theme.fg("dim", clip("Original message (no transcript scroll available)")),
      this.theme.fg("dim", clip("─".repeat(Math.max(4, width - 2)))),
    ];
    for (const raw of this.body().split("\n").slice(0, 40)) {
      for (const line of wrap(raw, Math.max(10, width - 2))) lines.push(clip(line));
      if (lines.length >= height - 1) break;
    }
    lines.push(this.theme.fg("dim", clip("any key closes")));
    return lines.slice(0, height).map(clip);
  }
}
