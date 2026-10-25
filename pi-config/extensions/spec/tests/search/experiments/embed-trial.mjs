// Side trial, for the record only: local sentence embeddings on the spec-search dev set. Never part of Sova.
// Copied here as evidence of what ran; it was run from a scratch dir OUTSIDE the repo, as
//   node embed-trial.mjs <repo root> <foldaidev forum/search dir>
// reusing that dir's installed @huggingface/transformers and downloaded models read-only (no network).
// It writes a core copy and vector caches beside itself, so run a copy placed outside the repo.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const REPO = process.argv[2], FOLD = process.argv[3];
const HERE = path.dirname(new URL(import.meta.url).pathname);
// A scratch copy of the core, with lookCore exported (the shipped file exports no loader).
const COPY = path.join(HERE, "core");
fs.rmSync(COPY, { recursive: true, force: true }); fs.mkdirSync(COPY);
for (const f of fs.readdirSync(path.join(REPO, "pi-config/extensions/spec/core"))) if (f.endsWith(".mjs")) fs.copyFileSync(path.join(REPO, "pi-config/extensions/spec/core", f), path.join(COPY, f));
fs.appendFileSync(path.join(COPY, "sova-spec.mjs"), "\nexport { lookCore };\n");
const core = (f) => import(pathToFileURL(path.join(COPY, f)).href);
const { indexOf } = await core("graph.mjs");
const { titleOf, whatOf, mask } = await core("toc.mjs");
const { topicIndex, topicRank, TOPIC } = await core("topic.mjs");
const bench = await import(pathToFileURL(path.join(REPO, "pi-config/extensions/spec/tests/search/bench.mjs")).href);
const tf = await import(pathToFileURL(path.join(FOLD, "node_modules/@huggingface/transformers/src/transformers.js")).href).catch(() =>
  import(pathToFileURL(path.join(FOLD, "node_modules/@huggingface/transformers/dist/transformers.node.mjs")).href));
tf.env.cacheDir = path.join(FOLD, ".models");
tf.env.localModelPath = path.join(FOLD, ".models");
tf.env.allowRemoteModels = false;

// The spec graph through the core's own loader (sova-spec.mjs exports nothing, so load as the look commands do).
const spec = await core("sova-spec.mjs");
const lookCore = spec?.lookCore?.();
if (!lookCore) throw new Error("need lookCore export");
const ctx = lookCore.load(REPO, lookCore.DEFAULT_SPEC);
const ix = indexOf(ctx, lookCore.parentOf);

const MODELS = { minilm: ["Xenova/all-MiniLM-L6-v2", 256, "", ""], "bge-small": ["Xenova/bge-small-en-v1.5", 512, "Represent this sentence for searching relevant passages: ", ""] };
const cacheFile = (m) => path.join(HERE, `vec-${m}.json`);
async function embedAll(m, texts) {
  const [id, max] = MODELS[m];
  const cache = fs.existsSync(cacheFile(m)) ? JSON.parse(fs.readFileSync(cacheFile(m), "utf8")) : {};
  const ex = await tf.pipeline("feature-extraction", id, { dtype: "q8" });
  const key = (t) => createHash("sha256").update(t).digest("hex");
  const todo = [...new Set(texts.filter((t) => !cache[key(t)]))];
  for (let i = 0; i < todo.length; i += 32) {
    const s = todo.slice(i, i + 32);
    const rows = (await ex(s, { pooling: "mean", normalize: true, truncation: true, max_length: max })).tolist();
    s.forEach((t, j) => (cache[key(t)] = rows[j].map((v) => Math.round(v * 1e5) / 1e5)));
    if (i % 640 === 0) process.stderr.write(`${m} ${i}/${todo.length}\n`);
  }
  fs.writeFileSync(cacheFile(m), JSON.stringify(cache));
  return texts.map((t) => cache[key(t)]);
}
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);

const units = ix.ids.map((id) => {
  const d = ctx.decls.get(id), head = `${titleOf(d)}. ${whatOf(d).what}`;
  const body = mask(d.text, { doubleTicks: false, heading: true }).replace(/\s+/g, " ").trim();
  const chunks = [];
  for (let i = 0; i < body.length; i += 1000) chunks.push(body.slice(i, i + 1000));
  return { id, head, chunks };
});
const dev = JSON.parse(fs.readFileSync(path.join(REPO, "pi-config/extensions/spec/tests/search/judgments.dev.json"), "utf8"));
const tix = topicIndex(ix, TOPIC);
const report = (name, rank) => {
  const rows = dev.queries.map((q) => ({ vocabularyGap: !!q.vocabularyGap, bytes: 0, results: 10, exit: 0, ...bench.scoreOne(rank(q).slice(0, 10), q.targets) }));
  const a = bench.aggregate(rows), g = bench.aggregate(rows.filter((r) => r.vocabularyGap));
  console.log(`| ${name} | ${(a.r1 * 100).toFixed(1)} | ${(a.r3 * 100).toFixed(1)} | ${a.mrr.toFixed(3)} | ${(a.r3any * 100).toFixed(1)} | ${(g.r3 * 100).toFixed(1)} / ${g.mrr.toFixed(3)} |`);
};
const lex = (q) => topicRank(tix, q.query).rows.map((r) => r.id);
report(`lexical (shipped TOPIC, topic rows only)`, lex);
for (const m of Object.keys(MODELS)) {
  const t0 = performance.now();
  const heads = await embedAll(m, units.map((u) => u.head));
  const flat = units.flatMap((u) => u.chunks);
  const cv = await embedAll(m, flat);
  const qv = await embedAll(m, dev.queries.map((q) => MODELS[m][2] + q.query));
  let k = 0;
  const vecs = units.map((u, i) => [heads[i], ...u.chunks.map(() => cv[k++])]);
  const qi = new Map(dev.queries.map((q, i) => [q.id, qv[i]]));
  const head = (q) => units.map((u, i) => [u.id, dot(qi.get(q.id), heads[i])]).sort((a, b) => b[1] - a[1]).map((x) => x[0]);
  const chunks = (q) => units.map((u, i) => [u.id, Math.max(...vecs[i].map((v) => dot(qi.get(q.id), v)))]).sort((a, b) => b[1] - a[1]).map((x) => x[0]);
  report(`dense ${m} head (title + first sentence)`, head);
  report(`dense ${m} chunks (max over head and 1000-char prose windows)`, chunks);
  for (const w of [1, 0.5]) {
    const rrf = (q) => {
      const s = new Map(), add = (ids, wt) => ids.forEach((id, r) => s.set(id, (s.get(id) ?? 0) + wt / (60 + r + 1)));
      add(lex(q), 1); add(chunks(q).slice(0, 100), w);
      return [...s].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map((x) => x[0]);
    };
    report(`hybrid RRF lexical + ${m} chunks, w=${w}, k=60`, rrf);
  }
  console.error(`${m}: ${((performance.now() - t0) / 1000).toFixed(1)} s`);
}
