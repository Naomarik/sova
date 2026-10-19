import { createEffect, createMemo, on } from "solid-js";
import type { PaletteContext } from "./palette";
import { createArm } from "./two-step";

type Session = PaletteContext["session"];

/** What happens to a command's panel: its button pressed, or any field changed. */
export type PanelEvent = "press" | "edit";

/**
 * The panel's two-step (§app.command-palette/command-panel): a command that only reads runs on a
 * press; one that changes something arms on the first press and runs on the next. Any edit disarms,
 * so a run only ever uses the values the armed button stood over.
 */
export function panelStep(armed: boolean, ev: PanelEvent, changes: boolean): { armed: boolean; run: boolean } {
  if (ev === "edit") return { armed: false, run: false };
  if (!changes) return { armed: false, run: true };
  return armed ? { armed: false, run: true } : { armed: true, run: false };
}

/**
 * A command panel's button (§app.command-palette/command-panel): a command that changes something
 * arms on the first press and runs on the second. The arming holds the session it stood over: the
 * run goes to that session, and the open session changing (another chat, the Overseer, Back)
 * disarms it, so a press after navigating arms again on the new session instead of running.
 */
export function createPanelArm(o: { changes: boolean; session(): Session; run(session: Session): void }) {
  const { armed, arm, reset, disarm } = createArm<{ session: Session }>();
  const path = createMemo(() => o.session()?.path ?? null); // the same session redrawn keeps it armed
  createEffect(on(path, () => reset(), { defer: true }));
  return {
    armed: () => armed() !== null,
    /** The button pressed: arms, or runs with the session the arming captured (a plain read: now's). */
    press(): "armed" | "ran" {
      const step = panelStep(armed() !== null, "press", o.changes);
      const held = armed();
      if (step.armed) arm({ session: o.session() });
      else reset();
      if (step.run) o.run(held ? held.session : o.session());
      return step.run ? "ran" : "armed";
    },
    /** Any field edit disarms: a run only ever uses the values the armed button stood over. */
    edit(): void {
      if (!panelStep(armed() !== null, "edit", o.changes).armed) reset();
    },
    /** The button left. */
    blur(): void {
      const held = armed();
      if (held) disarm(held);
    },
  };
}
