// Types for official.mjs, for hosts that import the rule from TypeScript.
export function claimUnits(rel: string, buf: Buffer | null): Map<string, string>;
export function promotionClaims(rel: string, baseBuf: Buffer | null, propBuf: Buffer | null, wroteBuf: Buffer | null): Record<string, [string | null, string | null]>;
/** What a caller judging many drafts shares; each must answer as the default does for the same bytes. */
export interface DraftOfficialIo {
  read?(path: string): Buffer | null;
  hash?(path: string): string | undefined;
  cut?<T>(rel: string, buf: Buffer | null, cut: (rel: string, buf: Buffer | null) => T): T;
  json?<T>(dir: string, parse: (dir: string) => T): T;
  seen?(path: string): void;
}
export function draftOfficial(specDir: string, draftDir: string, draftsDir: string, io?: DraftOfficialIo): { official: boolean; changed: number; notOfficial: string[]; read: string[] } | undefined;
