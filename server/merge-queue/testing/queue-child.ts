/**
 * Tests only: the merge queue in a process of its own, for the crash scenarios. It loads the fixture project's queue
 * from the given state root (recovering what a stop left), lets it run, and SIGKILLs itself right before or right
 * after the landing's fast-forward of the target: the git wrapper it hands the queue sees the landing's own git
 * command (`merge --ff-only` in the main checkout, or `update-ref refs/heads/<target>`). Nothing in the product
 * knows about this: it is the queue's ordinary `git` dependency.
 *
 *   bun server/merge-queue/testing/queue-child.ts '{"stateRoot": "...", "root": "...", "fault": "before-ff"|"after-ff"}'
 */
import { type Git, realGit } from "../guard";
import { MergeQueues } from "../queue";
import { queueDeps } from "./harness";

const { stateRoot, root, fault, resume } = JSON.parse(process.argv[2] ?? "{}") as { stateRoot: string; root: string; fault: "before-ff" | "after-ff"; resume?: boolean };

// The landing's own command, whatever `-c` options come first: `merge --ff-only <tip>` in the target's checkout, or
// `update-ref refs/heads/<target> <tip> <from>` when nothing has it checked out.
const isLanding = (args: string[]) => (args.includes("merge") && args.includes("--ff-only")) || (args.includes("update-ref") && args.some((a) => a.startsWith("refs/heads/")));

const git: Git = async (args, cwd, opts) => {
  if (isLanding(args) && fault === "before-ff") {
    console.log(`child: killed before ${args.join(" ")}`);
    process.kill(process.pid, "SIGKILL");
  }
  const r = await realGit(args, cwd, opts);
  if (isLanding(args) && fault === "after-ff") {
    console.log(`child: killed after ${args.join(" ")} (exit ${r.code})`);
    process.kill(process.pid, "SIGKILL");
  }
  return r;
};

const queues = new MergeQueues(queueDeps(stateRoot, { git, log: (l) => console.log(l) }));
const q = await queues.get(root);
if (resume) await q.resume();
// Runs until the fault kills it; a safety net so a missed fault point never hangs the test.
setTimeout(() => {
  console.log("child: no landing within 120 s");
  process.exit(7);
}, 120_000);
