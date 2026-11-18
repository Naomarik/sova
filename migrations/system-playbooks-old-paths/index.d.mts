// Types for index.mjs (migrations/manifest.json: system-playbooks-old-paths).
export declare const MOVED_TO_SYSTEM: readonly string[];
export declare function movedPlaybookDir(dir: string, exists?: (p: string) => boolean): string;
export declare function movedPlaybookLines(texts: readonly string[], exists?: (p: string) => boolean): string[];
