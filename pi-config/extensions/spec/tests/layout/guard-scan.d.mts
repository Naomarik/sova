// Types for guard-scan.mjs, so server/spec-layout-boundary.test.ts typechecks.
export interface Hit { line: number; rule: string; text: string }
export interface Allowlist {
  _?: string;
  paths?: { glob: string; reason: string }[];
  lines?: Record<string, { rule: string; text: string; reason: string }[]>;
}
export const SOURCE: RegExp;
export const EXEMPT: RegExp[];
export const LAYOUT_MODULE: string;
export const RULES: Record<string, RegExp[]>;
export function scanText(text: string): Hit[];
export function isScanned(rel: string): boolean;
export function listSources(repo: string, roots: string[]): string[];
export function globRe(glob: string): RegExp;
export function compare(scans: Map<string, Hit[]>, allow: Allowlist): { problems: string[]; used: number; unlisted: (Hit & { file: string })[] };
export function scanRepo(repo: string, files: string[]): Map<string, Hit[]>;
export interface Replacement { file: string; rule: string; from: string; to: string }
export function growth(before: Allowlist, after: Allowlist, opts?: { textOf?: (rel: string) => string | null; replaced?: Replacement[] }): string[];
export function repoText(repo: string): (rel: string) => string | null;
export function committedAllowlist(repo: string, rel: string): { at: string; allow: Allowlist } | null;
export function draftAllowlist(scans: Map<string, Hit[]>, keep?: Allowlist): Allowlist;
export function loadAllowlist(path: string): Allowlist;
