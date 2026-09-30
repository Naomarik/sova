/** `vis sequence`: actors, messages, notes, dividers. */

import { applyMarks, byIdOrLabel, takeMarks } from "../../core/emphasis";
import { divider, fail, id, lines, modifiers, takeSettings, tokenize, type Arrow, type Tone, type VisBase } from "../../core/grammar";

export interface Actor {
  id: string;
  label: string;
  tone?: Tone;
}
export type SeqStep =
  | { type: "msg"; from: string; to: string; label?: string; dashed: boolean }
  | { type: "note"; over: string[]; text: string }
  | { type: "divider"; label: string };
export interface SequenceSpec extends VisBase {
  kind: "sequence";
  actors: Actor[];
  steps: SeqStep[];
}

const MAX_ACTORS = 8;
const MAX_STEPS = 40;


export function parseSequence(body: string): SequenceSpec {
  const ls = lines(body);
  const spec: SequenceSpec = { kind: "sequence", actors: [], steps: [] };
  const { rest: settled } = takeSettings(ls, [], spec);
  const { rest, marks } = takeMarks(settled);
  const actors = new Map<string, Actor>();
  const use = (a: string) => {
    if (!actors.has(a)) actors.set(a, { id: a, label: a });
  };
  for (const line of rest) {
    const div = divider(line);
    if (div !== null) {
      spec.steps.push({ type: "divider", label: div });
      continue;
    }
    const toks = tokenize(line);
    const first = toks[0]!;
    if (first.t === "word" && (first.v === "actor" || first.v === "participant")) {
      const aid = id(toks[1], line.n, "an actor id");
      const existing = actors.get(aid);
      if (existing && existing.label !== aid) fail(line.n, `actor ${aid} is declared twice`);
      let k = 2;
      let label = aid;
      if (toks[k]?.t === "str") label = toks[k++]!.v;
      const mods = modifiers(toks.slice(k), line.n);
      actors.set(aid, { id: aid, label, ...(mods.tone ? { tone: mods.tone } : {}) });
      continue;
    }
    if (first.t === "word" && first.v === "note") {
      const over: string[] = [];
      let k = 1;
      while (toks[k]?.t === "word") over.push(id(toks[k++], line.n, "an actor id"));
      if (over.length < 1 || over.length > 2) fail(line.n, 'note takes 1 or 2 actor ids, then "text"');
      const t = toks[k];
      if (t?.t !== "str" || k + 1 !== toks.length) fail(line.n, 'note <actor> [<actor>] "text"');
      over.forEach(use);
      spec.steps.push({ type: "note", over, text: (t as { v: string }).v });
      continue;
    }
    const from = id(first, line.n, "a message (a -> b \"label\"), actor, note or == divider ==");
    const arrow = toks[1];
    if (arrow?.t !== "arrow" || arrow.v === "<->" || arrow.v === "<-->") fail(line.n, "a message is a -> b or a --> b (reply)");
    // Mermaid's `a ->> b: msg` reads here as the target ">b:" and loose words: quote the vis message.
    const lone = toks[2]?.t === "word" && toks[2].v === ">" && toks[3]?.t === "word";
    const target = lone ? `>${toks[3]!.v}` : toks[2]?.t === "word" ? toks[2].v : "";
    if (/^>?[A-Za-z_][A-Za-z0-9_.-]*:?$/.test(target) && (target.startsWith(">") || target.endsWith(":"))) {
      const words = toks.slice(lone ? 4 : 3).map((t) => t.v).join(" ");
      const a = (arrow as { v: Arrow }).v;
      fail(line.n, `write ${from} ${a} ${target.replace(/^>|:$/g, "")}${words ? ` "${words}"` : ""} (not Mermaid a ${target.startsWith(">") ? `${a}>` : a} b: msg)`);
    }
    const to = id(toks[2], line.n, "a target actor");
    let label: string | undefined;
    if (toks[3]?.t === "str") label = toks[3].v;
    if (toks.length > (label === undefined ? 3 : 4)) fail(line.n, "one message per line");
    use(from);
    use(to);
    spec.steps.push({ type: "msg", from, to, ...(label ? { label } : {}), dashed: (arrow as { v: Arrow }).v === "-->" });
  }
  spec.actors = [...actors.values()];
  if (spec.actors.length < 2) fail(0, "a sequence needs at least 2 actors");
  if (spec.actors.length > MAX_ACTORS) fail(0, `${spec.actors.length} actors; at most ${MAX_ACTORS}`);
  if (spec.steps.length > MAX_STEPS) fail(0, `${spec.steps.length} steps; at most ${MAX_STEPS}`);
  // A number counts messages only (notes and dividers aren't counted); a name is an actor's id or
  // label, else a message's exact label (the first message with it).
  applyMarks(spec, marks, (t) => {
    if (t.t === "number") {
      const at = spec.steps.flatMap((s, i) => (s.type === "msg" ? [i] : []))[t.value - 1];
      return at === undefined ? null : `step:${at}`;
    }
    const a = byIdOrLabel(spec.actors.map((x) => ({ key: `actor:${x.id}`, id: x.id, label: x.label })))(t);
    if (a !== null || (t.t !== "label" && t.t !== "id")) return a;
    const at = spec.steps.findIndex((s) => s.type === "msg" && s.label === t.text);
    return at < 0 ? null : `step:${at}`;
  }, "actor or message");
  return spec;
}
