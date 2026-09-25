export type RefreshOutcome =
  | "not_needed"
  | "no_refresh_token"
  | "refreshed"
  | "ok"
  | "invalid_grant"
  | "raced"
  | "refused-symlink"
  | "missing"
  | "invalid";
export function readStore(dir: string): { state: "ok" | "missing" | "refused-symlink" | "invalid"; data?: any };
export function writeInPlace(dir: string, data: unknown): void;
export function refresh(
  dir: string,
  mockUrl: string,
  opts?: { force?: boolean; lockAttempts?: number; lockBackoffMs?: () => number; now?: () => number },
): Promise<RefreshOutcome>;
export function login(dir: string, mockUrl: string, opts?: { account?: string; accessTtlS?: number }): Promise<{ lineage: string; state: string }>;
export function logout(dir: string, mockUrl?: string): Promise<void>;
export function status(dir: string): { state: string; expiresAt?: number; refreshSha256?: string | null };
