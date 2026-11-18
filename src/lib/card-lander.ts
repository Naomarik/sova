/**
 * A chat's landing on the card it opens on (a chat that holds nothing but a playbook's card,
 * §chat.playbooks/run-card). The view goes to the card when the card is drawn, however long after
 * the chat opened that is, and again while what stands above the card settles (the chat's opening
 * lines are still being read in and push it down). It never moves a view the reader has taken:
 * their first scroll, touch, press or key since the chat opened ends it for good, so a card that
 * arrives late leaves a view they already moved where it is. DOM- and Solid-free: the page hands in
 * what it listens with.
 */
export interface LandingHost {
  /** Calls back at each input of the reader's on the chat's view; returns its stop. */
  onInput(cb: () => void): () => void;
  /** Calls back whenever what stands above the card changes size; returns its stop. */
  onSettle(cb: () => void): () => void;
  /** Calls back once after `ms`; returns its cancel. */
  later(ms: number, cb: () => void): () => void;
}

export interface CardLander {
  /** The card is drawn: `land` runs now and as things settle, for the settling time. Returns its stop (the card left). */
  drawn(land: () => void): () => void;
  /** The chat's view closed. */
  close(): void;
}

/** Made when the chat's view opens: the reader's input counts from then. */
export function cardLander(host: LandingHost, settleMs: number): CardLander {
  let theirs = false;
  /** The landings under way, each ended by the reader's input. */
  const ends = new Set<() => void>();
  const stopInput = host.onInput(() => {
    theirs = true;
    for (const end of [...ends]) end();
  });
  return {
    drawn(land) {
      if (theirs) return () => {};
      let over = false;
      const again = () => !over && land();
      const stopSettle = host.onSettle(again);
      const cancel = host.later(settleMs, () => end());
      const end = () => {
        if (over) return;
        over = true;
        ends.delete(end);
        stopSettle();
        cancel();
      };
      ends.add(end);
      land();
      return end;
    },
    close() {
      for (const end of [...ends]) end();
      stopInput();
    },
  };
}
