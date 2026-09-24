// child-fakebwrap.mjs — fail-closed probe child. Runs with a PATH whose `bwrap` is a fake that
// exits 1, set BEFORE any backend module is loaded, then: probe, confine, and (only if allowed)
// a real spawn of `touch <victim>`. Prints one JSON line as the last stdout line:
//   { probeOk, probeReason?, confineOk?, confineCode?, spawnExit?, spawnRan }
// The parent asserts the victim file never appears.

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [fakebin, victim, policyJson] = process.argv.slice(2);
if (!fakebin || !victim || !policyJson) {
	console.error("usage: child-fakebwrap.mjs <fakebin> <victim> <policyJson>");
	process.exit(2);
}

const policy = JSON.parse(policyJson);
const report = { probeOk: null, confineOk: null, spawnRan: false };

(async () => {
	const { jiti, run } = await import(pathToFileURL(path.join(path.dirname(new URL(import.meta.url).pathname), "harness.mjs")).href);
	// PATH hijack before any backend import.
	process.env.PATH = `${fakebin}${path.delimiter}${process.env.PATH ?? ""}`;
	const EXT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
	const BE = await jiti.import(path.join(EXT_DIR, "backend.ts"));
	const backend = BE.backendFor("linux");
	try {
		const probe = await backend.probe(policy);
		report.probeOk = probe.ok === true;
		if (probe.ok !== true) report.probeReason = probe.reason;
	} catch (err) {
		report.probeOk = false;
		report.probeThrew = String(err?.message ?? err);
	}
	if (report.probeOk) {
		let res;
		try {
			res = await backend.confine({ argv: ["/bin/bash", "-c", `touch '${victim.replaceAll("'", "'\\''")}'`], cwd: policy.workspaceRoot, policy });
		} catch (err) {
			report.confineOk = false;
			report.confineThrew = String(err?.message ?? err);
		}
		if (res) {
			report.confineOk = res.ok === true;
			if (res.ok !== true) report.confineCode = res.code;
			if (res.ok === true) {
				report.spawnRan = true;
				const out = await run(res.confined.argv, { env: res.confined.env, cwd: policy.workspaceRoot });
				report.spawnExit = out.code;
				report.spawnStderr = out.stderr.slice(-300);
				try { await res.confined.cleanup?.(); } catch {}
			}
		}
	}
	report.victimExists = existsSync(victim);
	console.log(JSON.stringify(report));
})().catch((err) => {
	report.loadError = String(err?.stack ?? err);
	console.log(JSON.stringify(report));
	process.exitCode = 3;
});
