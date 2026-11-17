// The confirmation of a repository link (#286; the Project Manager's
// decision of 2026-11-17). The main process asks the person in a native
// dialog on the main window (`dialog.showMessageBox`, wired in index.ts),
// so that the renderer alone can never link a folder. The dialog names the
// registered repository and the mounted folder. The folder's path is shown
// only by the system's dialog of the main process: nothing of it crosses to
// the renderer.
import {
  PROJECT_REPOSITORY_LIMITS,
  REPOSITORY_LIMITS,
} from "../../shared/ipc-contract.ts";
import { displayText } from "../git-inspector.ts";

/** What the confirmation of a link names. */
export interface LinkConfirmationRequest {
  /** The registered repository's name, from the project's list. */
  readonly name: string;
  /** The mounted repository's top-level folder, as Git reported it. */
  readonly folder: string;
}

/**
 * The native confirmation of a link: a question with the link button first
 * and "Cancel" as the default and the cancel button, so that Enter and
 * Escape link nothing. `linkConfirmed` reads the answer.
 */
export const LINK_CONFIRMATION = Object.freeze({
  type: "question",
  buttons: Object.freeze(["Link", "Cancel"] as const),
  defaultId: 1,
  cancelId: 1,
  noLink: true,
  title: "Link a repository",
  detail:
    "The link is kept on this device for your account only, and the folder's path is never sent to the server. Work that your grants allow on this repository will use this folder while it is mounted. If the folder is replaced, the link stops working until you link it again.",
} as const);

/**
 * The message of the confirmation: the repository's name and the folder,
 * each with the characters that could hide or reorder text replaced.
 */
export function linkConfirmationMessage(
  request: LinkConfirmationRequest,
): string {
  const name = displayText(request.name, PROJECT_REPOSITORY_LIMITS.name);
  const folder = displayText(request.folder, REPOSITORY_LIMITS.path);
  return `Link the repository "${name}" to the folder ${folder}?`;
}

/** Whether the person chose the link button of `LINK_CONFIRMATION`. */
export function linkConfirmed(result: { readonly response: number }): boolean {
  return result.response === 0;
}
