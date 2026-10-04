/**
 * The words every public link's Delete uses (a hand-off, owner, session share or copy link; a
 * preview's are in previews.ts). A deleted link answers "no longer active" from then on and nothing
 * brings it back, so the button says Delete, a second press confirms "for Good", and a line says so
 * while it waits.
 */

export const DELETE_LINK = "Delete Link";
export const DELETE_FOR_GOOD = "Delete for Good?";
export const DELETING = "Deleting…";
/** A named link's confirm: the person's, or the anyone link's ("This"). */
export const deleteLinkConfirm = (name: string): string => `Delete ${name}'s Link for Good?`;
export const DELETE_THIS_LINK = "Delete This Link for Good?";
export const LINK_GONE = "The link stops working for good.";
export const linkGone = (name: string): string => `${name}'s link stops working for good.`;
export const LINK_DELETED = "Link deleted.";

/** A copy's share link: the copy itself keeps running. */
export const COPY_LINK_GONE = `${LINK_GONE} The copy keeps running.`;
export const copyLinkDeleted = (endpoint: string, copy: string): string => `The ${endpoint} link of ${copy} is deleted.`;

/** A person's links on their page, all at once. */
export const deleteAllLabel = (n: number): string => `Delete All ${n} Links`;
export const deleteAllConfirm = (n: number): string => `Delete All ${n} Links for Good`;
export const deleteAllLine = (name: string, n: number): string => `${name}'s ${n} links stop working for good. Their sessions, messages and visits stay.`;
export const allDeleted = (n: number): string => `Deleted ${n} links.`;

/** The owner link. */
export const DELETE_OWNER_LINK = "Delete Owner Link";
export const DELETE_OWNER_LINK_FOR_GOOD = "Delete Owner Link for Good";
export const OWNER_LINK_DELETED = "Owner link deleted.";

/** Get New Link and its kin: the older link goes for good too. */
export const NEW_LINK_TIP = "Makes a new link and deletes the one you sent before";
export const newLinkFor = (name: string): string => `Makes a new link for ${name} and deletes their older one`;
