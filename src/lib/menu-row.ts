// One of Sova's own menu rows, as data: what it says, why it can't run, and what pressing it does.
// A place lists its rows once (lib/group-menu, lib/pane-menu, lib/worktree-menu) and both its doors
// — its ⋯ and a right-click or Shift+F10 on it (§app/context-menus) — draw that one list
// (components/MenuRows.tsx), so the doors can't drift and a test can press each row without a DOM.

import type { IconName } from "../components/ui";

/** An ActionMenu Item's props, its icon named, its act a plain function. */
export interface MenuRow {
  label: string;
  aria: string;
  title?: string;
  /** Absent: a row with no icon. */
  icon?: IconName;
  description?: string;
  /** Why it can't run, or absent/"" when it can. */
  disabled?: string;
  /** A row that goes somewhere is a link; `run` is not called. */
  href?: string;
  keepFocus?: boolean;
  stayOpen?: boolean;
  run?(): void;
}
