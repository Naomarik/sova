import { AUTH_COOKIE, sovaToken } from "../auth";

/** What the operator's own page shows (server/page-only.ts): the install's cookie. For a test's page-shaped call. */
export const pageHeaders = (): Record<string, string> => ({ cookie: `${AUTH_COOKIE}=${sovaToken()}` });
