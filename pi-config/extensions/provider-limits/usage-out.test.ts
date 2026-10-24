import { test } from "node:test";
import assert from "node:assert/strict";
import { isUsageExhausted, usageOut } from "./usage-out.ts";

test("usage-out: what says a provider is out of usage or can't sign in, and what is only a rate limit or a blip", () => {
	const usage: [string, string][] = [
		['429: {"message":"you (alex) have reached your monthly usage limit, add usage credits: …"}', "hit its monthly usage limit"],
		['429: {"message":"you have reached your monthly usage limit, upgrade for higher limits"}', "hit its monthly usage limit"],
		["You have reached your weekly limit", "hit its weekly usage limit"],
		// Claude Code, once the bridge has tried every login (the CLI's own texts, and the bridge's default).
		["You've hit your limit · resets 3pm", "hit its usage limit"],
		["Claude AI usage limit reached|1790003600", "hit its usage limit"],
		["Claude usage limit reached", "hit its usage limit"],
		["429 Usage limit reached for 5 hour. Your limit will reset at 2026-10-24 15:00:00", "hit its usage limit"],
		["429 You exceeded your current quota, please check your plan and billing details", "ran out of credits or quota"],
		['429: {"code":"1113","message":"Insufficient balance or no resource package"}', "ran out of credits or quota"],
		['{"error":{"code":"insufficient_quota"}}', "ran out of credits or quota"],
		["402 Payment Required", "ran out of credits or quota"],
	];
	for (const [text, reason] of usage) {
		assert.deepEqual(usageOut(text), { kind: "usage", reason }, text);
		assert.equal(isUsageExhausted(text), true, text);
	}
	for (const text of ["Not logged in · Please run /login", "Claude sign-in failed", '401: {"error":"invalid api key"}', "403 Forbidden", "OAuth token has expired"]) {
		assert.deepEqual(usageOut(text), { kind: "auth", reason: "can't sign in" }, text);
		assert.equal(isUsageExhausted(text), false, `${text}: a sign-in failure is not a spent quota`);
	}
	for (const text of [undefined, "", '429: {"code":"1302","message":"Rate limit reached for requests"}', "Too many requests", "Connection reset by peer", "500 internal error", "overloaded_error", "used 4010 tokens", "load balancer timeout",
		// A short-window quota is a rate limit, not spent usage.
		"429 RESOURCE_EXHAUSTED: Quota exceeded for metric x, limit: 15 per minute",
		"429 Rate limit: quota of 200000 tokens per minute (TPM) exceeded",
		"429 You exceeded your quota of requests per day: 50 RPM"])
		assert.equal(usageOut(text), undefined, String(text));
});
