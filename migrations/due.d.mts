// Types for due.mjs.
export declare const versionCore: (v: string) => [number, number, number] | null;
export declare function readMigrations(root?: string): { id: string; what: string; since: string; removeIn: string; paths: string[] }[];
export declare function migrationsDue(version: string, list?: { id: string; removeIn: string }[]): { id: string; removeIn: string }[];
