/**
 * Which sessions' setup card has its System context fold open, by session path. Kept in this
 * module only, so the card redrawn after a profile pick or a switch flip (the runtime reopens, the
 * empty state may remount) opens as it was; never saved, so a page reload starts closed.
 */
const open = new Set<string>();

export const setupContextOpen = (path: string): boolean => open.has(path);

export function setSetupContextOpen(path: string, on: boolean): void {
  if (on) open.add(path);
  else open.delete(path);
}
