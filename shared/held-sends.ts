// What became of the messages one chat connection sent (§chat.transcript/send-while-starting).
// A connection that closes before its chat answered still owes each message an outcome: taken
// (acknowledged), or refused, in which case its text goes back to the chat's draft (a confirm card's
// click never does: draftTexts). The server
// keeps one of these per chat socket (server/ws.ts) to put the text back when no tab is left to
// hear the refusal; the web app's courier (src/lib/chat-outbox.ts) keeps one for a socket whose
// view has closed. Pure: no I/O, so both tiers test it directly.

/** Frames longer than this are never an answer (an ack or an error is small); only a hello is. */
export const ANSWER_MAX_CHARS = 64 * 1024;

/** A send handed back: its client id and text; `card` when it was a click on that confirm card. */
export interface Unsent {
  id: string;
  text: string;
  card?: string;
}

/** The texts of sends handed back that may go into a draft: a confirm card's click never does, since
    sent again from the composer it would be typed text, which approves nothing (§app.overseer/confirm). */
export const draftTexts = (back: readonly Unsent[]): string[] => back.filter((u) => u.card === undefined).map((u) => u.text);

export class HeldSends {
  private readonly texts = new Map<string, string>();
  /** The held sends that are a confirm card's click: their card. */
  private readonly cards = new Map<string, string>();
  private helloSeen = false;

  /** Prompts and steers sent and not yet answered. */
  get size(): number {
    return this.texts.size;
  }

  /** Whether a frame from the chat can matter: a send is held, or the chat's hello hasn't come yet. */
  get listening(): boolean {
    return this.texts.size > 0 || !this.helloSeen;
  }

  /** A frame this connection sent: a prompt or steer with a client id is held until answered. */
  sent(msg: unknown): void {
    if (!msg || typeof msg !== "object") return;
    const m = msg as { type?: unknown; clientId?: unknown; text?: unknown; confirm?: unknown };
    if (m.type !== "prompt" && m.type !== "steer") return;
    if (typeof m.clientId !== "string" || !m.clientId) return;
    this.texts.set(m.clientId, typeof m.text === "string" ? m.text : "");
    if (m.type === "prompt" && typeof m.confirm === "string" && m.confirm) this.cards.set(m.clientId, m.confirm);
  }

  private unsent(id: string, text: string): Unsent {
    const card = this.cards.get(id);
    this.cards.delete(id);
    return card === undefined ? { id, text } : { id, text, card };
  }

  /** Every send still held, oldest first; none held after. */
  takeAll(): Unsent[] {
    const out = [...this.texts].map(([id, text]) => this.unsent(id, text));
    this.texts.clear();
    this.cards.clear();
    return out;
  }

  /**
   * A frame the chat sent this connection. Returns the sends it refused (each once, oldest first),
   * which go back to the draft; an acknowledgement settles its send and returns none.
   * - `send_ack`: taken.
   * - `error` naming a held send: refused (a model turned off, a busy file, a chat that couldn't open).
   * - `error` code `reloaded`, a `closed`, or an `error` before the chat's hello: the chat is going
   *   or never opened, so nothing still held was taken.
   */
  heard(frame: unknown): Unsent[] {
    if (!frame || typeof frame !== "object") return [];
    const f = frame as { type?: unknown; clientId?: unknown; code?: unknown };
    if (f.type === "hello") {
      this.helloSeen = true;
      return [];
    }
    if (this.texts.size === 0) return [];
    const id = typeof f.clientId === "string" ? f.clientId : undefined;
    if (f.type === "send_ack") {
      if (id) this.texts.delete(id);
      if (id) this.cards.delete(id);
      return [];
    }
    if (f.type === "closed") return this.takeAll();
    if (f.type !== "error") return [];
    if (id) {
      const text = this.texts.get(id);
      if (text === undefined) return [];
      this.texts.delete(id);
      return [this.unsent(id, text)];
    }
    if (f.code === "reloaded" || !this.helloSeen) return this.takeAll();
    return [];
  }

  /** The same, for a frame already serialized: parsed only when it can be an answer. */
  heardJson(json: string): Unsent[] {
    if (json.length > ANSWER_MAX_CHARS) {
      if (json.slice(0, 64).includes('"type":"hello"')) this.helloSeen = true;
      return [];
    }
    if (!this.listening) return [];
    let frame: unknown;
    try {
      frame = JSON.parse(json);
    } catch {
      return [];
    }
    return this.heard(frame);
  }
}
