// Types for index.mjs (migrations/manifest.json: playbook-config-old-place).
export declare const oldConfigDir: (id: string) => string;
export declare function configDirOf(id: string, dir: string, has: (rel: string) => boolean): string;
export declare function configDirOfAsync(id: string, dir: string, has: (rel: string) => Promise<boolean>): Promise<string>;
