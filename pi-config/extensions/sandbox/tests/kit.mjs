// Tiny test-runner shared by the red-team suites: PASS/FAIL/SKIP/PENDING lines, a summary, and a
// nonzero process exit on any failure. Standalone scripts, no framework, plain node.

export class AssertError extends Error {}

export function ok(cond, msg = "expected truthy") {
	if (!cond) throw new AssertError(msg);
}
export function eq(actual, expected, msg = "values differ") {
	if (actual !== expected) throw new AssertError(`${msg}: expected ${fmt(expected)}, got ${fmt(actual)}`);
}
export function includes(hay, needle, msg = "substring missing") {
	ok(typeof hay === "string" && hay.includes(needle), `${msg}: expected output to contain ${JSON.stringify(needle)}, got ${fmt(hay)}`);
}
export function notIncludes(hay, needle, msg = "substring forbidden") {
	ok(typeof hay === "string" && !hay.includes(needle), `${msg}: output must not contain ${JSON.stringify(needle)}, got ${fmt(hay)}`);
}
const fmt = (v) => (typeof v === "string" ? JSON.stringify(v.length > 400 ? `${v.slice(0, 400)}…` : v) : String(v));

export function makeSuite(name) {
	const started = Date.now();
	let failures = 0;
	let passes = 0;
	let skips = 0;
	let pendings = 0;
	console.log(`\n### suite ${name}`);
	return {
		async test(caseName, fn) {
			const t0 = Date.now();
			try {
				await fn();
				passes++;
				console.log(`[PASS] ${caseName} (${Date.now() - t0}ms)`);
			} catch (err) {
				failures++;
				console.log(`[FAIL] ${caseName}: ${err?.message ?? err}`);
			}
		},
		skip(caseName, reason) {
			skips++;
			console.log(`[SKIP] ${caseName} — ${reason}`);
		},
		pending(caseName, reason) {
			pendings++;
			console.log(`[PENDING] ${caseName} — ${reason}`);
		},
		/** Expected failure (a known gap). Suite outcome is unchanged either way; the line says which. */
		async xfail(caseName, fn) {
			const t0 = Date.now();
			try {
				await fn();
				console.log(`[XFIXED] ${caseName}: the known gap is CLOSED (${Date.now() - t0}ms)`);
			} catch (err) {
				console.log(`[XFAIL] ${caseName}: known gap still open — ${err?.message ?? err}`);
			}
		},
		done() {
			console.log(
				`### ${name}: ${passes} passed, ${failures} failed, ${skips} skipped, ${pendings} pending (${Date.now() - started}ms)`,
			);
			if (failures > 0) process.exitCode = 1;
			return failures;
		},
	};
}
