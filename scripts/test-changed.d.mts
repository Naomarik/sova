// Types for test-changed.mjs (server/run-tests-changed.test.ts imports it).
export function changedSince(root: string, base: string): string[];
export function resolveImport(root: string, fromFile: string, spec: string): string | null;
export function affected(root: string, files: string[], changed: string[]): string[];
