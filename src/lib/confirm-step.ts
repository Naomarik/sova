// Two-step inline confirmation for an action that changes the session (a message's own actions,
// components/MessageActions): the first activation arms it, the second runs it. Kept pure so the
// armed state's lifetime — it must never outlive one opening of the menu, and one arming must
// never run twice — is testable without a DOM.

export interface ConfirmStep {
  /** The row shows its confirm copy. */
  armed: boolean;
  /** The caller runs the action now (true at most once per arming). */
  run: boolean;
}

/**
 * What an activation (click, Enter, Space) does. `armed` is the state it finds; the result's
 * `armed` is the state to keep. Disarming BEFORE running means a second activation in the same
 * burst — a double click, or Enter followed by a click — re-arms instead of running twice.
 */
export const confirmActivate = (armed: boolean): ConfirmStep => ({ armed: !armed, run: armed });

/**
 * Every open and close of the menu disarms: an arming left over from a previous opening would
 * make the next single click run the action with no confirmation at all.
 */
export const confirmReset = (): ConfirmStep => ({ armed: false, run: false });
