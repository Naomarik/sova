// Types for fixed-wait-scan.mjs (scripts/fixed-wait-scan.test.ts imports it).
export type Wait = { file: string; line: number; ms: number };
export const LIMIT_MS: number;
export function isTestFile(file: string): boolean;
export function waitsIn(line: string): number[];
export function addedLines(diff: string): { file: string; line: number; text: string }[];
export function scan(o: { cwd?: string; base: string }): Wait[];
