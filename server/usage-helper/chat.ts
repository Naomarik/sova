// One top-level chat's usage and time, cut on request (§app.extensions/chat-usage): each conversation's own
// calls by model from the ledger, its agent time from the measured replies and tool runs (overlaps counted
// once, worker waits left out, as the Time tab counts them), and your time at the chat itself. Nothing is
// written: every answer is read from the stores the helper already keeps.
import type { ChatUsage, ChatUsageAsk, ChatUsageRow, UsageSpend } from "../../shared/usage/wire";
import { mergeSpans, type TimeDeps } from "./time";

const zero = (): UsageSpend => ({ usd: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 }, usdBy: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 }, calls: 0, unpricedTokens: 0 });
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
function add(into: UsageSpend, s: UsageSpend): void {
  into.usd = r6(into.usd + s.usd);
  into.calls += s.calls;
  into.unpricedTokens += s.unpricedTokens;
  for (const k of ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h"] as const) {
    into.tokens[k] += s.tokens[k];
    into.usdBy[k] = r6(into.usdBy[k] + s.usdBy[k]);
  }
}

export function chatUsage(d: TimeDeps, q: ChatUsageAsk): ChatUsage {
  d.attention.refresh();
  d.perf.refresh();
  d.tools.refresh();
  // The conversations: the chat, the members the server knows, then any the ledger names under them.
  const members = new Map<string, Omit<ChatUsageRow, "spend" | "models" | "agent">>();
  members.set(q.sid, { sid: q.sid, role: "chat" });
  for (const m of q.members) if (m.sid !== q.sid && !members.has(m.sid)) members.set(m.sid, { ...m });
  for (const sid of d.queries.family(q.sid)) {
    if (members.has(sid)) continue;
    const o = d.queries.ownerOf(sid);
    members.set(sid, { sid, role: "worker", ...(o?.worker ? { name: o.worker } : {}), ...(o?.parent ? { parent: o.parent } : {}) });
  }
  // Agent time: each conversation's replies and tool runs (no worker wait), merged so overlaps count once.
  const spans = new Map<string, [number, number][]>();
  const push = (sid: string, a: number, b: number) => {
    if (b <= a || !members.has(sid)) return;
    let s = spans.get(sid);
    if (!s) spans.set(sid, (s = []));
    s.push([a, b]);
  };
  for (const rec of d.perf.records()) if (rec.endMs > 0) push(rec.sid, rec.sentAt, rec.sentAt + rec.endMs);
  for (const run of d.tools.records()) if (!run.wait) push(run.sid, run.start, run.end);
  const agentOf = (sid: string) => Math.round(mergeSpans(spans.get(sid) ?? []).reduce((n, [a, b]) => n + (b - a), 0) / 1000);
  // Your time at the chat itself: its living record's runs and, once gone, the hours kept for it.
  let you = 0;
  for (const r of d.attention.live().get(q.sid)?.runs ?? []) you += Math.max(0, r.e - r.s);
  for (const l of d.attention.gone()) if (l.sid === q.sid) you += l.sec;
  const rows: ChatUsageRow[] = [];
  const total = { spend: zero(), agent: 0, you: Math.round(you), waiting: Math.max(0, Math.round(q.waiting)) };
  for (const m of members.values()) {
    const { spend, models } = d.queries.ownSpend(m.sid);
    const agent = agentOf(m.sid);
    rows.push({ ...m, spend, models, agent, ...(m.sid === q.sid ? { you: total.you, waiting: total.waiting } : {}) });
    add(total.spend, spend);
    total.agent += agent;
  }
  return { chat: q.sid, device: { id: d.device(), self: true }, asOf: d.now(), rows, total };
}
