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

  sent(clientId: string, text: string): void {
    this.texts.set(clientId, text);
  }

  /** Acknowledged, refused or gone from the queue: no longer this pane's to hand back. */
  settled(clientId: string | undefined): void {
    if (clientId) this.texts.delete(clientId);
  }

  /** A refusal naming it: its text, once (`handedBack` remembers it), else null. */
  take(clientId: string | undefined, handedBack: Set<string>): string | null {
    const text = clientId ? this.texts.get(clientId) : undefined;
    if (!clientId || text === undefined) return null;
    this.texts.delete(clientId);
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
    return out;
  }
}
