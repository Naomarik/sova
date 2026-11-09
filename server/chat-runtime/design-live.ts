// A design session's page, while it is written, going out to the server. Runs in
// the design worker's process: reads the harness's stream deltas (worker-feed.ts never carries these),
// decodes the page as it arrives, and sends appended slices at a few a second over the chat link.
// Holds the whole page written so far, so a link that came back can be told it again from the start.
import type { HarnessEvent } from "../../shared/harness";
import { DESIGN_PAGE_END, DESIGN_PAGE_START } from "../../pi-config/extensions/mode/design-guide.ts";
import { HtmlArgDecoder, ReplyPageDecoder } from "../design/stream-decode";

/** Slices sent per second: the card redraws at about 3 Hz (t10, E3). */
export const DESIGN_LIVE_EVERY_MS = 300;

export interface DesignLiveFrame {
  /** Numbers the page within this process: each page written starts a new one. */
  gen: number;
  /** Where in the page `text` starts. A receiver not holding exactly `at` characters resyncs. */
  at: number;
  text: string;
}

interface LiveClock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(t: unknown): void;
}
const realClock: LiveClock = {
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clearTimeout: (t) => clearTimeout(t as NodeJS.Timeout),
};

export class DesignLive {
  private gen = 0;
  private page = "";
  private sent = 0;
  private timer: unknown = null;
  private tools = new Map<number, HtmlArgDecoder>();
  private reply: ReplyPageDecoder | null = null;

  constructor(
    private readonly send: (f: DesignLiveFrame) => void,
    private readonly everyMs = DESIGN_LIVE_EVERY_MS,
    private readonly clock: LiveClock = realClock,
  ) {}

  attach(session: { subscribe(fn: (event: HarnessEvent) => void): () => void }): () => void {
    return session.subscribe((e) => this.onEvent(e));
  }

  private onEvent(e: HarnessEvent): void {
    if (e.type === "message.start" && e.role === "assistant") {
      this.endPage();
      this.tools = new Map();
      this.reply = new ReplyPageDecoder(DESIGN_PAGE_START, DESIGN_PAGE_END);
      return;
    }
    if (e.type === "message.end" || e.type === "run.settled") return this.endPage();
    if (e.type !== "message.update" || e.role !== "assistant" || !e.stream) return;
    const s = e.stream;
    if (s.kind === "tool-call") {
      let d = this.tools.get(s.index ?? -1);
      if (!d) this.tools.set(s.index ?? -1, (d = new HtmlArgDecoder()));
      this.add(d.feed(s.delta));
    } else if (s.kind === "text" && this.reply) {
      this.add(this.reply.feed(s.delta));
    } else if (s.kind === "tool-call.end" || s.kind === "text.end") {
      this.endPage();
    }
  }

  private add(text: string): void {
    if (!text) return;
    if (!this.page.length || this.isNew) this.begin();
    this.page += text;
    this.isNew = false;
    if (this.timer === null) this.timer = this.clock.setTimeout(() => this.flush(), this.everyMs);
  }

  /** Whether the next characters start a new page (a tool call or a reply ended since the last ones). */
  private isNew = false;

  /** What was written goes out, and what comes next is another page. */
  private endPage(): void {
    this.flush();
    this.isNew = this.page.length > 0;
  }

  private begin(): void {
    this.gen++;
    this.page = "";
    this.sent = 0;
  }

  private flush(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    if (this.page.length > this.sent) {
      const text = this.page.slice(this.sent);
      const at = this.sent;
      this.sent = this.page.length;
      this.send({ gen: this.gen, at, text });
    }
  }

  /** The link came back: the whole page so far, from the start. */
  resync(): void {
    if (!this.page.length) return;
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.sent = this.page.length;
    this.send({ gen: this.gen, at: 0, text: this.page });
  }
}
