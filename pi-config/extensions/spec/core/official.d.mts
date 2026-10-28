// Types for official.mjs, for hosts that import the rule from TypeScript.
export function claimUnits(rel: string, buf: Buffer | null): Map<string, string>;
export function promotionClaims(rel: string, baseBuf: Buffer | null, propBuf: Buffer | null, wroteBuf: Buffer | null): Record<string, [string | null, string | null]>;
export function draftOfficial(specDir: string, draftDir: string, draftsDir: string): { official: boolean; changed: number; notOfficial: string[]; read: string[] } | undefined;
