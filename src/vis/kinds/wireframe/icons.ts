/**
 * `vis wireframe`'s icons: the name a model writes (`icon "back"`, a tab called "Search") → a file in
 * public/icons. A name not here draws a neutral dot, never a letter. The share build bundles every
 * file named here (src/share/vis.tsx; share-markdown.test.ts checks the two agree). Pure.
 */

export const WIREFRAME_ICONS: Readonly<Record<string, string>> = {
  search: "search", find: "search",
  bell: "bell", notifications: "bell", notification: "bell", alerts: "bell", inbox: "bell",
  menu: "menu", hamburger: "menu",
  back: "chevron-left", "←": "chevron-left", "arrow-left": "chevron-left", left: "chevron-left", "chevron-left": "chevron-left",
  forward: "chevron-right", next: "chevron-right", "→": "chevron-right", "chevron-right": "chevron-right", right: "chevron-right",
  down: "chevron-down", expand: "chevron-down", "chevron-down": "chevron-down", caret: "chevron-down",
  close: "close", x: "close", "×": "close", dismiss: "close",
  more: "more", "…": "more", "...": "more", dots: "more", kebab: "more", overflow: "more",
  plus: "plus", add: "plus", new: "plus", "+": "plus", compose: "plus",
  settings: "settings", gear: "settings", cog: "settings", preferences: "settings",
  star: "star", favorite: "star", favourite: "star",
  check: "check", done: "check", tick: "check",
  edit: "pencil", pencil: "pencil", rename: "pencil",
  image: "image", photo: "image", picture: "image", camera: "image",
  filter: "filter", funnel: "filter", sliders: "sliders", sort: "sliders", adjust: "sliders",
  copy: "copy", duplicate: "copy",
  file: "file", document: "file", doc: "file",
  folder: "folder", files: "folder",
  terminal: "terminal", shell: "terminal", console: "terminal",
  chat: "chat", message: "chat", messages: "chat", comment: "chat", comments: "chat",
  clock: "clock", time: "clock", history: "clock", recent: "clock",
  info: "info", help: "info",
  eye: "eye", view: "eye", preview: "eye",
  archive: "archive",
  attach: "attach", attachment: "attach", paperclip: "attach",
  refresh: "refresh", reload: "refresh", sync: "refresh",
  stop: "stop",
  undo: "undo",
  grid: "grid", apps: "grid", dashboard: "grid",
  branch: "branch", git: "branch",
  share: "external", external: "external", open: "external",
  warning: "alert-circle", alert: "alert-circle", attention: "attention",
  error: "x-circle",
  success: "check-circle",
  send: "arrow-right", arrow: "arrow-right", "arrow-right": "arrow-right",
  worker: "worker", agent: "worker", bot: "worker",
  command: "command", palette: "command",
  shield: "shield", security: "shield",
  network: "network",
  gauge: "gauge", usage: "gauge",
  building: "building", organization: "building", company: "building",
  panel: "panel-collapse", sidebar: "panel-collapse", collapse: "panel-collapse", "panel-collapse": "panel-collapse",
  "panel-expand": "panel-expand", "show-sidebar": "panel-expand",
  link: "external", url: "external", "open-in-new": "external",
  reply: "undo",
  pin: "attach",
  cancel: "close",
  home: "home", house: "home",
  trash: "trash", delete: "trash", remove: "trash", bin: "trash",
  minus: "minus", subtract: "minus", "-": "minus", "−": "minus",
  ok: "check", confirm: "check",
  code: "terminal",
  lightning: "gauge", speed: "gauge",
};

/** The icon file for a name, or null (a neutral dot). */
export function wireframeIcon(name: string | undefined): string | null {
  if (!name) return null;
  const n = name.trim().toLowerCase();
  return Object.hasOwn(WIREFRAME_ICONS, n) ? WIREFRAME_ICONS[n]! : null;
}

/** Every file the map names: what the share build must bundle. */
export const WIREFRAME_ICON_FILES: readonly string[] = [...new Set(Object.values(WIREFRAME_ICONS))].sort();
