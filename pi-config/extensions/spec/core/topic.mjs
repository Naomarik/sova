// Topic search for `where`: the claims and areas ranked by the words of a query, field-weighted BM25.
// Node stdlib only, deterministic, computed from the parsed graph on each call; nothing is stored.
// The constants were tuned on a dev set of real asks (tests/search/experiments/LOG.md holds every attempt).
import { titleOf, whatOf, mask } from "./toc.mjs";
import { splitOf, summaryLines } from "./parts.mjs";

export const TOPIC = {
  k1: 1.2, b: 0.75,
  // Where a hit counts: the heading, the first sentence, the backticked names, the prose, and an H2's area title.
  // Unlike long duplicate-hunting queries, a short topic query needs the prose: its words are often only there.
  weights: { title: 4, what: 1, names: 1, body: 2, areaTitle: 1 },
  // A row below this fraction of the best score is dropped, unless its heading holds every query word.
  floor: 0.35,
};

const STOPWORDS = new Set(`a an and any are as at be been being both but by can cannot did do does
  for from get got had has have how i if in into is it its just like made make many me more most much my
  need never new no not now of on one only or other our out over said same say says see so some still such
  than that the their then there these they this those to two up us use used using via was we were what when
  where which while who why will with would you your`.trim().split(/\s+/));
// A name with a slash, or a file name with an extension: kept whole and never stemmed.
const PATHISH = /[A-Za-z0-9_.-]*\/[A-Za-z0-9_./-]+|\b[A-Za-z0-9_-]+\.(?:md|mjs|js|ts|tsx|sh|json|css|html|toml|yaml|yml)\b/g;
// Words split at hyphens: "read-only" is read and only, as a person types it.
const WORDS = /[\p{L}\p{N}][\p{L}\p{N}'’]*/gu;

// A light suffix stripper, not Porter. Paths are never stemmed: `spec/rules` and `spec/rule` are different files.
// -tion and -sion stay, so a word's -ed and -ing forms land on its own term (mentioned = mention, not men).
export function stem(w) {
  if (w.includes("/") || w.includes(".")) return w;
  return w
    .replace(/ies$/, "y")
    .replace(/(sses|shes|ches|xes)$/, (m) => m.slice(0, -2))
    .replace(/([^s])s$/, "$1")
    .replace(/(ingly|edly|ing|ed|ly|ness|ment)$/, "")
    .replace(/(.)\1$/, "$1") || w;
}

// Text → each (term, word as written): one function, so a query and a passage are never cut into words differently.
const stems = new Map();
function cut(text, each) {
  const s = String(text);
  for (const m of s.match(PATHISH) ?? []) each(m.toLowerCase(), m);
  for (const m of s.matchAll(WORDS)) {
    const word = m[0].replace(/['’]+$/, ""), w = word.toLowerCase();
    if (w.length < 3 || STOPWORDS.has(w)) continue;
    let term = stems.get(w);
    if (term === undefined) stems.set(w, (term = stem(w)));
    each(term, word);
  }
}
export const termsOf = (text) => { const out = []; cut(text, (t) => out.push(t)); return out; };
export const wordsOf = (text) => { const out = []; cut(text, (term, word) => out.push({ term, word })); return out; };

// One unit per claim and area, a split topic's parts read with it as one text: its fields' term frequencies and lengths.
// → { units, df, avg, n, cfg, fields, parts }; parts: each topic's parts' own units, to name its best-matching part.
export function topicIndex(ix, cfg = TOPIC) {
  const fields = Object.keys(cfg.weights).filter((f) => cfg.weights[f] > 0);
  const split = splitOf(ix.ctx);
  const own = (id) => {
    const decl = ix.ctx.decls.get(id), area = ix.areaOf(id);
    return unitOf(id, {
      title: titleOf(decl),
      what: whatOf(decl).what,
      names: ix.tokens.get(id).map((s) => s.token).join("\n"),
      body: mask(decl.text, { doubleTicks: false, heading: true }),
      areaTitle: area !== id && ix.ctx.decls.has(area) ? titleOf(ix.ctx.decls.get(area)) : "",
    }, fields);
  };
  const parts = new Map();
  for (const p of split.up.keys()) parts.set(p, own(p));
  const units = ix.ids.filter((id) => !split.up.has(id)).map((id) => (split.down.has(id) ? topicUnit(ix, split, id, parts, fields) : own(id)));
  const df = new Map();
  for (const u of units) for (const t of u.any) df.set(t, (df.get(t) ?? 0) + 1);
  const avg = {};
  for (const f of fields) avg[f] = units.reduce((a, u) => a + u.per[f].len, 0) / (units.length || 1);
  return { units, df, avg, n: units.length, cfg, fields, split, parts };
}

function unitOf(id, texts, fields) {
  const per = {}, any = new Set();
  for (const f of fields) {
    const tf = new Map(), ts = termsOf(texts[f] ?? "");
    for (const term of ts) { tf.set(term, (tf.get(term) ?? 0) + 1); any.add(term); }
    per[f] = { tf, len: ts.length };
  }
  return { id, per, any, title: new Set(per.title?.tf.keys() ?? termsOf(texts.title)) };
}

// A split topic as the one text it was: its own heading and area; its prose without the summary lines, then each
// part's heading and prose; its names and its parts', each once; its first sentence, or, when that is the summary,
// its parts' first prose sentence.
function topicUnit(ix, split, id, parts, fields) {
  const decl = ix.ctx.decls.get(id), area = ix.areaOf(id), ps = split.down.get(id), drop = summaryLines(split, id, decl);
  const body = mask(decl.text, { doubleTicks: false, heading: true }).split("\n").filter((_, i) => !drop.has(i)).join("\n");
  const what0 = whatOf(decl).what;
  const what = /^\s*§/.test(what0) || ps.some((p) => what0.includes(p))
    ? ps.map((p) => whatOf(ix.ctx.decls.get(p)).what).find((w) => !/^no prose sentence/.test(w)) ?? whatOf(ix.ctx.decls.get(ps[0])).what : what0;
  const names = [...new Set([id, ...ps].flatMap((x) => ix.tokens.get(x).map((s) => s.token)))].join("\n");
  const u = unitOf(id, { title: titleOf(decl), what, names, body, areaTitle: area !== id && ix.ctx.decls.has(area) ? titleOf(ix.ctx.decls.get(area)) : "" }, fields);
  if (u.per.body) for (const p of ps) for (const f of ["title", "body"]) {
    const pf = parts.get(p).per[f];
    if (!pf) continue;
    for (const [t, c] of pf.tf) { u.per.body.tf.set(t, (u.per.body.tf.get(t) ?? 0) + c); u.any.add(t); }
    u.per.body.len += pf.len;
  }
  return u;
}

function scoreOf(tix, u, q) {
  const { df, avg, n, cfg, fields } = tix;
  let s = 0;
  const matched = [];
  for (const [t, word] of q) {
    if (!u.any.has(t)) continue;
    const k = df.get(t) ?? 0, idf = Math.log(1 + (n - k + 0.5) / (k + 0.5));
    for (const f of fields) {
      const tf = u.per[f].tf.get(t) ?? 0;
      if (tf) s += cfg.weights[f] * idf * (tf * (cfg.k1 + 1)) / (tf + cfg.k1 * (1 - cfg.b + cfg.b * (u.per[f].len / (avg[f] || 1))));
    }
    matched.push(word);
  }
  return { s, matched };
}

// The units matching a query, best first, above the floor or holding every query word in their heading; a split
// topic's row names the part whose own text scores highest.
// → { terms: [query words kept], rows: [{id, score, matched, part?}] }
export function topicRank(tix, query) {
  const { units, cfg } = tix;
  const q = new Map();
  for (const { term, word } of wordsOf(query)) if (!q.has(term)) q.set(term, word);
  const scored = [];
  for (const u of units) {
    const { s, matched } = scoreOf(tix, u, q);
    if (s > 0) scored.push({ id: u.id, score: s, matched, titled: q.size > 0 && [...q.keys()].every((t) => u.title.has(t)) });
  }
  scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  const best = scored[0]?.score ?? 0;
  const rows = scored.filter((r) => r.score >= best * cfg.floor || r.titled).map((r) => {
    const part = bestPart(tix, r.id, q);
    return { id: r.id, score: Math.round(r.score * 100) / 100, matched: r.matched, ...(part ? { part } : {}) };
  });
  return { terms: [...q.values()], rows };
}
function bestPart(tix, id, q) {
  let best = null;
  for (const p of tix.split.down.get(id) ?? []) {
    const s = scoreOf(tix, tix.parts.get(p), q).s;
    if (s > 0 && (!best || s > best.s)) best = { id: p, s };
  }
  return best?.id;
}
