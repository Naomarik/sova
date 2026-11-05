/**
 * Whether a settings document reaches another computer right now (§chat.create-mode/after-a-change): sync's own
 * reading, so a card says "by sync" only when a peer would receive it. Unset: no sync runs here.
 */
let probe: (() => boolean) | null = null;
export const setSettingsSpreadProbe = (p: (() => boolean) | null): void => void (probe = p);
export const settingsSpreadNow = (): boolean => probe?.() ?? false;
