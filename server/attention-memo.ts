// The attention digest is memoized for a few seconds (server/overseer.ts). A route that just changed
// what it lists (a baton hand-off, a link, Take Back, an approval) drops the memo, so the next read
// — the Needs you region re-reads at once after such an action — says so. A registry rather than an
// import: the routes stay free of the Overseer's module graph.

let drop: (() => void) | null = null;

/** The digest's owner registers how to drop its memo. */
export const onAttentionChanged = (fn: () => void): void => {
  drop = fn;
};

/** Something the digest lists changed: its next read is fresh. */
export const attentionChanged = (): void => drop?.();
