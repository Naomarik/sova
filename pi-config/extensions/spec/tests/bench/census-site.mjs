// Site boundary check (lane B1, fix 5): on a `git archive` copy of a project at REV, change site files plus one
// file that must stay outside, run `census --changed`, and count the site changes the census calls outside.
// Not a test (the runner's glob is tests/*.test.mjs). Node stdlib, git and tar only; writes only under --work.
//
//   node census-site.mjs --src <git repo> --rev REV --work DIR [--core DIR] [--files a,b,...] [--keep-outside path]
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i < 0 ? d : process.argv[i + 1]; };
const src = arg("--src"), rev = arg("--rev", "HEAD"), work = resolve(arg("--work", ""));
const core = resolve(arg("--core", join(dirname(fileURLToPath(import.meta.url)), "../../core")));
const files = arg("--files", "site/src/pages/index.astro,site/astro.config.mjs,site/src/content/docs/install.md").split(",");
const keepOutside = arg("--keep-outside", "pi-config/README.md");
if (!src || !arg("--work")) { console.error("--src and --work are required"); process.exit(2); }

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
const sh = (cmd, args, opts = {}) => { const r = spawnSync(cmd, args, { encoding: "utf8", env, maxBuffer: 1 << 30, ...opts }); if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${r.stderr}`); return r.stdout; };
const git = (dir, ...a) => sh("git", ["-c", "user.name=b", "-c", "user.email=b@b", "-c", "commit.gpgsign=false", "-C", dir, ...a]);

const dir = join(work, `site-${rev.slice(0, 12)}`);
rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
sh("tar", ["-x", "-C", dir], { input: spawnSync("git", ["-C", src, "archive", rev], { env, maxBuffer: 1 << 30 }).stdout, encoding: undefined });
git(dir, "init", "-q"); git(dir, "add", "-A"); git(dir, "commit", "-qm", "base");
for (const f of [...files, keepOutside]) appendFileSync(join(dir, f), "\n<!-- census bench -->\n");
const r = spawnSync(process.execPath, [join(core, "sova-spec.mjs"), "census", "--changed", "--json", "--root", dir], { encoding: "utf8", env, maxBuffer: 1 << 28 });
const c = JSON.parse(r.stdout).census;
const site = (p) => p.startsWith("site/");
const out = {
  rev, boundary: c.boundary,
  siteChanged: files.length,
  siteOutside: c.outside.filter(site),
  siteClaimed: c.claimed.filter((e) => site(e.path)),
  siteUnclaimed: c.unclaimed.filter(site),
  guardOutside: c.outside.includes(keepOutside),
};
console.log(JSON.stringify(out, null, 2));
console.log(`site changes treated as outside: ${out.siteOutside.length}/${files.length}; ${keepOutside} still outside: ${out.guardOutside}`);
