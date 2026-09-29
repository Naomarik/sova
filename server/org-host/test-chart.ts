// A small JS chart for the host's tests (host.test.ts, kill9.test.ts): registered at runtime, never
// shipped. It emits an effect and waits for its answer, holds an act (`gather/start`, `hold`), runs a
// look invocation, arms a timer and keeps a counter.
type Data = Record<string, unknown>;
const assign = (data: Data) => [{ op: "assign", data }];
const outbox = (d: Data, e: Data) => [...((d["outbox"] as Data[]) ?? []), e];

export const HOST_CHART = [
  "statechart",
  {},
  [
    "state",
    { id: "top", initial: "idle" },
    ["transition", { event: "count" }, ["script", { expr: (d: Data) => assign({ n: ((d["n"] as number) ?? 0) + 1 }) }]],
    ["transition", { event: "effect/failed", target: "idle" }, ["script", { expr: (d: Data) => assign({ failed: ((d["failed"] as number) ?? 0) + 1 }) }]],
    [
      "state",
      { id: "idle" },
      ["transition", { event: "go", target: "busy" }, ["script", { expr: (d: Data) => assign({ outbox: outbox(d, { kind: "write", n: (d["n"] as number) ?? 0 }) }) }]],
      ["transition", { event: "gather/start", target: "gathering" }],
      ["transition", { event: "look", target: "looking" }],
      ["transition", { event: "wait", target: "timed" }],
    ],
    ["state", { id: "busy" }, ["transition", { event: "effect/done", target: "idle" }, ["script", { expr: (d: Data) => assign({ done: ((d["done"] as number) ?? 0) + 1 }) }]]],
    ["state", { id: "gathering" }, ["transition", { event: "gather/close", target: "idle" }]],
    ["state", { id: "looking" }, ["invoke", { id: "look", type: "sova/look" }], ["transition", { event: "look/finished", target: "idle" }]],
    ["state", { id: "timed" }, ["onEntry", {}, ["send", { event: "tick", delay: 50 }]], ["transition", { event: "tick", target: "idle" }]],
  ],
];

export const HOST_CHARTS = {
  "host-probe": {
    version: 1,
    storage: "portable",
    chart: HOST_CHART,
    acts: { "gather/start": { needs: null, hold: true, counts: "gather", what: "Gathering" } },
  },
  "host-local-probe": { version: 1, storage: "host-local", chart: HOST_CHART },
};
