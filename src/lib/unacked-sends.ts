/**
 * The sends a pane made that the server has not acknowledged yet: prompts, steers and commands, by
 * client id. A chat that reloads or stops tells the pane to reconnect (`error` code reloaded), and
 * the pane reconnects at once under a new client id, so a refusal of a send the closing chat never
 * took can't reach it any more. What was never acknowledged goes back to the draft then, once (a
 * command makes no user row, and an acknowledged direct prompt still reads "sending", so the rows
 * can't tell). A command the chat took is acknowledged before it runs, so it never comes back.
 */
export class UnackedSends {
  private readonly texts = new Map<string, string>();
  /** The connection each send went out on (lib/chat-wait `conn`). */
  private readonly conns = new Map<string, number>();

  sent(clientId: string, text: string, conn = 0): void {
    this.texts.set(clientId, text);
    this.conns.set(clientId, conn);
  }

  /** Acknowledged, refused or gone from the queue: no longer this pane's to hand back. */
  settled(clientId: string | undefined): void {
    if (!clientId) return;
    this.texts.delete(clientId);
    this.conns.delete(clientId);
  }

  /** A refusal naming it: its text, once (`handedBack` remembers it), else null. */
  take(clientId: string | undefined, handedBack: Set<string>): string | null {
    const text = clientId ? this.texts.get(clientId) : undefined;
    if (!clientId || text === undefined) return null;
    this.texts.delete(clientId);
    this.conns.delete(clientId);
    if (handedBack.has(clientId)) return null;
    handedBack.add(clientId);
    return text;
  }

  /** The chat is gone from under the pane: every text never acknowledged, oldest first, each once; then none. */
  takeAll(handedBack: Set<string>): string[] {
    const out: string[] = [];
    for (const [id, text] of this.texts) {
      if (handedBack.has(id)) continue;
      handedBack.add(id);
      out.push(text);
    }
    this.texts.clear();
    this.conns.clear();
    return out;
  }

  /** The sends made on connection `conn` still unanswered, by client id, oldest first; kept here. */
  of(conn: number): Map<string, string> {
    const out = new Map<string, string>();
    for (const [id, text] of this.texts) if (this.conns.get(id) === conn) out.set(id, text);
    return out;
  }

  /** Connection `conn` ended before its chat's hello: the texts sent on it alone, oldest first, each
      once. Sends made on an earlier connection stay: that chat may have taken them. */
  takeFrom(conn: number, handedBack: Set<string>): string[] {
    const out: string[] = [];
    for (const [id, text] of [...this.texts]) {
      if (this.conns.get(id) !== conn) continue;
      this.texts.delete(id);
      this.conns.delete(id);
      if (handedBack.has(id)) continue;
      handedBack.add(id);
      out.push(text);
    }
    return out;
  }
}
