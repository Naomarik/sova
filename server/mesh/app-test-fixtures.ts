// Tests: Sova's app with every route and nothing started (server/app.ts's buildApp: no listener, no
// mesh runtime, no helper process), for route tests through app.request. Import it only after the
// test has set its environment (PI_CODING_AGENT_DIR and friends): the app reads them as it builds.
import type { Hono } from "hono";

/** The app, built once per process (buildApp refuses a second build). */
export async function testApp(): Promise<Hono> {
  const { buildApp } = await import("../app");
  return buildApp({ extensionEntriesOf: async () => [] }).app;
}
