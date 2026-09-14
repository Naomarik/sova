/**
 * extension-toggle
 *
 * `/extensions` — toggle pi extensions on/off without leaving the session.
 *
 * Shows every discovered extension (local global, project-local, and every
 * file inside each installed package) with an on/off toggle. Changes are
 * written straight to the relevant settings.json using the same pattern
 * semantics pi itself applies (`!` excludes, `+` force-includes). On close it
 * offers to run /reload so the new set takes effect.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import * as path from "node:path";
import * as fs from "node:fs";
import { homedir } from "node:os";
import { applyToggle, listExtensions, type ExtResource } from "./logic.ts";

const SELF_NAME = "extension-toggle";

export default function extensionToggle(pi: ExtensionAPI) {
	pi.registerCommand("extensions", {
		description: "Toggle extensions on/off",
		handler: async (_args, ctx) => {
			const agentDir = path.join(homedir(), ".pi", "agent");
			let resources: ExtResource[];
			try {
				resources = listExtensions({
					agentDir,
					cwd: ctx.cwd,
					includeProject: ctx.isProjectTrusted(),
				});
			} catch (err) {
				ctx.ui.notify(`Failed to list extensions: ${err instanceof Error ? err.message : String(err)}`, "error");
				return;
			}

			// mark missing packages (e.g. uninstalled) instead of crashing the list
			if (resources.length === 0) {
				ctx.ui.notify("No extensions found.", "info");
				return;
			}

			resources.sort((a, b) => a.name.localeCompare(b.name));

			if (ctx.mode !== "tui") {
				const lines = resources.map((r) => `${r.enabled ? "on " : "off"}  ${r.name}  (${r.origin})`);
				ctx.ui.notify(`/extensions requires TUI mode. Current set:\n${lines.join("\n")}`, "info");
				return;
			}

			let dirty = false;
			const byId = new Map(resources.map((r) => [r.id, r]));

			await ctx.ui.custom((_tui, theme, _kb, done) => {
				const container = new Container();
				container.addChild(new Text(theme.fg("accent", theme.bold("Extensions — toggle, Esc to close")), 1, 1));

				const items: SettingItem[] = resources.map((r) => ({
					id: r.id,
					label: `${r.name}  ·  ${r.origin}`,
					currentValue: r.enabled ? "on" : "off",
					values: ["on", "off"],
				}));

				const settingsList = new SettingsList(
					items,
					Math.min(items.length + 4, 24),
					getSettingsListTheme(),
					(id, newValue) => {
						const res = byId.get(id);
						if (!res) return;
						const enable = newValue === "on";
						if (enable === res.enabled) return;
						try {
							const changed = applyToggle(res, enable);
							if (changed) {
								res.enabled = enable;
								dirty = true;
								if (res.name === SELF_NAME && !enable) {
									ctx.ui.notify("extension-toggle disabled itself — /extensions disappears after /reload", "warning");
								}
							}
						} catch (err) {
							ctx.ui.notify(`Failed to toggle ${res.name}: ${err instanceof Error ? err.message : String(err)}`, "error");
						}
					},
					() => done(undefined),
					{ enableSearch: true },
				);
				container.addChild(settingsList);

				return {
					render: (w) => container.render(w),
					invalidate: () => container.invalidate(),
					handleInput: (data) => settingsList.handleInput?.(data),
				};
			});

			if (!dirty) return;
			const reload = await ctx.ui.confirm("Apply now?", "Reload pi to load the new extension set? (Otherwise run /reload yourself.)");
			if (reload) {
				await ctx.reload(); // terminal for this handler
				return;
			}
			ctx.ui.notify("Saved. Run /reload to apply.", "info");
		},
	});
}
