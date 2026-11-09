// Runs a real retirement pass and kills itself at the step named: the restart-in-the-middle cases, with no chance for a
// finally to run. argv: <project> <target> <state> <after-pin | before-remove | after-remove | before-branch-delete | after-ledger-<n>>.
import type { Git } from "../pi-config/extensions/worktrees/git.ts";
import { retirePass } from "./worktree-retire";
import { plainRetireDeps } from "./worktree-retire-deps.integration.fixture";

const [project, target, state, at] = process.argv.slice(2) as [string, string, string, string];
const die = (): never => process.kill(process.pid, "SIGKILL") as never;
const verb = (args: readonly string[]): string[] => {
  const a = [...args];
  while (a[0] === "-c") a.splice(0, 2);
  return a;
};
const d = plainRetireDeps({ project, target, state });
// A sixth argument: more repositories after the project, for a stop between two of them.
const more = process.argv[6]?.split(",") ?? [];
if (more.length) d.repos = () => [project, ...more];
const write = d.gitWrite;
d.gitWrite = (async (args, cwd) => {
  const a = verb(args).filter((x) => x !== "--");
  const deletes = (a[0] === "branch" && a[1] === "-d") || (a[0] === "update-ref" && a[1] === "-d");
  if (at === "before-branch-delete" && deletes) die();
  const r = await write(args, cwd);
  if (at === "after-pin" && a[0] === "update-ref" && a[1]?.startsWith("refs/sova/retired/")) die();
  return r;
}) as Git;
const remove = d.gitRemove;
d.gitRemove = (async (args, cwd) => {
  if (at === "before-remove") die();
  const r = await remove(args, cwd);
  if (at === "after-remove") die();
  return r;
}) as Git;
// `after-ledger-<n>`: killed right after the nth removal is recorded in the ledger, as a restart mid first pass is.
const nth = /^after-ledger-(\d+)$/.exec(at)?.[1];
if (nth) {
  const append = d.appendLedger;
  let seen = 0;
  d.appendLedger = (entries) => {
    append(entries);
    if (++seen === Number(nth)) die();
  };
}
await retirePass(d);
