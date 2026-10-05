// A stand-in `toc` and `read` for the harness's own tests only, so the pull checks of f and g are exercised
// before the real commands exist. replay.test.mjs copies it (with fullness.mjs) into a scratch tree's
// spec/core and routes `sova-spec.mjs toc|read` to it. It is not the tools' implementation and carries no
// contract beyond the JSON shape the harness reads:
//   toc <§id> --dir out|in|down|up|mentions → { id, dir, seed: {id}, lines: [{id, title, what, whatSource, why, whySource, bytes}], footer: {delivered: []} }
//   read <§id>                              → { id, items: [{index, id, text}], footer: {named: [§id]} }
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { specIndex, parentOf } from "./fullness.mjs";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const [cmd, id] = argv;
const root = flag("--root") ?? process.cwd();
const index = specIndex(root);
const claims = JSON.parse(readFileSync(join(root, ".sova/spec/manifest.json"), "utf8")).claims;
const out = (value, exit = 0) => { process.stdout.write(JSON.stringify({ tool: "sova-spec", command: cmd, exit, ...value }) + "\n"); process.exitCode = exit; };
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const mentions = (text, target) => new RegExp(`${esc(target)}(?![\\w./-])`).test(text);

const seed = index.passages.get(id);
if (cmd === "where") {
  // where [--all] <path>: every claim whose code names the path.
  const path = argv.slice(1).find((a) => !a.startsWith("--") && a !== flag("--root"));
  const hits = Object.keys(claims).filter((x) => (claims[x].code ?? []).includes(path)).sort();
  out({ query: path, file: { path, state: existsSync(join(root, path)) ? "read" : "missing" }, total: hits.length, counts: { claims: hits.length, ranked: 0 }, lines: hits.map((x) => ({ id: x })) });
} else if (cmd === "impact" && argv.includes("--near")) {
  // impact <§id> --near: requirers of the seed's family are consumers; uninvestigated behaviors that mention it, frontier.
  const family = Object.keys(claims).filter((x) => x === id || parentOf(x) === id);
  const lines = Object.keys(claims).sort().flatMap((x) => {
    if (family.includes(x)) return [];
    if ((claims[x].requires ?? []).some((t) => family.includes(t))) return [{ group: "consumer", id: x }];
    if (claims[x].kind === "behavior" && claims[x].requires === undefined && family.some((f) => mentions(index.passages.get(x)?.text ?? "", f))) return [{ group: "frontier", id: x }];
    return [];
  });
  out({ id, near: true, counts: { groups: { consumer: lines.filter((l) => l.group === "consumer").length, frontier: lines.filter((l) => l.group === "frontier").length } }, lines });
} else if (!seed || !claims[id]) out({ status: "refused", code: "unknown-id" }, 2);
else if (cmd === "read") out({ id, items: [{ index: 0, id, text: seed.text }], footer: { named: [...(claims[id].requires ?? [])].filter((x) => x !== id) } });
else {
  const dir = flag("--dir");
  const all = Object.keys(claims).filter((x) => index.passages.has(x)).sort();
  const pick = {
    out: () => claims[id].requires ?? [],
    in: () => all.filter((x) => (claims[x].requires ?? []).includes(id) || (claims[x].kind === "behavior" && claims[x].requires === undefined && x !== id)),
    down: () => all.filter((x) => parentOf(x) === id),
    up: () => (parentOf(id) ? [parentOf(id)] : []),
    mentions: () => all.filter((x) => x !== id && mentions(index.passages.get(x).text, id)),
  }[dir];
  if (!pick) out({ status: "refused", code: "usage" }, 2);
  else {
    // What a passage is: the first sentence of its first prose unit (paragraph or list item; tables, headings,
    // fences, comments and rules skipped), whitespace collapsed; for the seed and every line alike.
    const whatOf = (x) => {
      const units = index.passages.get(x).text.split("\n").slice(1).join("\n").replace(/^ {0,3}(`{3,}|~{3,})[^]*?^ {0,3}\1[ \t]*$/gm, "").replace(/<!--[^]*?-->/g, "").replace(/^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, "")
        .split(/\n[ \t]*\n|\n(?=[ \t]*(?:[-*+]|\d+[.)])[ \t])/).map((u) => u.replace(/^[ \t]*>[ \t]?/gm, "").trim()).filter((u) => u && !/^[|#]/.test(u));
      const body = (units[0] ?? "").replace(/^(?:[-*+]|\d+[.)])[ \t]+/, "").replace(/\s+/g, " ");
      return { what: body.split(/(?<=[.:])\s/)[0] || "(no text)", whatSource: body ? "prose" : "none" };
    };
    const lines = pick().filter((x) => index.passages.has(x)).map((x) => {
      const p = index.passages.get(x);
      const why = seed.text.split("\n").find((l) => mentions(l, x)) ?? index.passages.get(x).text.split("\n").find((l) => mentions(l, id));
      return { id: x, title: p.text.split("\n")[0].replace(/^#+ \S+( — )?/, ""), ...whatOf(x), why: why ? why.trim() : "not mentioned in this claim's text", whySource: why ? "prose" : "none", bytes: p.bytes };
    });
    out({ id, dir, seed: { id, ...whatOf(id) }, lines, footer: { delivered: [] } });
  }
}
