/**
 * Whether what `children()` resolved to draws anything. Solid's control flow makes "nothing" several
 * things: a `<Show>` that is off gives undefined, and a `<For>` with no items gives [], which is
 * truthy, so a resolved child can't gate its own wrapper by itself. Arrays nest; booleans, null,
 * undefined and "" draw nothing, as they do when Solid inserts them.
 */
export function rendersSomething(resolved: unknown): boolean {
  if (Array.isArray(resolved)) return resolved.some(rendersSomething);
  return resolved !== null && resolved !== undefined && typeof resolved !== "boolean" && resolved !== "";
}
