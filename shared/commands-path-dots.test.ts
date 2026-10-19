// Run: pnpm test -- shared/commands-path-dots.test.ts
// A command's path param that is a dot segment is refused by the request builder: `.` and `..`
// survive encodeURIComponent, and URL parsing would resolve them out of the route (the Overseer's
// `pid: ".."` on project.costs would land on GET /api/costs).
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRequest, findCommand } from "./commands-catalog";

test("`.`, `..` and their %2e spellings are refused for a path param; a name with dots in it is not", () => {
  const costs = findCommand("project.costs")!;
  for (const v of [".", "..", "%2e", "%2E%2E", ".%2e", "%2e."]) assert.throws(() => buildRequest(costs, { pid: v }), /--pid can't be "\." or "\.\."/, v);
  assert.equal(buildRequest(costs, { pid: "prj_a.b" }).url.split("?")[0], "/api/projects/prj_a.b/costs");
  assert.equal(buildRequest(costs, { pid: "..." }).url.split("?")[0], "/api/projects/.../costs");
});
