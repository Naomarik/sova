import type { IncomingMessage, ServerResponse } from "node:http";

export interface MockLineageSummary {
  gen: number;
  account: string;
  revoked: boolean;
  refreshes: number;
  invalidGrants: number;
  refreshSha256: string;
  accessSha256: string;
}
export interface MockEvent {
  at: number;
  ip: string;
  lineage: string | null;
  gen: number | null;
  outcome: string;
}
export interface MockTokenState {
  events: MockEvent[];
  login(opts?: { shape?: "pi" | "claude"; account?: string; accessTtlS?: number }): { lineage: string; credential: Record<string, any> };
  refresh(refreshToken: unknown, ip?: string): { status: number; body: Record<string, unknown> };
  revoke(token: unknown, ip?: string): { status: number; body: Record<string, unknown> };
  summary(): Record<string, MockLineageSummary>;
  reset(): void;
}
export function createMockTokenState(opts?: { accessTtlS?: number; refreshTtlS?: number; now?: () => number }): MockTokenState;
export function createHandler(state: MockTokenState): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
