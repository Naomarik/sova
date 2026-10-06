// perf-pi statistics: percentiles, paired A/B comparison and the summary table. Builtins only.
//
// Samples are { metric, side, round, value } (value in ms or MB). For each metric and side:
//   - pooled p50/p95/min/max over every sample of every round;
//   - the median of the per-round medians (`mm`), the headline number: rounds alternate base/after, so
//     machine drift lands on both sides alike.
// The A/B call is paired by round: d_r = after's round median − base's round median. A change is
// called beyond noise when (1) an exact two-sided sign test over the rounds gives p < 0.05, and (2) the
// change in mm exceeds the noise floor in %, never under 3%: the metric's own |Δ%| in an A/A run (the
// same tree on both sides) when there is one, else the largest |Δ%| among the control metrics (which
// pi does not touch).

export const pct = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
};
export const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Exact two-sided sign test: P(at least this lopsided | p = 0.5), ties dropped. */
export function signTest(diffs) {
  const nz = diffs.filter((d) => d !== 0);
  const n = nz.length;
  if (!n) return { n: 0, up: 0, p: 1 };
  const up = nz.filter((d) => d > 0).length;
  const k = Math.min(up, n - up);
  let tail = 0;
  let c = 1; // C(n, 0)
  for (let i = 0; i <= k; i++) {
    tail += c;
    c = (c * (n - i)) / (i + 1);
  }
  return { n, up, p: Math.min(1, (2 * tail) / 2 ** n) };
}

/** Group samples: metric → side → round → values. */
function group(samples) {
  const g = new Map();
  for (const s of samples) {
    if (s.value == null || !Number.isFinite(s.value)) continue;
    const m = g.get(s.metric) ?? new Map();
    g.set(s.metric, m);
    const side = m.get(s.side) ?? new Map();
    m.set(s.side, side);
    const r = side.get(s.round) ?? [];
    side.set(s.round, r);
    r.push(s.value);
  }
  return g;
}

/**
 * The comparison. `meta[metric]` = { label, unit, control?, order } describes each metric; metrics
 * without one are still reported, by name. `aa` = { metric: Δ% } from an A/A run (the same tree
 * on both sides): each metric's own noise floor. Returns { rows, noiseFloor }.
 */
export function compare(samples, meta = {}, aa = null) {
  const g = group(samples);
  const raw = [];
  for (const [metric, sides] of g) {
    const side = (name) => {
      const rounds = sides.get(name) ?? new Map();
      const all = [...rounds.values()].flat();
      const perRound = new Map([...rounds].map(([r, v]) => [r, median(v)]));
      return { n: all.length, rounds: rounds.size, p50: median(all), p95: pct(all, 95), min: all.length ? Math.min(...all) : null, max: all.length ? Math.max(...all) : null, mm: median([...perRound.values()]), perRound };
    };
    const base = side("base");
    const after = side("after");
    const paired = [...base.perRound.keys()].filter((r) => after.perRound.has(r)).map((r) => after.perRound.get(r) - base.perRound.get(r));
    const delta = base.mm != null && after.mm != null ? after.mm - base.mm : null;
    const deltaPct = delta != null && base.mm ? (100 * delta) / base.mm : null;
    raw.push({ metric, ...(meta[metric] ?? {}), base, after, delta, deltaPct, sign: signTest(paired) });
  }
  const controls = raw.filter((r) => r.control && r.deltaPct != null);
  const noiseFloor = Math.max(3, ...controls.map((r) => Math.abs(r.deltaPct)));
  for (const r of raw) {
    // With an A/A run (the same tree on both sides), each metric's own |Δ%| there is its floor.
    const aaPct = aa?.[r.metric];
    r.floor = aa ? Math.max(3, aaPct == null ? noiseFloor : Math.abs(aaPct)) : noiseFloor;
    r.beyondNoise = r.deltaPct != null && r.sign.p < 0.05 && Math.abs(r.deltaPct) > r.floor && !r.control;
  }
  raw.sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || a.metric.localeCompare(b.metric));
  return { rows: raw, noiseFloor };
}

const fmt = (x, unit = "ms") => {
  if (x == null) return "–";
  const v = Math.abs(x) >= 100 ? Math.round(x).toString() : Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(2);
  return unit === "ms" ? v : `${v} ${unit}`;
};

/** The result table, markdown. */
export function table({ rows, noiseFloor }) {
  const out = [];
  out.push("| metric | unit | base mm | after mm | Δ | Δ% | floor % | rounds (after > base) | sign p | beyond noise | base p50 / p95 / min / max | after p50 / p95 / min / max | n base/after |");
  out.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rows) {
    const unit = r.unit ?? "ms";
    const call = r.control ? "control" : r.beyondNoise ? (r.delta > 0 ? "**YES, slower/larger**" : "**YES, faster/smaller**") : "no";
    const b = r.base;
    const a = r.after;
    out.push(
      `| ${r.label ?? r.metric} | ${unit} | ${fmt(b.mm, "ms")} | ${fmt(a.mm, "ms")} | ${r.delta == null ? "–" : (r.delta > 0 ? "+" : "") + fmt(r.delta, "ms")} | ${r.deltaPct == null ? "–" : (r.deltaPct > 0 ? "+" : "") + r.deltaPct.toFixed(1) + "%"} | ${r.floor.toFixed(0)} | ${r.sign.up}/${r.sign.n} | ${r.sign.p < 0.001 ? "<0.001" : r.sign.p.toFixed(3)} | ${call} | ${fmt(b.p50, "ms")} / ${fmt(b.p95, "ms")} / ${fmt(b.min, "ms")} / ${fmt(b.max, "ms")} | ${fmt(a.p50, "ms")} / ${fmt(a.p95, "ms")} / ${fmt(a.min, "ms")} / ${fmt(a.max, "ms")} | ${b.n}/${a.n} |`,
    );
  }
  out.push("", `mm = median of the per-round medians. floor % = the metric's own |Δ%| in the A/A run (at least 3%) when one was given, else the largest |Δ%| of this run's control metrics (${noiseFloor.toFixed(1)}%). Beyond noise = sign test p < 0.05 over the paired rounds AND |Δ%| above the floor.`);
  return out.join("\n");
}
