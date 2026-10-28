import { For, Show } from "solid-js";
import type { ModeGlyph as Glyph } from "../lib/mode-glyphs";
import { Icon } from "./ui";

/** One mode's glyph (§chat.mode-menu/trigger): its icon, or a project mode's letter in a rounded square. Decorative. */
export function ModeGlyph(props: { glyph: Glyph }) {
  return (
    <Show when={props.glyph.kind === "letter" ? props.glyph : null} fallback={<Icon name={(props.glyph as { icon: Parameters<typeof Icon>[0]["name"] }).icon} small class="mode-glyph" />}>
      {(g) => (
        <span class="mode-letter" aria-hidden="true">
          {g().letter}
        </span>
      )}
    </Show>
  );
}

/** A row of mode glyphs, in the order given. */
export function ModeGlyphs(props: { glyphs: readonly Glyph[] }) {
  return <For each={props.glyphs}>{(g) => <ModeGlyph glyph={g} />}</For>;
}
