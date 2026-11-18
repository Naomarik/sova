// Shared by the A/B cycle's scripts: the campaign folder's paths and files (references/ledger.md), a
// tiny argument reader, and a client for one arm's test copy of Sova. Node builtins only, plus Sova's
// own token reader, so it runs from any chat with no install.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The playbook folder, and Sova's folder it ships in (override: $SOVA_ROOT). */
export const FOLDER = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SOVA_ROOT = process.env.SOVA_ROOT ? resolve(process.env.SOVA_ROOT) : resolve(FOLDER, "..", "..");

/** `--key value` and `--flag` after the positionals. */
export function args(argv = process.argv.slice(2)) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) opt[key] = true;
      else (opt[key] = next), i++;
    } else pos.push(a);
  }
  return { pos, opt };
}

export function die(message, code = 1) {
  console.error(message);
  process.exit(code);
}

export const readJson = (p, fallback) => {
  if (!existsSync(p)) {
    if (fallback !== undefined) return fallback;
    die(`missing ${p}`);
  }
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    die(`${p}: ${e.message}`);
  }
};
export const writeJson = (p, v) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`);
};
export const readJsonl = (p) =>
  existsSync(p)
    ? readFileSync(p, "utf8")
        .split("\n")
        .map((l, i) => [l.trim(), i])
        .filter(([l]) => l && !l.startsWith("//"))
        .map(([l, i]) => {
          try {
            return JSON.parse(l);
          } catch (e) {
            die(`${p}:${i + 1}: ${e.message}`);
          }
        })
    : [];
export const listDir = (p) => (existsSync(p) ? readdirSync(p) : []);

/** "zai/glm-5.3" + "low" → a folder name: "zai_glm-5.3@low". */
export const slug = (m) => `${m.model.replace(/[^\w.-]+/g, "_")}${m.effort ? `@${m.effort}` : ""}`;
/** "zai/glm-5.3 · low". */
export const modelText = (m) => `${m.model}${m.effort ? ` · ${m.effort}` : ""}`;

/** "zai/glm-5.3@low" or "zai/glm-5.3" → {model, effort}. */
export function parseModel(s) {
  const [model, effort] = String(s).split("@");
  return effort ? { model, effort } : { model };
}

/** The campaign folder's files (references/ledger.md). */
export function campaign(dir) {
  const W = resolve(dir);
  if (!existsSync(join(W, "campaign.json"))) die(`${W} has no campaign.json (references/ledger.md says what goes in it)`, 3);
  const c = readJson(join(W, "campaign.json"));
  const round = (n) => join(W, "rounds", String(n));
  return {
    W,
    c,
    cases: () => readJsonl(join(W, "cases.jsonl")),
    round,
    arms: (n) => readJson(join(round(n), "arms.json")),
    result: (n, arm, m, id) => join(round(n), "results", arm, slug(m), `${id}.json`),
    grade: (n, arm, m, id) => join(round(n), "grades", arm, slug(m), `${id}.json`),
    shot: (n, arm, m, id) => join(round(n), "shots", arm, slug(m), `${id}.png`),
    ledger: () => readJsonl(join(W, "ledger.jsonl")),
    ledgerFile: join(W, "ledger.jsonl"),
    models: (opt) => (opt ? String(opt).split(",").map(parseModel) : c.testModels ?? die("campaign.json has no testModels", 3)),
  };
}

/** Which cases a run takes: --cases fail,pass (groups) or ids; default every case not sealed. */
export function pickCases(all, sel) {
  if (!sel) return all.filter((k) => k.group !== "sealed");
  const want = String(sel).split(",");
  return all.filter((k) => want.includes(k.id) || want.includes(k.group));
}

/** A client for one arm's test copy of Sova: its URL and its agent dir (where its token is). */
export async function sovaClient(arm) {
  const { tokenHeaders } = await import(join(SOVA_ROOT, "scripts", "sova-token.mjs"));
  const base = String(arm.url ?? die("an arm with how \"sova\" needs url", 3)).replace(/\/+$/, "");
  const headers = { ...tokenHeaders(arm.agentDir), "content-type": "application/json" };
  const call = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await r.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${json.error ?? text.slice(0, 200)}`);
    return json;
  };
  return {
    base,
    get: (p) => call("GET", p),
    post: (p, b) => call("POST", p, b),
  };
}

/** A headless Chromium through Sova's own playwright-core (no download): $AB_BROWSER, else the usual places. */
export async function launchBrowser() {
  const { chromium } = await import(join(SOVA_ROOT, "node_modules", "playwright-core", "index.mjs"));
  const candidates = [process.env.AB_BROWSER, "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"].filter(Boolean);
  const exe = candidates.find((p) => existsSync(p));
  if (!exe) die(`no Chromium or Chrome found; set AB_BROWSER to one (looked in ${candidates.join(", ")})`);
  return chromium.launch({ executablePath: exe, headless: true, args: ["--no-sandbox"] });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run fn over items, at most n at a time. */
export async function pool(items, n, fn) {
  let i = 0;
  const work = async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, n) }, work));
}
