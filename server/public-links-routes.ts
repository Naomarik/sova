import type { Hono } from "hono";

/**
 * Settings → Public links (§mesh.public/setting): GET and PUT /api/public-links and POST
 * /api/public-links/verify (shared/public-links.ts), main listener only. Mounts nothing yet: those
 * paths answer as they did before.
 */
export function mountPublicLinks(app: Hono): void {
  void app;
}
