// A stand-in `toc` and `read` for the harness's own tests only, so the pull checks of f and g are exercised
// before the real commands exist. replay.test.mjs copies it (with fullness.mjs) into a scratch tree's
// spec/core and routes `sova-spec.mjs toc|read` to it. It is not the tools' implementation and carries no
// contract beyond the JSON shape the harness reads:
//   toc <§id> --dir out|in|down|up|mentions → { id, dir, lines: [{id, title, what, why, whyWritten, bytes}], footer: {named: [§id]} }
//   read <§id>                              → { id, text, bytes }
import { readFileSync } from "node:fs";
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
if (!seed || !claims[id]) out({ status: "refused", code: "unknown-id" }, 2);
else if (cmd === "read") out({ id, text: seed.text, bytes: seed.bytes });
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
    const lines = pick().filter((x) => index.passages.has(x)).map((x) => {
      const p = index.passages.get(x);
      const body = p.text.split("\n").slice(1).join(" ").replace(/\s+/g, " ").trim();
      const why = seed.text.split("\n").find((l) => mentions(l, x)) ?? index.passages.get(x).text.split("\n").find((l) => mentions(l, id));
      return { id: x, title: p.text.split("\n")[0].replace(/^#+ \S+( — )?/, ""), what: body.split(/(?<=[.:])\s/)[0] || "(no text)", why: why ? why.trim() : "no reason is written", whyWritten: Boolean(why), bytes: p.bytes };
    });
    const shown = new Set(lines.map((l) => l.id));
    const named = all.filter((x) => x !== id && !shown.has(x) && mentions(seed.text, x));
    out({ id, dir, lines, footer: { named } });
  }
}
