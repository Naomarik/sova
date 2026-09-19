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
