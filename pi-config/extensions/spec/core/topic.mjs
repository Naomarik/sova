// Topic search for `where`: the claims and areas ranked by the words of a query, field-weighted BM25.
// Node stdlib only, deterministic, computed from the parsed graph on each call; nothing is stored.
import { titleOf, whatOf, mask } from "./toc.mjs";

// The ranking's constants. `topicRank` takes a variant for experiments; `where` uses these.
export const TOPIC = {
  k1: 1.2, b: 0.75,
  // Where a hit counts: the heading, the first sentence, the backticked names, the prose, and an H2's area lede.
  weights: { title: 4, what: 1, names: 1, body: 1, lede: 1 },
  floor: 0.2,
  // Experiment switches, off by default: stem ("light" | "plural" | "none"), split hyphenated words,
  // add the parts of a camelCase word, a bonus for adjacent query words, a factor for a heading holding them all.
  stem: "light", hyphen: false, camel: false, phrase: 0, titleAll: 1,
};

const STOPWORDS = new Set(`a an and any are as at be been being both but by can cannot did do does
  for from get got had has have how i if in into is it its just like made make many me more most much my
  need never new no not now of on one only or other our out over said same say says see so some still such
  than that the their then there these they this those to two up us use used using via was we were what when
  where which while who why will with would you your`.trim().split(/\s+/));
// A name with a slash, or a file name with an extension: kept whole and never stemmed.
const PATHISH = /[A-Za-z0-9_.-]*\/[A-Za-z0-9_./-]+|\b[A-Za-z0-9_-]+\.(?:md|mjs|js|ts|tsx|sh|json|css|html|toml|yaml|yml)\b/g;
const WORDS = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu, WORDS_SPLIT = /[\p{L}\p{N}][\p{L}\p{N}'’]*/gu;

// A light suffix stripper, not Porter. Paths are never stemmed: `spec/rules` and `spec/rule` are different files.
export function stem(w) {
  if (w.includes("/") || w.includes(".")) return w;
  return w
    .replace(/ies$/, "y")
    .replace(/(sses|shes|ches|xes)$/, (m) => m.slice(0, -2))
    .replace(/([^s])s$/, "$1")
    .replace(/(ingly|edly|ing|ed|ly|ness|ment|tions?|sions?)$/, "")
    .replace(/(.)\1$/, "$1") || w;
}

const STEMMERS = { light: stem, plural: (w) => (w.includes("/") || w.includes(".") ? w : w.replace(/ies$/, "y").replace(/(sses|shes|ches|xes)$/, (m) => m.slice(0, -2)).replace(/([^s])s$/, "$1")), none: (w) => w };

// Text → each (term, word as written): one function, so a query and a passage are never cut into words differently.
const stems = new Map();
function cut(text, each, cfg) {
  const s = String(text), st = STEMMERS[cfg.stem] ?? stem;
  const one = (word) => {
    const w = word.toLowerCase();
    if (w.length < 3 || STOPWORDS.has(w)) return;
    const key = cfg.stem + "\n" + w;
    let term = stems.get(key);
    if (term === undefined) stems.set(key, (term = st(w)));
    each(term, word);
  };
  for (const m of s.match(PATHISH) ?? []) each(m.toLowerCase(), m);
  for (const m of s.matchAll(cfg.hyphen ? WORDS_SPLIT : WORDS)) {
    const word = m[0].replace(/['’-]+$/, "");
    one(word);
    if (cfg.camel && /\p{Ll}\p{Lu}/u.test(word)) for (const p of word.split(/(?<=\p{Ll})(?=\p{Lu})/u)) one(p);
  }
}
export const termsOf = (text, cfg = TOPIC) => { const out = []; cut(text, (t) => out.push(t), cfg); return out; };
export const wordsOf = (text, cfg = TOPIC) => { const out = []; cut(text, (term, word) => out.push({ term, word }), cfg); return out; };

// One unit per claim and area: its fields' term frequencies and lengths. → { units, df, avg, n }
export function topicIndex(ix, cfg = TOPIC) {
  const fields = Object.keys(cfg.weights).filter((f) => cfg.weights[f] > 0);
  const prose = (decl) => mask(decl.text, { doubleTicks: false, heading: true });
  const ledes = new Map(), ledeOf = (area) => ledes.get(area) ?? ledes.set(area, termsOf(prose(ix.ctx.decls.get(area)), cfg)).get(area);
  const units = ix.ids.map((id) => {
    const decl = ix.ctx.decls.get(id), area = ix.areaOf(id);
    const texts = {
      title: titleOf(decl),
      what: whatOf(decl).what,
      names: ix.tokens.get(id).map((s) => s.token).join("\n"),
      body: prose(decl),
      areaTitle: area !== id && ix.ctx.decls.has(area) ? titleOf(ix.ctx.decls.get(area)) : "",
    };
    const cut = { lede: () => (area !== id && ix.ctx.decls.has(area) ? ledeOf(area) : []) };
    const per = {}, any = new Set();
    for (const f of fields) {
      const tf = new Map(), ts = cut[f] ? cut[f]() : termsOf(texts[f] ?? "", cfg);
      for (const term of ts) { tf.set(term, (tf.get(term) ?? 0) + 1); any.add(term); }
      per[f] = { tf, len: ts.length, seq: cfg.phrase ? ts : null };
    }
    return { id, per, any, title: new Set(per.title?.tf.keys() ?? termsOf(texts.title, cfg)) };
  });
  const df = new Map();
  for (const u of units) for (const t of u.any) df.set(t, (df.get(t) ?? 0) + 1);
  const avg = {};
  for (const f of fields) avg[f] = units.reduce((a, u) => a + u.per[f].len, 0) / (units.length || 1);
  return { units, df, avg, n: units.length, cfg };
}

// The units matching a query, best first, above the floor or holding every query word in their heading.
// → { terms: [query words kept], rows: [{id, score, matched}] }
export function topicRank(tix, query) {
  const { units, df, avg, n, cfg } = tix, fields = Object.keys(cfg.weights).filter((f) => cfg.weights[f] > 0);
  const q = new Map();
  for (const { term, word } of wordsOf(query, cfg)) if (!q.has(term)) q.set(term, word);
  const scored = [];
  for (const u of units) {
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
    // Adjacent query words in a field, in order: a bonus of the pair's mean IDF, per field, weighted.
    if (cfg.phrase && s > 0 && q.size > 1) {
      const qs = [...q.keys()], idf = (t) => { const k = df.get(t) ?? 0; return Math.log(1 + (n - k + 0.5) / (k + 0.5)); };
      for (const f of fields) {
        const seq = u.per[f].seq;
        if (!seq) continue;
        for (let i = 0; i + 1 < qs.length; i++) {
          for (let j = 0; j + 1 < seq.length; j++) if (seq[j] === qs[i] && seq[j + 1] === qs[i + 1]) { s += cfg.phrase * cfg.weights[f] * (idf(qs[i]) + idf(qs[i + 1])) / 2; break; }
        }
      }
    }
    const titled = q.size > 0 && [...q.keys()].every((t) => u.title.has(t));
    if (titled && cfg.titleAll !== 1) s *= cfg.titleAll;
    if (s > 0) scored.push({ id: u.id, score: s, matched, titled });
  }
  scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  const best = scored[0]?.score ?? 0;
  const rows = scored.filter((r) => r.score >= best * cfg.floor || r.titled)
    .map((r) => ({ id: r.id, score: Math.round(r.score * 100) / 100, matched: r.matched }));
  return { terms: [...q.values()], rows };
}
