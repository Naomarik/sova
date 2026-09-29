import { createSignal } from "solid-js";

/**
 * Whether the Resource Monitor is open, app-wide. A module signal like Settings' (settings-nav.ts),
 * so the sidebar's Usage-row button and the collapsed spine open it without a route; the modal
 * polls only while this is true.
 */
const [open, setOpen] = createSignal(false);

export const monitorOpen = open;

export function openMonitor(): void {
  setOpen(true);
}

export function closeMonitor(): void {
  setOpen(false);
}
