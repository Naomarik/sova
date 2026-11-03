// The test runner's report for SOVA_OUT (scripts/run-tests.mjs), pure so it can be tested alone.

/**
 * A bun run's report for SOVA_OUT from each file's result: one failure per `(fail) <name> [ms]` line,
 * its message the error lines bun printed since the test before it; a file that failed with no such
 * line is an error named by its file. `failingFiles` lists every failing file, uncapped.
 */
export function bunReport(results) {
  const failures = [];
  let errors = 0;
  for (const r of results) {
    const lines = r.out.split("\n");
    let since = 0;
    let named = 0;
    for (let i = 0; i < lines.length; i++) {
      const m = /^\((pass|fail|skip|todo)\) (.*?)(?: \[[\d.]+m?s\])?$/.exec(lines[i]);
      if (!m) continue;
      if (m[1] === "fail") {
        named++;
        const message = lines.slice(since, i).join("\n").trim();
        failures.push({ name: m[2], file: r.file, ...(message ? { message: message.slice(-2000) } : {}) });
      }
      since = i + 1;
    }
    if (r.code !== 0 && !named) {
      errors++;
      failures.push({ name: r.file, file: r.file, message: r.out.trim().slice(-2000) || `exit ${r.code}` });
    }
  }
  const sum = (k) => results.reduce((n, r) => n + r[k], 0);
  // Every failing file, uncapped (failures stops at 50): what a merge run reruns to tell flaky from broken.
  const failingFiles = [...new Set(results.filter((r) => r.code !== 0).map((r) => r.file))];
  return { passed: sum("pass"), failed: sum("fail"), errors, skipped: sum("skip"), failures, failingFiles };
}

