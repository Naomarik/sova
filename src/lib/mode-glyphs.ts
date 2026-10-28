import type { IconName } from "../components/ui";

/**
 * The mode icons (§chat.mode-menu/trigger, /menu): one for the major mode (normal has none of its
 * own: the sliders icon stands for it), one per built-in minor mode, and a project mode's id's first
 * letter in a rounded square. The trigger, the menu's rows (its legend) and the profile cards draw
 * the same glyph for the same mode.
 */
export type ModeGlyph = { kind: "icon"; id: string; icon: IconName } | { kind: "letter"; id: string; letter: string };

const MAJOR_ICONS: Record<string, IconName> = { delegate: "mode-delegate" };
const MINOR_ICONS: Record<string, IconName> = {
  align: "mode-align",
  spec: "mode-spec",
  vis: "mode-vis",
  codemode: "mode-codemode",
  memory: "mode-memory",
};

/** A major mode's glyph: its own icon, else (normal, or one this build doesn't know) the sliders. */
export const majorGlyph = (mode: string): ModeGlyph => ({ kind: "icon", id: mode, icon: MAJOR_ICONS[mode] ?? "sliders" });

/** The letter a project mode shows: its id's first letter or digit, upper case ("?" for none). */
export const modeLetter = (id: string): string => (/[\p{L}\p{N}]/u.exec(id)?.[0] ?? "?").toUpperCase();

/** A minor mode's glyph: a built-in's icon, else (a project mode) its letter. */
export const minorGlyph = (id: string): ModeGlyph => (MINOR_ICONS[id] ? { kind: "icon", id, icon: MINOR_ICONS[id]! } : { kind: "letter", id, letter: modeLetter(id) });

/** The trigger's glyphs, in its order: the major mode, each built-in minor on, each project mode on. */
export function modeGlyphs(mode: string | null | undefined, minors: readonly string[] = [], project: readonly string[] = []): ModeGlyph[] {
  return [...(mode ? [majorGlyph(mode)] : []), ...minors.map(minorGlyph), ...project.map((id) => ({ kind: "letter" as const, id, letter: modeLetter(id) }))];
}
