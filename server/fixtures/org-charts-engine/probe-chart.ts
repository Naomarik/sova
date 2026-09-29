// Test-only: the "engine-probe" chart as a JS tree, registered at runtime on the shipped bundle
// (`createEngine({charts: PROBE_CHARTS})`, org-charts/src/sova/org_charts/engine/js_chart.cljs) for the
// engine's TS tests and bench. A transcription of org-charts/src/sova/org_charts/engine/probe.cljs,
// which the CLJS tests run: keep the two in step, node for node. Each function gets the data model as
// JS (camelCase keys) and returns JSON; a script returns data-model operations.

type Data = { [key: string]: any };
type Node = [string, Record<string, unknown>, ...(Node | string)[]];

const evt = (d: Data): Data => d["_event"]?.data ?? {};

const bump = (k: string): Node => ["script", { expr: (d: Data) => [{ op: "assign", data: { [k]: (d[k] ?? 0) + 1 } }] }];

const effect = (kind: string): Node => [
  "script",
  {
    expr: (d: Data) => [
      { op: "assign", data: { outbox: [...(d["outbox"] ?? []), { kind, key: `${kind}/${d["seq"] ?? 0}` }] } },
      { op: "assign", data: { seq: (d["seq"] ?? 0) + 1 } },
    ],
  },
];

const rank: Record<string, number> = { L0: 0, L1: 1, L2: 2, L3: 3 };

const may = (need: string) => (d: Data) => {
  const { by, attended, level } = evt(d);
  return by === "operator" || attended === true || (rank[level] ?? -1) >= (rank[need] ?? 0);
};

const pick = (o: Data, keys: string[]): Data => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

export const probeChart: Node = [
  "statechart", { initial: "probe" },
  ["state", { id: "probe", initial: "running" },
    ["transition", { event: "probe/stop", target: "stopped" }],
    ["parallel", { id: "running" },

      // Region 1: a lane with nesting, deep history, a timer and an invocation.
      ["state", { id: "lane", initial: "flow" },
        ["state", { id: "flow", initial: "a" },
          ["history", { id: "flow-h", type: "deep" }, "a"],
          ["transition", { event: "hold", target: "held" }],
          ["state", { id: "a" },
            ["transition", { event: "next", target: "b" }]],
          ["state", { id: "b", initial: "b1" },
            ["state", { id: "b1" },
              ["transition", { event: "next", target: "b2" }]],
            ["state", { id: "b2" },
              // delayed self-send, cancelled on exit (delayed sends are not cancelled by the library)
              ["onEntry", {}, ["send", { id: "tick", event: "timer/fired", delayexpr: (d: Data) => d["tickMs"] ?? 60000 }]],
              ["onExit", {}, ["cancel", { sendid: "tick" }]],
              ["transition", { event: "timer/fired", target: "c" }, bump("fired")]]],
          ["state", { id: "c" },
            ["invoke", { id: "look", type: "sova/look", params: (d: Data) => ({ fired: d["fired"] ?? 0, sid: d["_sessionid"] }) }],
            ["transition", { event: "look/finished", target: "a" }, bump("looks")],
            ["transition", { event: "next", target: "a" }],
            ["transition", { event: "sova/resumed", target: "a" }, bump("resumes")]]],
        ["state", { id: "held" },
          ["transition", { event: "resume", target: "flow-h" }]]],

      // Region 2: a gate toggled by events.
      ["state", { id: "gate", initial: "closed" },
        ["state", { id: "closed" },
          ["transition", { event: "gate/open", target: "open" }],
          ["transition", { event: "spin/facts", target: "spin-working" },
            ["script", { expr: (d: Data) => [{ op: "assign", data: { spin: pick(evt(d), ["merged", "running"]) } }] }]],
          // a peer's ping may carry spin facts: a cycle in the receiving session, mid-call
          ["transition", { event: "peer/pinged", cond: (d: Data) => evt(d)["spin"] != null, target: "spin-working" },
            ["script", { expr: (d: Data) => [{ op: "assign", data: { spin: evt(d)["spin"] } }] }]]],
        ["state", { id: "open" }, ["transition", { event: "gate/close", target: "closed" }]],
        // An eventless cycle, the shape of work-item mutant M34: merged and not running settles in
        // spin-merged; merged and running never settles, and the step limit throws. Entering spin-working
        // arms an (ignored) timer, so a cycle also fills the queue, which a rolled-back call must put back.
        ["state", { id: "spin-working" },
          ["onEntry", {}, ["send", { id: "spin-timer", event: "spin/tick", delay: 3600000 }]],
          ["transition", { cond: (d: Data) => d["spin"]?.merged, target: "spin-merged" }],
          ["transition", { event: "gate/close", target: "closed" }]],
        ["state", { id: "spin-merged" },
          ["transition", { cond: (d: Data) => d["spin"]?.running, target: "spin-working" }],
          ["transition", { event: "gate/close", target: "closed" }]]],

      // Region 3: an eventless transition that reads region 2 through In().
      ["state", { id: "watch", initial: "idle" },
        ["state", { id: "idle" },
          ["transition", { event: "poke", target: "armed" }]],
        ["state", { id: "armed" },
          ["transition", { cond: ["In", "open"], target: "fired" },
            bump("firedEventless"),
            ["raise", { event: "watch/fired-inner" }]]],
        ["state", { id: "fired" },
          ["transition", { event: "watch/fired-inner" }, bump("inner")],
          ["transition", { event: "reset", target: "idle" }]]],

      // Region 4: guards on the envelope, effects, a cross-session send.
      ["state", { id: "acts", initial: "ready" },
        ["state", { id: "ready" },
          ["transition", { event: "act/promote", cond: may("L2"), target: "acted", "sova/needs": "L2", "sova/refusal": "It needs L2. Do not retry it." },
            effect("promote")],
          ["transition", { event: "act/ping" },
            ["send", {
              event: "peer/pinged",
              targetexpr: (d: Data) => d["peer"],
              content: (d: Data) => ({ from: d["_sessionid"], n: d["pings"] ?? 0, ...(d["spinOut"] ? { spin: d["spinOut"] } : {}) }),
            }],
            bump("pings")],
          ["transition", { event: "peer/pinged" }, bump("pinged")],
          // the library logs: a warning (an operation it does not know) and an error (a script that throws)
          ["transition", { event: "probe/warn" }, ["script", { expr: () => [{ op: "probe-unknown-op" }] }]],
          ["transition", { event: "probe/throw" }, ["script", { expr: () => { throw new Error("the probe's script threw"); } }]]],
        ["state", { id: "acted" },
          ["transition", { event: "act/undo", target: "ready" }]]]],
    // nested final: the session keeps running, so its configuration still shows it
    ["final", { id: "stopped" }]],
];

/** probe.cljs's `version`. */
export const PROBE_VERSION = 2;

/** For `createEngine({charts})`. */
export const PROBE_CHARTS = { "engine-probe": { version: PROBE_VERSION, chart: probeChart } };
