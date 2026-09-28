import type { VisBase } from "./core/grammar";

/** What every kind's View receives: its parsed spec, and the accessible name of the figure. */
export interface ViewProps<S extends VisBase> {
  spec: S;
  label: string;
}
