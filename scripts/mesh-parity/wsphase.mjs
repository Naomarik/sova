// WS phases: /ws/watch on every fixture, the error paths of both endpoints, and a scripted glm-5.3
// chat on /ws/chat. Records every message in arrival order plus the close code.

import { createRequire } from "node:module";

function wsClass(tree) {
  return createRequire(`${tree}/package.json`)("ws");
}

/** Connect, collect for `ms` (or until the server closes), then close. */
export function collect(tree, url, { ms = 1500, onMessage } = {}) {
  const WebSocket = wsClass(tree);
  return new Promise((resolve) => {
    const msgs = [];
    let close = null;
    const ws = new WebSocket(url);
    const done = () => resolve({ msgs, close });
    const timer = setTimeout(() => ws.close(1000), ms);
    ws.on("message", (d) => {
      const text = d.toString();
      let m;
      try {
        m = JSON.parse(text);
      } catch {
        m = text; // an extension backend's own frames need not be JSON
      }
      msgs.push(m);
      onMessage?.(m, ws);
    });
    ws.on("unexpected-response", (_req, res) => {
      clearTimeout(timer);
      close = { http: res.statusCode };
      done();
    });
    ws.on("error", (err) => {
      if (!close) close = { error: err.code ?? err.message };
    });
    ws.on("close", (code, reason) => {
      clearTimeout(timer);
      if (!close || close.error) close = { ...(close ?? {}), code, reason: reason.toString() };
      done();
    });
  });
}

export async function watchPhase(tree, wsBase, f) {
  const out = {};
  for (const [name, path] of Object.entries(f)) out[`watch:${name}`] = await collect(tree, `${wsBase}/ws/watch?path=${encodeURIComponent(path)}`);
  out["watch:no-path"] = await collect(tree, `${wsBase}/ws/watch`);
  out["watch:outside"] = await collect(tree, `${wsBase}/ws/watch?path=${encodeURIComponent("/etc/x.jsonl")}`);
  out["watch:claude-unknown"] = await collect(tree, `${wsBase}/ws/watch?claude=00000000-0000-0000-0000-000000000000`);
  out["chat:no-path"] = await collect(tree, `${wsBase}/ws/chat`);
  out["chat:missing-cwd"] = await collect(tree, `${wsBase}/ws/chat?path=${encodeURIComponent(f["missing-cwd"])}`, { ms: 8000 });
  out["ws:unknown-route"] = await collect(tree, `${wsBase}/ws/other`);
  out["ext-ws:unknown"] = await collect(tree, `${wsBase}/ext/nope/ws/x`);
  return out;
}

/**
 * The scripted chat: create a session over REST, set glm-5.3 and thinking off, one plain turn and
 * one tool turn, then close. Steps advance on the server's own replies, never on timers, so both
 * sides send the same messages at the same protocol points.
 */
export async function chatPhase(tree, base, cwd) {
  const r = await fetch(`${base}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd }) });
  const created = await r.json();
  if (r.status !== 201) return { created: { status: r.status, body: created }, msgs: [], close: null };
  let step = 0;
  let idleWait;
  const send = (ws, m) => ws.send(JSON.stringify(m));
  const res = await collect(tree, `${base.replace(/^http/, "ws")}/ws/chat?path=${encodeURIComponent(created.path)}`, {
    ms: 240_000,
    onMessage: (m, ws) => {
      if (m.type === "hello" && step === 0) {
        step = 1;
        send(ws, { type: "set_model", ref: "zai/glm-5.3" });
      } else if (m.type === "model" && step === 1) {
        step = 2;
        send(ws, { type: "set_thinking", level: "off" });
      } else if (m.type === "thinking" && step === 2) {
        step = 3;
        send(ws, { type: "prompt", text: "Reply with exactly the single word PONG and nothing else.", clientId: "parity-1" });
      } else if (m.type === "event" && m.event?.type === "agent_settled") {
        if (step === 3) {
          step = 4;
          send(ws, { type: "prompt", text: "Use the bash tool to run `echo parity` and then reply with exactly DONE.", clientId: "parity-2" });
        } else if (step === 4) {
          step = 5;
          // The topic-outline extension summarizes after the turn, in the background, with its own
          // model call: wait for it to report Idle (bounded) so its entry is written on both sides,
          // instead of racing it.
          idleWait = setTimeout(() => ws.close(1000), 45_000);
        }
      } else if (step === 5 && m.type === "ui_request" && m.request?.statusKey === "topic-outline" && m.request?.statusText === "Idle") {
        step = 6;
        clearTimeout(idleWait);
        setTimeout(() => ws.close(1000), 1500);
      } else if (m.type === "error") {
        step = 99;
        setTimeout(() => ws.close(1000), 500);
      }
    },
  });
  return { created: { status: r.status, body: created }, ...res, completed: step >= 5, outlineIdle: step === 6 };
}

/**
 * The comparable form of a chat stream. What varies between two runs of the SAME code (measured by
 * A/A runs of the baseline against itself) is kept out of the exact comparison, each for its reason:
 *  - fire-and-forget status pushes (`ui_request` with fireAndForget) and `workers` snapshots are
 *    interleaved by timers: reduced to the last value per key (`status`, `workers`);
 *  - consecutive streaming deltas of one kind collapse into one (the provider picks the chunking);
 *  - the topic-outline extension's background summary is a second model call racing the turn — in
 *    A/A runs it finished in 16 s once and was still "outlining…" after 180 s another time — so its
 *    `entry_appended` events and its status text go to `background` and are reported, not compared;
 *  - model output leaves are masked by the caller (maskModelOutput).
 */
export function chatShape(msgs) {
  const sequence = [];
  const status = {};
  const background = [];
  let workers = null;
  const deltaKind = (m) => (m.type === "event" && m.event?.type === "message_update" ? m.event.assistantMessageEvent?.type : m.type === "event" && m.event?.type === "tool_execution_update" ? "tool_execution_update" : null);
  for (const m of msgs) {
    if (m.type === "ui_request" && m.request?.fireAndForget) {
      const { method, statusKey, statusText } = m.request;
      if (statusKey === "topic-outline") background.push(statusText);
      else status[`${method}:${statusKey ?? ""}`] = statusText ?? null;
      continue;
    }
    if (m.type === "event" && m.event?.type === "entry_appended" && m.event.entry?.customType === "topic-outline") {
      background.push("entry_appended topic-outline");
      continue;
    }
    if (m.type === "workers") {
      workers = m;
      continue;
    }
    const k = deltaKind(m);
    if (k && (k.endsWith("_delta") || k === "tool_execution_update")) {
      const prev = sequence.at(-1);
      if (prev && deltaKind(prev) === k) continue;
    }
    sequence.push(m);
  }
  return { sequence, status, workers, background };
}

/** The background outline's traces in a REST answer or a stored file, removed (see chatShape). */
export function dropOutline(v) {
  if (Array.isArray(v)) return v.filter((x) => !(x && x.type === "custom" && x.customType === "topic-outline")).map(dropOutline);
  if (!v || typeof v !== "object") return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) if (!/^outline/.test(k)) out[k] = dropOutline(x);
  return out;
}
