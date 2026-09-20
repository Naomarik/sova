const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "just now" · "5m ago" · "2h ago" · "yesterday" · "3d ago", then "Mar 4" past 7 days. */
export function relativeTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const sec = Math.max(0, Math.round((now - t) / 1000));
  if (sec < 45) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day === 1) return "yesterday";
  if (day < 7) return `${day}d ago`;
  const d = new Date(t);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${sameYear ? "" : `, ${d.getFullYear()}`}`;
}

/** 24-hour clock for absolute timestamps. */
export function clockTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}


export function prettyJson(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** 24-hour `HH:MM`, prefixed with `Mar 4 ` when not today. */
export function stampTime(iso: string, now = Date.now()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date(now);
  const sameDay = d.toDateString() === today.toDateString();
  return `${sameDay ? "" : `${MONTHS[d.getMonth()]} ${d.getDate()} `}${clockTime(iso)}`;
}

/** Shows $HOME as `~`. */
export function tildePath(p: string, home: string | null): string {
  if (!home) return p;
  if (p === home) return "~";
  return p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

/** $HOME inferred from a session file path (`<home>/.pi/agent/sessions/...`). */
export function homeFromSessionPath(path: string): string | null {
  const i = path.indexOf("/.pi/agent/sessions/");
  return i > 0 ? path.slice(0, i) : null;
}

/** Model id without the provider: "anthropic/claude-opus-5" → "claude-opus-5". */
export function shortModel(model: string | null | undefined): string | null {
  if (!model) return null;
  const i = model.indexOf("/");
  return i >= 0 ? model.slice(i + 1) : model;
}

/** The provider a model ref names: "anthropic/claude-opus-5" → "anthropic"; "" when it has none. */
export function modelProvider(model: string | null | undefined): string {
  if (!model) return "";
  const i = model.indexOf("/");
  return i > 0 ? model.slice(0, i) : "";
}

/**
 * A model id for a meta line, where the width belongs to the numbers beside it: no provider, no
 * dated build, a dotted version, and the context variant spelled out.
 * "anthropic/claude-haiku-4-5-20251001" → "haiku-4.5"; "claude-opus-5[1m]" → "opus-5 1M".
 * Lossy on purpose: the full id belongs in the `title` next to it.
 */
export function compactModel(model: string | null | undefined): string | null {
  const short = shortModel(model);
  if (!short) return null;
  const variant = /\[([^\]]+)\]\s*$/.exec(short)?.[1];
  const id = short
    .replace(/\s*\[[^\]]*\]\s*$/, "")
    .replace(/-20\d{6}(?=$|-)/, "") // dated build
    .replace(/^claude-/, "")
    .replace(/-(\d+)-(\d+)$/, "-$1.$2");
  if (!id) return short;
  return variant ? `${id} ${variant.toUpperCase()}` : id;
}

/** Compact span: "40s" · "42m" · "2h 17m" · "3d 4h". */
export function duration(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return min % 60 ? `${hr}h ${min % 60}m` : `${hr}h`;
  const day = Math.floor(hr / 24);
  return hr % 24 ? `${day}d ${hr % 24}h` : `${day}d`;
}

/** "Mar 4" (year added when it isn't this year's). */
export function shortDate(t: number, now = Date.now()): string {
  const d = new Date(t);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${sameYear ? "" : `, ${d.getFullYear()}`}`;
}

/** 50000 → "50,000". */
export const thousands = (n: number) => n.toLocaleString("en-US");
