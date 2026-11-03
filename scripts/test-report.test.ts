import { describe, expect, test } from "bun:test";
import { bunReport } from "./test-report.mjs";

const out = (s: string) => s.replace(/^\n/, "");

describe("bunReport (run-tests' SOVA_OUT)", () => {
  test("names each failing test with the error bun printed above it, and sums the counts", () => {
    const r = bunReport([
      {
        file: "a.test.ts", code: 1, pass: 1, fail: 1, skip: 1,
        out: out(`
a.test.ts:
error: expect(received).toBe(expected)

Expected: 2
Received: 1
(fail) grp > one fails [0.15ms]
(pass) grp > ok
(skip) sk
`),
      },
      { file: "b.test.ts", code: 0, pass: 3, fail: 0, skip: 0, out: "(pass) x\n(pass) y\n(pass) z\n" },
    ]);
    expect(r.passed).toBe(4);
    expect(r.failed).toBe(1);
    expect(r.skipped).toBe(1);
    expect(r.errors).toBe(0);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0].name).toBe("grp > one fails");
    expect(r.failures[0].file).toBe("a.test.ts");
    expect(r.failures[0].message).toContain("Received: 1");
    expect(r.failures[0].message).not.toContain("(pass)");
    expect(r.failingFiles).toEqual(["a.test.ts"]);
  });

  test("a second failure's message holds only what came after the test before it", () => {
    const r = bunReport([{ file: "a.test.ts", code: 1, pass: 0, fail: 2, skip: 0, out: "boom one\n(fail) first\nboom two\n(fail) second [3ms]\n" }]);
    expect(r.failures.map((f: { name: string; message?: string }) => [f.name, f.message])).toEqual([["first", "boom one"], ["second", "boom two"]]);
  });

  test("a file that failed with no failing test (a crash, a kill) is an error named by its file", () => {
    const r = bunReport([{ file: "c.test.ts", code: 1, pass: 0, fail: 0, skip: 0, out: "run-tests: c.test.ts still running after 300 s; killed\n" }]);
    expect(r.errors).toBe(1);
    expect(r.failures).toEqual([{ name: "c.test.ts", file: "c.test.ts", message: "run-tests: c.test.ts still running after 300 s; killed" }]);
    expect(r.failingFiles).toEqual(["c.test.ts"]);
  });

  test("every failing file is listed even past the 50-failure cap the writer applies", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ file: `f${i}.test.ts`, code: 1, pass: 0, fail: 1, skip: 0, out: `(fail) t${i}\n` }));
    const r = bunReport(many);
    expect(r.failingFiles).toHaveLength(60);
    expect(r.failures).toHaveLength(60);
  });

  test("lists every file it ran, passing or not (ranFiles): a reader can tell a file that ran from one never selected", () => {
    const r = bunReport([
      { file: "a.test.ts", code: 0, pass: 1, fail: 0, skip: 0, out: "(pass) a\n" },
      { file: "b.integration.test.ts", code: 1, pass: 0, fail: 1, skip: 0, out: "(fail) b\n" },
    ]);
    expect(r.ranFiles).toEqual(["a.test.ts", "b.integration.test.ts"]);
  });
});
