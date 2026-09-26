// `#/` is the home screen at every width (§app.shell/home): the landing page in the main column.
// A phone (< 768px) shows one column, so its session list needs a route of its own: `#/sessions`.
// At 768px and up the list is always beside the main column, and `#/sessions` shows the same page
// as `#/`, so every "back to the list" link can name it at any width.

export const HOME_HREF = "#/";
export const SESSIONS_HREF = "#/sessions";

export const isSessionsHash = (hash: string): boolean => hash === SESSIONS_HREF || hash === `${SESSIONS_HREF}/`;
