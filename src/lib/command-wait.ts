// A "/word" sent before the chat has listed its commands (a new chat's first connect): the frame
// goes as any send, and whether it shows as a "Ran" row or as a message waits for the list. Pure,
// for the unit tier; ChatView keeps one per view.

/** A known slash command's name in `text`, or null: a "/word" the chat lists. */
export function commandOf(text: string, commands: readonly { name: string }[]): string | null {
  const name = /^\/(\S+)/.exec(text)?.[1];
  return name && commands.some((c) => c.name === name) ? name : null;
}

export class UnlistedSends<T extends { text: string; clientId: string }> {
  private listed = false;
  private held: T[] = [];

  /** Whether this send waits for the list: a "/word" before the chat has listed its commands. */
  hold(send: T): boolean {
    if (this.listed || !/^\/\S/.test(send.text)) return false;
    this.held.push(send);
    return true;
  }

  /** The list came (on any connection of the view): each held send, oldest first, but those `gone`
      (handed back meanwhile); none held after, and none held again. */
  listedNow(gone: (clientId: string) => boolean): T[] {
    this.listed = true;
    const out = this.held.filter((s) => !gone(s.clientId));
    this.held = [];
    return out;
  }

  /** These sends came back to the composer: none of them shows later. */
  drop(ids: ReadonlySet<string>): void {
    this.held = this.held.filter((s) => !ids.has(s.clientId));
  }
}
