import type { CardSheet } from "../../src/lib/mesh-resync";
import type { MeshResult } from "./index";

/**
 * The Mesh page's device actions a Create card's Apply runs (§chat.create-mode/settings-cards), set where each route
 * is mounted, so a card goes through the route's own code and its own checks.
 */
export interface MeshCardPort {
  browserAccess?(body: { id?: unknown; browserAccess?: unknown }): Promise<MeshResult>;
  /** Start the recipe, for exactly the commit the card showed. */
  resync?(peer: string, commit: string): Promise<MeshResult>;
  /** What the confirm sheet says of resyncing `peer` now, or why it can't start. */
  resyncSheet?(peer: string): Promise<CardSheet>;
}
const port: MeshCardPort = {};
export const setMeshCardPort = (p: Partial<MeshCardPort>): void => void Object.assign(port, p);
export const meshCardPort = (): MeshCardPort => port;
