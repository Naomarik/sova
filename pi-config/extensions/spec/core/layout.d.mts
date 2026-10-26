// Types for layout.mjs, the one reader and writer of a spec's records (so TypeScript callers typecheck).
export type SpecRecord = { kind?: string; code?: string[]; requires?: string[]; [key: string]: unknown };
export type Records = Record<string, SpecRecord>;
export type Manifest = { formatVersion?: unknown; grammar?: { claimsRoot?: string; directoryKinds?: string[]; [k: string]: unknown }; claims?: unknown; [key: string]: unknown };
export type Problem = { code: string; message: string; file?: string; id?: string };
export type Layout = 1 | 2;
export type Assembled = {
  layout: Layout;
  manifest: (Manifest & { claims: Records }) | null;
  meta: Record<string, unknown>;
  records: Records;
  fileOf: Map<string, string> | null;
  recordFiles: string[];
  problems: Problem[];
};
export type SpecRead =
  | { state: "absent" }
  | { state: "error"; message: string }
  | (Assembled & { state: "present"; rootText: string; claimFiles: string[]; claimBodies?: Map<string, string> });

export declare const ROOT_FILE: "manifest.json";
export declare const CLAIMS_POINTER: string;
export declare const DEFAULT_SPEC: ".sova/spec";
export declare function canonRecord(v: unknown): string | null;
export declare function canonRecords(records: Records | Iterable<[string, SpecRecord]>): string;
export declare function layoutOf(rootObj: unknown): Layout;
export declare function claimsRootOf(rootObj: unknown): string | null;
export declare function dirKindsOf(rootObj: unknown): string[];
export declare function claimFileOf(id: string, dirKinds?: string[]): string;
export declare function recordFileOf(id: string, dirKinds?: string[]): string;
export declare function isRecordFile(rel: string, claimsRoot?: string): boolean;
export declare function mixedFix(where?: { root?: string; draft?: string; merging?: boolean }): string;
export declare function withNewRecords<T>(claims: Record<string, T>, added: Record<string, T>): Record<string, T>;
export declare function assemble(rootObj: Manifest, recordTexts?: Map<string, string>, claimFiles?: Set<string>, options?: { fix?: string | (() => string); specRel?: string }): Assembled;
export declare function serialize(layout: Layout, manifest: Manifest, options?: { prevRecordFiles?: string[] }): Map<string, string | null>;
export declare function recordFileText(records: Records): string;
export declare function split(manifest: Manifest, prevRecordFiles?: string[]): Map<string, string | null>;
export declare function join1(manifest: Manifest, prevRecordFiles?: string[]): Map<string, string | null>;
export declare function hasSpec(dir: string, specRel?: string): boolean;
export declare function isMerging(root: string): boolean;
export declare function fixFor(root: string, specRel?: string): () => string;
export declare function readSpecFs(root: string, specRel?: string, options?: { withProse?: boolean; read?: (rel: string) => string }): SpecRead;
export declare function gitBlobs(root: string, specs: string[]): Map<string, string | null> | { error: string };
export declare function readSpecGit(root: string, commit: string, options?: { prefix?: string; specRel?: string; withProse?: boolean; blobs?: typeof gitBlobs }): SpecRead;
export declare function readRecords(root: string, options?: { specRel?: string; at?: string; prefix?: string }): { layout: Layout; meta: Record<string, unknown>; records: Records } | null;
