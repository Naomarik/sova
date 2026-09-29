// The in-place title field's one rule for how it ends (the Agents board's rename): pure, so it
// runs under `tsx --test`. The field keeps the title it OPENED with; the row's title can move
// under it (an Overseer title, the sweep, another tab) while it is open.

/**
 * What Enter or leaving an in-place title field does. `{ save }` writes that title (`null`
 * clears the user's title so the derived one comes back); `null` cancels, and nothing is written.
 * Empty on Enter clears; empty on leaving cancels. A value equal to the title the field opened
 * with is always a cancel — never a write of that old title over a newer one.
 */
export function inPlaceTitleEnd(opened: string, value: string, via: "enter" | "leave"): { save: string | null } | null {
  const v = value.trim();
  if (!v) return via === "enter" ? { save: null } : null;
  if (v === opened.trim()) return null;
  return { save: v };
}
