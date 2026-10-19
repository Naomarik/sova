/**
 * Every request a guided-tour recorder makes carries this header (§app.access/gate, §app.tours/sites),
 * set on the browser context, so any Sova it reaches refuses it an install's identity: no silent local
 * sign-in, token route, pairing or unlock, no write of any kind and no /ws/chat. Builtins only: the confined child imports it.
 */
export const TOUR_RECORDER_HEADER = "x-sova-tour-recorder";

/** Every Sova answer carries this (auth.ts SERVER_HEADER); a recording that saw it is a tour of a Sova. */
export const SOVA_SERVER_HEADER = "x-sova-server";


/** The refusal for the live install, slot 0, or any Sova that is not a verified managed test copy. */
export const TOUR_SOVA_REFUSAL = "Tours of Sova use a test copy; start one for this branch.";

/** The refusal for a managed Sova copy that could call a model. */
export const TOUR_SOVA_CREDENTIALS_REFUSAL = "This test copy can call a model; remove its auth.json or record a copy without one.";

/** The systemd unit Sova's own server service adopts in slot 0 (.sova/project.json): it names Sova's server. */
export const SOVA_LIVE_UNIT = "sova-runtime.service";
