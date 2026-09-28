/**
 * `vis gitgraph` — STUB. Owner: the gitgraph member. Design the grammar (commits, branches,
 * checkout, merge, cherry-pick/rebase as new commits, tags), build it from core/grammar.ts, call
 * takeMarks/applyMarks with commit ids as targets, then remove the stub marker from its section
 * in vis-mode.md and its `stub` flag in registry.ts.
 */

import { fail, type VisBase } from "../../core/grammar";

export interface GitgraphSpec extends VisBase {
  kind: "gitgraph";
}

export function parseGitgraph(_body: string): GitgraphSpec {
  return fail(0, "vis gitgraph isn't drawn yet: use vis flow with dir: right");
}
