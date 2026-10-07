/**
 * Tests only (nothing in the server imports this). Waits for something the test cannot await
 * directly (a watch event, a socket's frame, another module's fire-and-forget step): polls `cond`
 * until it holds. The guard is generous on purpose: it only turns a hang into a failure naming
 * `what`, and is never the thing a test measures, so a loaded machine slows the test, never fails it.
 */
export async function until(cond: () => unknown, what = "the condition", guardMs = 30_000, everyMs = 5): Promise<void> {
  const end = Date.now() + guardMs;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`still waiting after ${guardMs} ms for ${what}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}
