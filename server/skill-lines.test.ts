// Run: pnpm test -- server/skill-lines.test.ts. Which lines of a file a read tool call or a shell command
// put in front of the model (server/skill-lines.ts), resolved against a stand-in 510-line file.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BASH_CAP, fileLinesOf, type LineChain, linesLoaded, readToolChain, shellReads } from "./skill-lines";

const F = "/s/design/SKILL.md";
const file = fileLinesOf(Array.from({ length: 510 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
const span = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
/** The lines a command prints of F, sorted; null when it prints none of F at all. */
const shown = (command: string): number[] | null => {
  const reads = shellReads(command).filter((r) => r.path === F);
  return reads.length ? [...linesLoaded(reads.map((r) => r.chain), file)].sort((a, b) => a - b) : null;
};

describe("shell commands that print a file", () => {
  // Each form once, with the lines it prints by hand. The case that started this: `sed -n 1,140p` used
  // to count as no read at all, and `head -5` as the whole file.
  const cases: [string, number[] | null][] = [
    [`cat ${F}`, span(1, 510)],
    [`cat -n ${F}`, span(1, 510)],
    [`nl -ba ${F}`, span(1, 510)],
    [`nl -b a ${F}`, span(1, 510)],
    [`less ${F}`, span(1, 510)],
    [`bat --plain ${F}`, span(1, 510)],
    [`bat -r 10:20 ${F}`, span(10, 20)],
    [`bat --line-range=500: ${F}`, span(500, 510)],
    [`sed -n 1,140p ${F}`, span(1, 140)],
    [`sed -n '1,140p' "${F}"`, span(1, 140)],
    [`sed -n 1,600p ${F}`, span(1, 510)],
    [`sed -n '141,$p' ${F}`, span(141, 510)],
    [`sed -n '5p' ${F}`, [5]],
    [`sed -n '$p' ${F}`, [510]],
    [`sed -n '10,+4p' ${F}`, span(10, 14)],
    [`sed -n '1,10p;20,30p' ${F}`, [...span(1, 10), ...span(20, 30)]],
    [`sed -n -e 1,10p -e 20,30p ${F}`, [...span(1, 10), ...span(20, 30)]],
    [`sed -ne '1,200p;100q' ${F}`, span(1, 100)],
    [`sed 40q ${F}`, span(1, 40)],
    [`head ${F}`, span(1, 10)],
    [`head -5 ${F}`, span(1, 5)],
    [`head -n 40 ${F}`, span(1, 40)],
    [`head -n40 ${F}`, span(1, 40)],
    [`head --lines=40 ${F}`, span(1, 40)],
    [`tail ${F}`, span(501, 510)],
    [`tail -n 30 ${F}`, span(481, 510)],
    [`tail -n +500 ${F}`, span(500, 510)],
    [`head -n 300 < ${F}`, span(1, 300)],
    // Pipes through a filter we read: the filter's cut applies to what came before it.
    [`cat ${F} | head -n 50`, span(1, 50)],
    [`nl -ba ${F} | sed -n '100,200p'`, span(100, 200)],
    [`tail -n 100 ${F} | head -n 10`, span(411, 420)],
    [`cat ${F} | less`, span(1, 510)],
    [`cat ${F} 2>/dev/null`, span(1, 510)],
    [`cat ${F} 2>&1 | head -3`, span(1, 3)],
    [`wc -l ${F} && sed -n 1,140p ${F}`, span(1, 140)],
    // Not counted: a form we don't model, a search, a filter we don't know, output that leaves the screen.
    [`grep -n tab ${F}`, null],
    [`awk 'NR<100' ${F}`, null],
    [`sed -n '/^## Voice/,/^## Color/p' ${F}`, null],
    [`sed -i 's/a/b/' ${F}`, null],
    [`head -c 400 ${F}`, null],
    [`head -n -5 ${F}`, null],
    [`less +40 ${F}`, null],
    [`cat ${F} | grep tab`, null],
    [`cat ${F} | wc -l`, null],
    [`cat ${F} > /tmp/copy.md`, null],
    [`x=$(cat ${F})`, null],
    [`ls -la ${F}`, null],
    [`python3 - <<'EOF'\nprint(open('${F}').read())\ncat ${F}\nEOF`, null],
  ];
  for (const [command, expected] of cases) {
    test(command.split("\n")[0]!, () => assert.deepEqual(shown(command), expected));
  }

  test("each file a command prints is its own read", () => {
    assert.deepEqual(shellReads("head -n 3 /a/SKILL.md /b/SKILL.md").map((r) => r.path), ["/a/SKILL.md", "/b/SKILL.md"]);
    // Several files cut as one stream: which lines of each survive isn't modelled, so neither counts.
    assert.deepEqual(shellReads("cat /a/SKILL.md /b/SKILL.md | head -n 3"), []);
  });
});

describe("the read tool", () => {
  const read = (args: { offset?: unknown; limit?: unknown }) => [...linesLoaded([readToolChain(args)], file)].sort((a, b) => a - b);

  test("no bounds is the whole file; offset and limit are 1-based and inclusive", () => {
    assert.deepEqual(read({}), span(1, 510));
    assert.deepEqual(read({ limit: 20 }), span(1, 20));
    assert.deepEqual(read({ offset: 141 }), span(141, 510));
    assert.deepEqual(read({ offset: 100, limit: 50 }), span(100, 149));
    assert.deepEqual(read({ offset: "100", limit: "50" }), span(100, 149));
    assert.deepEqual(read({ offset: 0, limit: 0 }), []);
    assert.deepEqual(read({ offset: 900 }), []);
  });

  test("the tool's own limit cuts a long file: 2000 lines or 50 KB, from the head", () => {
    const long = fileLinesOf("x\n".repeat(2500));
    assert.equal(linesLoaded([readToolChain({})], long).size, 2000);
    const wide = fileLinesOf(`${"y".repeat(1023)}\n`.repeat(60)); // 1 KB a line, newline included
    assert.equal(linesLoaded([readToolChain({})], wide).size, 50);
    // bash keeps the tail of what a command printed.
    assert.deepEqual([...linesLoaded([[BASH_CAP]], wide)].sort((a, b) => a - b), span(11, 60));
  });
});

describe("reads add up", () => {
  // The union is the rule: however reads overlap or repeat, in any order, the count is the lines at least
  // one of them reached, each once.
  const chains: [string, LineChain][] = [
    ["1-140", readToolChain({ limit: 140 })],
    ["100-300", readToolChain({ offset: 100, limit: 201 })],
    ["141-510", readToolChain({ offset: 141 })],
    ["500-510", shellReads(`tail -n 11 ${F}`)[0]!.chain],
    ["1-10", shellReads(`head ${F}`)[0]!.chain],
  ];
  const lines = (name: string) => {
    const [a, b] = name.split("-").map(Number) as [number, number];
    return span(a, b);
  };
  const subsets = (n: number) => Array.from({ length: 2 ** n }, (_, m) => chains.filter((_, i) => m & (1 << i)));

  test("every combination of paged and overlapping reads counts each line once", () => {
    for (const pick of subsets(chains.length)) {
      const expected = new Set(pick.flatMap(([name]) => lines(name)));
      for (const order of [pick, [...pick].reverse(), [...pick, ...pick]]) {
        const got = linesLoaded(order.map(([, c]) => c), file);
        assert.deepEqual([...got].sort((a, b) => a - b), [...expected].sort((a, b) => a - b), order.map(([n]) => n).join(" + "));
      }
    }
  });

  test("a sum instead of a union would be caught", () => {
    // A stand-in broken the way the rule forbids: summing each read's lines overcounts an overlap.
    const sum = (cs: LineChain[]) => cs.reduce((n, c) => n + linesLoaded([c], file).size, 0);
    const pick = [chains[0]![1], chains[1]![1]];
    assert.notEqual(sum(pick), linesLoaded(pick, file).size);
    assert.equal(linesLoaded(pick, file).size, 300);
  });

  test("lines are counted as wc -l counts them", () => {
    assert.equal(fileLinesOf("").count, 0);
    assert.equal(fileLinesOf("a").count, 1);
    assert.equal(fileLinesOf("a\n").count, 1);
    assert.equal(fileLinesOf("a\nb").count, 2);
  });
});
