/**
 * A Sova chat keeps its prompt cache warm only while a reply streams (quirk P47 no-idle-warming).
 *
 * pi 1.5.1 made `cacheWarming` default to "idle": after a run settles it goes on re-sending the
 * request's prefix, for up to 30 minutes, whenever its sums say a next turn would pay for it. For a chat
 * nobody may come back to (a finished worker never continues) that is spend with nothing to show, so
 * Sova's chats stay on what they had through 1.5.0, pi's "streaming" mode: warming ends when the run
 * settles. pi's warmer asks its settings manager's getter at each decision, so the getter of this
 * runtime's own settings object answers "streaming" where the settings say "idle" (set or by default);
 * "off" and "streaming" pass as they are. Never `setCacheWarmingMode`: it saves into settings.json,
 * which the user's terminal pi reads too, and the terminal keeps pi's own default.
 */
export function warmOnlyWhileStreaming(settings: { getCacheWarmingMode(): string }): void {
  const fromSettings = settings.getCacheWarmingMode.bind(settings);
  settings.getCacheWarmingMode = () => {
    const mode = fromSettings();
    return mode === "idle" ? "streaming" : mode;
  };
}
