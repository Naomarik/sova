import { startIngress, stopIngress } from "./ingress";
import { startShareListener, stopShareListener } from "./listener";

/**
 * Everything that serves public links on this host, started and stopped as one (server/index.ts
 * calls only these). Complete as written: the share listener (bound from the environment today,
 * later from the setting, with the gateway's router as its hooks) and a routed host's ingress each
 * follow the setting themselves (setting-events), so this file never changes.
 */

export async function startShareRuntime(): Promise<void> {
  await Promise.all([startShareListener(), startIngress()]);
}

export function stopShareRuntime(): void {
  stopIngress();
  stopShareListener();
}
