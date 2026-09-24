/**
 * Every platform without a backend: refuses at probe and at confine, never passes through.
 * The fail-closed answer for an unsupported OS is a refusal, not a crash and not an unconfined run.
 */
import type { Backend, ConfineRequest, ConfineResult, PlatformContext, PlatformDefaults, Policy, ProbeResult } from "../backend.ts";
import { canonicalizePath } from "../backend.ts";

export class UnsupportedBackend implements Backend {
	readonly id = "unsupported" as const;
	readonly platform: string;

	constructor(platform: string) {
		this.platform = platform;
	}

	private reason(): string {
		return `no sandbox backend for ${this.platform}`;
	}

	async probe(_policy: Policy): Promise<ProbeResult> {
		return { ok: false, reason: this.reason() };
	}

	async confine(_req: ConfineRequest): Promise<ConfineResult> {
		return { ok: false, code: "SANDBOX_UNAVAILABLE", reason: this.reason() };
	}

	async canonicalize(path: string): Promise<string> {
		return canonicalizePath(path);
	}

	platformDefaults(_ctx: PlatformContext): PlatformDefaults {
		return { hidden: [], writable: [], readOnlyWithinWritable: [], shadowed: [] };
	}
}
