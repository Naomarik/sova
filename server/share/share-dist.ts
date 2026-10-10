import { resolve } from "node:path";

/** The share page's own build (vite build --mode share). Never the operator app's dist/. */
export const SHARE_DIST = resolve(import.meta.dirname, "..", "..", "dist-share");

/** Where the share page is served from: SHARE_DIST unless SOVA_SHARE_DIST names another build
    (tests serve a stub page, so they don't depend on this checkout having built it). Read per
    request, by the page shells, the asset route, the gateway's own-build check and the registry
    push's asset list alike, so all of them name the build being served. */
export const shareDist = (): string => process.env.SOVA_SHARE_DIST || SHARE_DIST;
