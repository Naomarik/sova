// Types for sova-scenario.mjs (server/scenarios.integration.test.ts imports it).
import type { HermeticServer } from "../server/testing/hermetic-server.ts";

export interface Scenario {
  name: string;
  about?: string;
  steps: unknown[];
}
export interface ScenarioResult {
  name: string;
  ok: boolean;
  /** Spawn to first healthy answer, in ms. */
  bootMs: number;
  ms: number;
  steps: { name: string; ms: number; ok: boolean }[];
  failure?: string;
  /** What changed in the sentinel HOME ("added|removed|changed <path>"). */
  homeChanges: string[];
}
export function mismatch(want: unknown, actual: unknown, at?: string): string | null;
export function fill<T>(value: T, vars: Record<string, unknown>): T;
export class ScenarioFailure extends Error {}
export function runScenario(doc: Scenario, opts?: { keep?: boolean; afterBoot?: (server: HermeticServer) => unknown; log?: (line: string) => void }): Promise<ScenarioResult>;
export function scenarioFiles(paths: string[]): string[];
export function loadScenario(file: string): Scenario;
