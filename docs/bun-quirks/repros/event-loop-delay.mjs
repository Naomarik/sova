// bun event-loop-delay.mjs  vs  node event-loop-delay.mjs
// A 300 ms stall at 250 ms, sampled at 200 ms resolution, read at 2 s.
// Node: each sample is the whole timer interval, resolution included (p50 ~200 ms, max ~360 ms).
// Bun 1.4.2: each sample is only the timer's lateness (p50 ~0.2 ms, max ~150 ms). Node's docs and
// code written for Node subtract the resolution from a sample, which reads 0 (or less) on Bun.
import { monitorEventLoopDelay } from "node:perf_hooks";
const h = monitorEventLoopDelay({ resolution: 200 });
h.enable();
setTimeout(() => { const t = Date.now(); while (Date.now() - t < 300); }, 250);
setTimeout(() => {
  console.log({ count: h.count, p50Ms: h.percentile(50) / 1e6, maxMs: h.max / 1e6 });
  process.exit(0);
}, 2000);
