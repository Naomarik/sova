/** `vis sequence`: actors, messages, notes, dividers. */

import { applyMarks, byIdOrLabel, takeMarks } from "../../core/emphasis";
import { divider, fail, ID, id, isTone, lines, modifiers, slug, takeSettings, text, tokenize, unquote, VisError, type Arrow, type Line, type Token, type Tone, type VisBase } from "../../core/grammar";

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
  const { rest: settled } = takeSettings(ls, [], spec, { caseless: true });
  const { rest, marks } = takeMarks(settled, { indented: true });
  const actors = new Map<string, Actor>();
  // A tone after a message: that message marked in that tone, after the fence's own marks.
  const toned: { key: string; tone: Tone }[] = [];
  const use = (a: string) => {
    if (!actors.has(a)) actors.set(a, { id: a, label: a });
  };
  for (const line of rest) {
    const div = divider(line);
    if (div !== null) {
      spec.steps.push({ type: "divider", label: div });
      continue;
    }
    try {
      strictLine(line);
    } catch (e) {
      // Today's reading refuses the line: the one other reading (Mermaid's habits), or today's error.
      if (!(e instanceof VisError) || !lenientLine(line)) throw e;
    }
  }
  function strictLine(line: Line): void {
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
      return;
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
      return;
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
  /** An actor named by its "label": the one with that label, else a new one (its id made from the label). */
  function actorByLabel(label: string): string {
    for (const a of actors.values()) if (a.label === label) return a.id;
    const aid = slug(label, (x) => actors.has(x));
    actors.set(aid, { id: aid, label });
    return aid;
  }
  /** An actor written as an id or a "label"; null for anything else. */
  function actorOf(tok: Token | undefined): string | null {
    if (tok?.t === "str") return actorByLabel(tok.v);
    if (tok?.t === "word" && ID.test(tok.v)) return tok.v;
    return null;
  }
  /**
   * Mermaid's habits, on a line today's reading refused (§chat.markdown/vis-lenience-content). True
   * when the line read (and was added), false when it didn't: then today's error stands.
   */
  function lenientLine(line: Line): boolean {
    let t = line.text;
    if (/;\s*$/.test(t) && (t.match(/(?<!\\)"/g)?.length ?? 0) % 2 === 0) t = t.replace(/\s*;\s*$/, "");
    const arrowless = !/->|→|=>/.test(t);
    if (arrowless && (/^(sequenceDiagram|autonumber|end)$/i.test(t) || /^(activate|deactivate)\s+\S+$/i.test(t) || /^rect\b/i.test(t))) return true;
    const block = arrowless ? /^(loop|alt|opt|par|critical|break|else|and)\b\s*(.*)$/i.exec(t) : null;
    if (block) {
      const q = /^"((?:[^"\\]|\\.)*)"$/.exec(block[2]!);
      spec.steps.push({ type: "divider", label: text(q ? unquote(q[1]!) : block[2]! || block[1]!.toLowerCase(), line.n) });
      return true;
    }
    const decl = /^(?:participant|actor)\s+(?:(\S+)\s+as\s+(.+)|"((?:[^"\\]|\\.)*)")$/i.exec(t);
    if (decl) {
      if (decl[3] !== undefined) {
        actorByLabel(unquote(decl[3]));
        return true;
      }
      const had = actors.get(decl[1]!);
      if (!ID.test(decl[1]!) || (had && had.label !== had.id)) return false;
      const q = /^"((?:[^"\\]|\\.)*)"$/.exec(decl[2]!.trim());
      actors.set(decl[1]!, { id: decl[1]!, label: text(q ? unquote(q[1]!) : decl[2]!.trim(), line.n) });
      return true;
    }
    const note = /^note\s+(?:(?:over|left of|right of)\s+)?([^":]+?)\s*(?::\s*(.*)|\s("(?:[^"\\]|\\.)*"))$/i.exec(t);
    if (note) {
      const over = note[1]!.split(/[\s,]+/).filter(Boolean);
      const body = note[3] !== undefined ? unquote(note[3].slice(1, -1)) : note[2]!.trim();
      const q = /^"((?:[^"\\]|\\.)*)"$/.exec(body);
      if (over.length < 1 || over.length > 2 || !over.every((a) => ID.test(a)) || !body) return false;
      over.forEach(use);
      spec.steps.push({ type: "note", over, text: text(q ? unquote(q[1]!) : body, line.n) });
      return true;
    }
    let toks = tokenize({ ...line, text: t }, { wide: true });
    // `w <- q "msg"`: the arrow written backwards is `q -> w "msg"`.
    const back = toks[1];
    if (back?.t === "word" && (back.v === "<-" || back.v === "<--") && toks[2]) toks = [toks[2], { t: "arrow", v: back.v === "<-" ? "->" : "-->" }, toks[0]!, ...toks.slice(3)];
    // `u "User"` [tone]: an actor declared without the word.
    if (toks[0]?.t === "word" && ID.test(toks[0].v) && toks[1]?.t === "str" && toks.length <= 3 && (toks.length === 2 || (toks[2]!.t === "word" && isTone(toks[2]!.v)))) {
      const had = actors.get(toks[0].v);
      if (had && had.label !== had.id) return false;
      actors.set(toks[0].v, { id: toks[0].v, label: toks[1].v, ...(toks[2] ? { tone: toks[2].v as Tone } : {}) });
      return true;
    }
    const arrow = toks[1];
    if (arrow?.t !== "arrow" || arrow.v === "<->" || arrow.v === "<-->") return false;
    const from = actorOf(toks[0]);
    let k = 2;
    // `->>` leaves `>` on the target, `->>+` a `+` too (activation): dropped.
    let target = toks[k];
    if (target?.t === "word" && /^>?[+-]?$/.test(target.v) && target.v !== "") target = toks[++k];
    if (target?.t === "word") target = { t: "word", v: target.v.replace(/^>?[+-]?/, "") };
    let colon = false;
    if (target?.t === "word" && target.v.length > 1 && target.v.endsWith(":")) {
      target = { t: "word", v: target.v.slice(0, -1) };
      colon = true;
    }
    const to = actorOf(target);
    if (!from || !to) return false;
    const after = toks.slice(k + 1);
    if (after[0]?.t === "word" && after[0].v.startsWith(":")) {
      colon = true;
      after[0] = { t: "word", v: after[0].v.slice(1) };
    }
    if (after.some((x) => x.t === "arrow")) return false;
    // After the label's strings, `dashed` / `dotted` (the arrow dashed) and a tone (the message marked in it).
    let dashed = arrow.v === "-->";
    let tone: Tone | undefined;
    const strs = after.findIndex((x) => x.t === "str");
    for (let w = after[after.length - 1]; !colon && strs >= 0 && w?.t === "word" && after.length - 1 > strs; w = after[after.length - 1]) {
      if (/^(dashed|dotted)$/.test(w.v)) dashed = true;
      else if (isTone(w.v) && !tone) tone = w.v;
      else break;
      after.pop();
    }
    const words = after.map((x) => x.v).filter((v) => v !== "");
    // After a colon, the rest of the line; else one "label", two (its two lines, as a flow edge's) or bare words.
    const two = !colon && after.length === 2 && after.every((x) => x.t === "str");
    if (!colon && !two && after.some((x) => x.t === "str") && after.length > 1) return false;
    const label = words.join(two ? "\n" : " ").trim();
    use(from);
    use(to);
    if (tone) toned.push({ key: `step:${spec.steps.length}`, tone });
    spec.steps.push({ type: "msg", from, to, ...(label ? { label: text(label, line.n) } : {}), dashed });
    return true;
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
  const extra = toned.filter((t) => !(spec.emphasis ?? []).some((e) => e.key === t.key));
  if (extra.length) spec.emphasis = [...(spec.emphasis ?? []), ...extra];
  return spec;
}
