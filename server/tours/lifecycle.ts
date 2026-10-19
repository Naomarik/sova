import { stateRoot } from "../state-root";
import { markTourSessionDeleted } from "./deleted";
import { forgetTourOwner } from "./ownership";
import { ensureTourToolRuntime } from "./runtime";
import { deleteTourShares } from "./shares";
import { deleteTourSession } from "./store";

export interface TourDeletionActions {
  barrier(sessionId: string): void;
  revoke(sessionId: string): void;
  /** Resolves or rejects only once matching runner cleanup has actually settled. */
  settle(sessionId: string): Promise<void>;
  removeSource(sessionId: string): void;
  /** The private retry authority survives every incomplete cleanup phase. */
  forgetOwner?(sessionId: string): void;
}
const actions: TourDeletionActions = {
  barrier: id => markTourSessionDeleted(stateRoot(), id),
  revoke: id => deleteTourShares(id),
  settle: id => ensureTourToolRuntime().removeSession(id),
  removeSource: id => deleteTourSession(id),
  forgetOwner: id => forgetTourOwner(id),
};

/** Actual transcript deletion only. Failure of one store never skips cancellation and settlement. */
export async function removeSessionTours(sessionId: string, cleanup: TourDeletionActions = actions): Promise<void> {
  const errors: unknown[] = [];
  try { cleanup.revoke(sessionId); } catch (error) { errors.push(error); }
  try { cleanup.barrier(sessionId); } catch (error) { errors.push(error); }
  // Even a failed authority write must not leave the recording child running.
  try { await cleanup.settle(sessionId); } catch (error) { errors.push(error); }
  try { cleanup.removeSource(sessionId); } catch (error) { errors.push(error); }
  if (!errors.length) {
    try { cleanup.forgetOwner?.(sessionId); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "Deleted chat tour cleanup did not finish completely.");
}
