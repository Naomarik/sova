import { describe, test } from "node:test";
import { expect } from "./testing/expect";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { scratchRoot } from "../test-scratch";
import { assertCopyOutsideState, CopyRefused, mergeCopyPath } from "./copy";

describe("the merge copy's place", () => {
  test("beside the project: <parent>/.worktrees/<repo>-merge", () => {
    expect(mergeCopyPath("/home/u/webapps/sova")).toBe("/home/u/webapps/.worktrees/sova-merge");
    expect(mergeCopyPath("/srv/motorsaif")).toBe("/srv/.worktrees/motorsaif-merge");
  });

  test("refused under the state root, under ~/.pi, through a symlink, and as the main checkout (the Oct 29 failure)", () => {
    const root = scratchRoot("mq-copy-");
    const home = join(root, "home");
    const state = join(home, ".pi", "agent", "sova");
    mkdirSync(state, { recursive: true });
    const refused = (path: string, o: { root?: string } = {}) => {
      try {
        assertCopyOutsideState(path, { state, home, ...o });
      } catch (err) {
        expect(err).toBeInstanceOf(CopyRefused);
        return (err as Error).message;
      }
      return null;
    };
    expect(refused(join(state, "merge-queue", "copies", "demo-merge"))).toMatch(/under Sova's state root/);
    expect(refused(join(home, ".pi", "other", "x-merge"))).toMatch(/\.pi/);
    // A state root moved elsewhere (PI_CODING_AGENT_DIR) is still refused, and so is ~/.pi.
    const moved = join(root, "agent-elsewhere", "sova");
    mkdirSync(moved, { recursive: true });
    expect(() => assertCopyOutsideState(join(moved, "x"), { state: moved, home })).toThrow(CopyRefused);
    // A path that reaches the state root through a symlink.
    const link = join(root, "innocent");
    symlinkSync(state, link);
    expect(refused(join(link, "demo-merge"))).toMatch(/state root/);
    // The project's own main checkout.
    const project = join(root, "projects", "demo");
    mkdirSync(project, { recursive: true });
    expect(refused(project, { root: project })).toMatch(/main checkout/);
    // Beside the project: fine.
    expect(refused(mergeCopyPath(project), { root: project })).toBeNull();
    // A sibling whose name merely starts like the state root is not inside it.
    expect(() => assertCopyOutsideState(`${moved}-not`, { state: moved, home })).not.toThrow();
  });
});
