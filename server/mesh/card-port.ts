import type { MeshResult } from "./index";

/**
 * The Mesh page's device actions a Create card's Apply runs (§chat.create-mode/settings-cards), set where each route
 * is mounted, so a card goes through the route's own code and its own checks.
 */
export interface MeshCardPort {
  browserAccess?(body: { id?: unknown; browserAccess?: unknown }): Promise<MeshResult>;
  resync?(peer: string): Promise<MeshResult>;
  /** Whether a resync of `peer` could start: a recipe, and no reason not to. */
  resyncProblem?(peer: string): Promise<string | null>;
}
const port: MeshCardPort = {};
export const setMeshCardPort = (p: Partial<MeshCardPort>): void => void Object.assign(port, p);
export const meshCardPort = (): MeshCardPort => port;
