import type { Tone } from "./core/grammar";

// Where a drawing's icons come from: the operator app serves them at /icons/; the share build,
// whose listener serves only its own assets, bundles the few a drawing it draws uses and points
// here at them (src/share/vis.tsx).
let resolve = (name: string): string => `/icons/${name}.svg`;

export const visIcon = (name: string): string => resolve(name);

/** A status never rests on hue alone: the tones that carry one also carry this icon (steps' status, matrix cells). */
export const TONE_ICON: Partial<Record<Tone, string>> = { ok: "check-circle", warn: "alert-circle", error: "x-circle", info: "info" };

export function setVisIcons(fn: (name: string) => string): void {
  resolve = fn;
}

/** A tone's word for a screen reader, where a cell's tone is shown (matrix): never only a colour. */
export const TONE_WORD: Record<Tone, string> = { accent: "highlighted", ok: "good", warn: "warning", error: "bad", info: "note", muted: "minor" };
