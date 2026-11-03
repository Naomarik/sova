#!/usr/bin/env node
// Tests only: a stand-in `gh` (GitHub's CLI) that never leaves the machine. Pull requests live in a JSON file
// ($GH_STANDIN_STATE); a request's head commit is read from the local bare origin ($GH_STANDIN_ORIGIN). It answers the
// calls server/merge-queue/hosts/github.ts makes: auth status, pr list, pr create, pr view, pr edit. Every call is
// appended to the state's `calls` list, so a test can say what Sova asked the host.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const stateFile = process.env.GH_STANDIN_STATE;
const origin = process.env.GH_STANDIN_ORIGIN;
if (!stateFile || !origin) {
  process.stderr.write("stand-in gh: GH_STANDIN_STATE and GH_STANDIN_ORIGIN must be set\n");
  process.exit(2);
}
const args = process.argv.slice(2);
const st = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { next: 1, prs: [], calls: [] };
st.calls.push(args);
const save = () => writeFileSync(stateFile, JSON.stringify(st, null, 2));
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const readStdin = () => {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
};
const headOf = (branch) => {
  try {
    return execFileSync("git", ["rev-parse", `refs/heads/${branch}`], { cwd: origin, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};
const json = (pr) => ({
  number: pr.number,
  url: `https://github.com/o/r/pull/${pr.number}`,
  state: pr.state, // OPEN | MERGED | CLOSED
  isDraft: false,
  mergedAt: pr.mergedAt ?? null,
  mergeCommit: pr.mergeCommit ? { oid: pr.mergeCommit } : null,
  mergeable: "MERGEABLE",
  reviewDecision: "",
  statusCheckRollup: [],
  headRefOid: headOf(pr.head),
  headRefName: pr.head,
  baseRefName: pr.base,
});
const out = (v) => process.stdout.write(typeof v === "string" ? v : JSON.stringify(v));

const [a, b] = args;
if (a === "auth" && b === "status") {
  out("github.com\n  ✓ Logged in to github.com account stand-in\n");
  save();
  process.exit(0);
}
if (a === "pr" && b === "list") {
  const head = opt("--head");
  const base = opt("--base");
  const state = opt("--state") ?? "open";
  out(st.prs.filter((p) => (!head || p.head === head) && (!base || p.base === base) && (state === "all" || p.state === "OPEN")).map(json));
  save();
  process.exit(0);
}
if (a === "pr" && b === "create") {
  const head = opt("--head");
  const base = opt("--base");
  if (!headOf(head)) {
    process.stderr.write(`pull request create failed: head branch ${head} isn't on the host\n`);
    save();
    process.exit(1);
  }
  if (st.prs.some((p) => p.head === head && p.base === base && p.state === "OPEN")) {
    process.stderr.write(`a pull request for branch "${head}" into branch "${base}" already exists\n`);
    save();
    process.exit(1);
  }
  const pr = { number: st.next++, head, base, title: opt("--title") ?? "", body: opt("--body-file") === "-" ? readStdin() : (opt("--body") ?? ""), state: "OPEN" };
  st.prs.push(pr);
  out(`https://github.com/o/r/pull/${pr.number}\n`);
  save();
  process.exit(0);
}
if (a === "pr" && (b === "view" || b === "edit")) {
  const pr = st.prs.find((p) => p.number === Number(args[2]));
  if (!pr) {
    process.stderr.write(`GraphQL: Could not resolve to a PullRequest with the number of ${args[2]}.\n`);
    save();
    process.exit(1);
  }
  if (b === "view") out(json(pr));
  else {
    if (opt("--title") !== undefined) pr.title = opt("--title");
    if (opt("--body-file") === "-") pr.body = readStdin();
  }
  save();
  process.exit(0);
}
process.stderr.write(`stand-in gh: unknown call: ${args.join(" ")}\n`);
save();
process.exit(1);
