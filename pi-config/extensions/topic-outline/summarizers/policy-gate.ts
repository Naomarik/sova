/**
 * The user's model policy, applied to a summarizer at the moment it is about to run.
 *
 * A summary is a model call like any other, so a backend turned off in pi-web's Settings → Models
 * must not be called. The check cannot live where the chain is built: that happens once per
 * session, and a model turned off ten minutes later would keep being summarized with until the
 * next reload. Wrapping each backend moves the check to the call, where "off" means off from the
 * next summary on — the same "read the file per use" rule the rest of the policy follows
 * (../../model-policy/policy.ts).
 *
 * A denial is raised as a SummarizerError, which is what the chain treats as "try the next
 * backend": the outline survives on whatever is still allowed. Note the chain also counts it as a
 * failure and backs that backend off for a minute or more, so a backend turned back on rejoins at
 * the end of its backoff rather than instantly — a delay in preference, never a wrong call.
 */
import { globallyEnabled, readPolicy } from "../../model-policy/policy.ts";
import { SummarizerError, type Summarizer, type SummarizerSpec } from "../types.ts";

export function policyGated(
	inner: Summarizer,
	spec: Pick<SummarizerSpec, "backend" | "model">,
	/** Test seam; production reads the real policy file. */
	policyFile?: string,
): Summarizer {
	return {
		name: inner.name,
		async summarize(input) {
			if (!globallyEnabled(readPolicy(policyFile), spec.backend, spec.model)) {
				throw new SummarizerError(`${spec.backend}/${spec.model} is turned off in Settings → Models`);
			}
			return inner.summarize(input);
		},
	};
}
