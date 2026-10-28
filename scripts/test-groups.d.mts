// Types for test-groups.mjs (server/test-groups.test.ts imports it).
export type Group = { name: string; title: string; files: string[]; except: string[]; landing: "triggered" | "never"; triggers: string[] };
export type Skipped = { name: string; title: string; why: "untriggered" | "never" | "not asked"; files: number; hits: string[] };
export const GROUPS: Group[];
export const EVERYDAY: string;
export function globRe(glob: string): RegExp;
export function groupOf(file: string, groups?: Group[]): Group | null;
export function triggersHit(changed: string[], groups?: Group[]): Record<string, string[]>;
export function selectFiles(
  files: string[],
  changed: string[],
  opts: { mode: "landing" | "changed" | "groups"; closure?: (files: string[]) => string[]; only?: string[]; groups?: Group[] },
): { files: string[]; ran: string[]; skipped: Skipped[]; hits: Record<string, string[]> };
export function setKey(ran: string[]): string;
