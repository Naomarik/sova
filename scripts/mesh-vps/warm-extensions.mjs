// ON THE VPS (run by remote-setup.sh after a build, from ~/sova-mesh/app with sova-mesh.env loaded):
//   node scripts/mesh-vps/warm-extensions.mjs
// Fills jiti's on-disk transform cache ($TMPDIR/jiti) for every extension in $PI_CODING_AGENT_DIR/extensions, so the first
// session after a deploy doesn't stall Sova's event loop for seconds while pi compiles them (seen live: ~6 s, 16 extensions).
// jiti keys its cache on its version + file name + a hash of the source, so this separate process fills the entries Sova's own
// loader (the same jiti, from pi's dependencies) reads later. It only IMPORTS the entry files: no extension factory runs,
// nothing is registered, Sova's state is untouched. Failures are reported and never fatal.
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const agent = process.env.PI_CODING_AGENT_DIR;
if (!agent) {
  console.error("warm-extensions: PI_CODING_AGENT_DIR is not set");
  process.exit(1);
}
// the jiti pi loads extensions with (a pnpm sibling of pi, not necessarily hoisted)
const pi = realpathSync(join(process.cwd(), "node_modules/@earendil-works/pi-coding-agent"));
const piRequire = createRequire(join(pi, "package.json"));
const { createJiti } = piRequire("jiti");
// pi's own alias map (its extension loader's getAliases, built Node mode): extensions import pi's packages by name
const core = join(pi, "../pi-agent-core/dist/index.js");
const tui = join(pi, "../pi-tui/dist/index.js");
const aiCompat = join(pi, "../pi-ai/dist/compat.js");
const aiOauth = join(pi, "../pi-ai/dist/oauth.js");
const aiAll = join(pi, "../pi-ai/dist/providers/all.js");
const [tb, tbCompile, tbValue] = ["typebox", "typebox/compile", "typebox/value"].map((s) => piRequire.resolve(s));
const alias = {};
for (const scope of ["@earendil-works", "@mariozechner"]) {
  Object.assign(alias, {
    [`${scope}/pi-coding-agent`]: join(pi, "dist/index.js"),
    [`${scope}/pi-agent-core`]: core,
    [`${scope}/pi-tui`]: tui,
    [`${scope}/pi-ai/providers/all`]: aiAll,
    [`${scope}/pi-ai/compat`]: aiCompat,
    [`${scope}/pi-ai/oauth`]: aiOauth,
    [`${scope}/pi-ai`]: aiCompat,
  });
}
Object.assign(alias, { typebox: tb, "typebox/compile": tbCompile, "typebox/value": tbValue, "@sinclair/typebox": tb, "@sinclair/typebox/compile": tbCompile, "@sinclair/typebox/value": tbValue });
const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: true, alias });

const dir = join(agent, "extensions");
const entries = [];
for (const name of existsSync(dir) ? readdirSync(dir).sort() : []) {
  const p = join(dir, name);
  let st;
  try {
    st = statSync(p);
  } catch {
    continue; // dangling link
  }
  if (st.isFile() && /\.[cm]?[jt]s$/.test(name)) entries.push(p);
  else if (st.isDirectory() && existsSync(join(p, "index.ts"))) entries.push(join(p, "index.ts"));
}
const t0 = Date.now();
let ok = 0;
for (const e of entries) {
  const t = Date.now();
  try {
    await jiti.import(e, { default: true });
    ok++;
    console.log(`warm ${Date.now() - t}ms ${e.slice(dir.length + 1)}`);
  } catch (err) {
    console.log(`warm FAILED ${e.slice(dir.length + 1)}: ${String(err?.message ?? err).split("\n")[0]}`);
  }
}
console.log(`warm-extensions: ${ok}/${entries.length} in ${Date.now() - t0} ms (cache ${join(process.env.TMPDIR || "/tmp", "jiti")})`);
// an extension module may start timers at import: never wait for them
process.exit(0);
