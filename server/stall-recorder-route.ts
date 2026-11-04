import type { Context } from "hono";
import { matchedRoutes } from "hono/route";

/** A request's name on the board: its method and the pattern of the route that answers it, never
    the URL, whose path can carry a session's or a project's name and whose query can carry anything. */
export function routeOpName(c: Context): string {
  const routes = matchedRoutes(c);
  for (let i = routes.length - 1; i >= 0; i--) {
    const path = routes[i]!.path;
    if (path !== "*" && !path.endsWith("/*")) return `${c.req.method} ${path}`;
  }
  return `${c.req.method} (no route)`;
}
