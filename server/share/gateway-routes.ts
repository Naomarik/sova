import type { Hono } from "hono";
import type { MeshApi } from "../mesh";

/**
 * A gateway's peer routes (§mesh.public/registry), under /api/peer/share-gateway/* so only the
 * peer listener's verified caller reaches them: GET info -> GatewayInfo, PUT links body
 * RegistrySnapshot -> RegistryAck (shared/public-links.ts). Mounts nothing yet: those paths answer
 * as they did before.
 */
export function mountShareGateway(app: Hono, mesh: MeshApi): void {
  void app;
  void mesh;
}
