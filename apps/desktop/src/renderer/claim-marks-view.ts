import type { ClaimMarksBridge } from "../shared/desktop-bridge.ts";
import type { ClaimMarksView } from "../shared/ipc-contract.ts";
import { type ClaimsScreenView, hasUnseenClaims } from "./claims-view.ts";
import type { WorkspacePanelView } from "./workspace-view.ts";

// The sidebar's marks of the workspaces that hold a claim that the account
// has not seen (#271; D8 of #95). The main process reads the recent claims
// of the other workspaces where the account is the owner or an admin and
// sends only the IDs of those with an unseen claim (`claims:marks-changed`);
// the selected workspace's mark follows its own claims (`hasUnseenClaims`),
// as the people item's marker does.

/** What the shell knows of the other workspaces' claim marks. */
export type ClaimMarksScreenView =
  /** Outside Electron, or the main process refused the subscription. */
  | { readonly kind: "unavailable" }
  /** Waiting for the first state. */
  | { readonly kind: "pending" }
  | { readonly kind: "known"; readonly state: ClaimMarksView };

export function initialClaimMarksView(
  bridgeAvailable: boolean,
): ClaimMarksScreenView {
  return bridgeAvailable ? { kind: "pending" } : { kind: "unavailable" };
}

/**
 * Subscribes to the claim marks and reports every state as the view; a
 * refused subscription makes the view unavailable. It asks for no load: the
 * main process reads the claims on its own after each answer of the
 * workspace list. Returns the function that ends the subscription.
 */
export function followClaimMarks(
  marks: Pick<ClaimMarksBridge, "subscribeState">,
  onView: (view: ClaimMarksScreenView) => void,
): () => void {
  return marks.subscribeState(
    (state) => onView({ kind: "known", state }),
    () => onView({ kind: "unavailable" }),
  );
}

/** The fixed texts of the workspace marks. */
export const CLAIM_MARK_MESSAGES = Object.freeze({
  /**
   * The accessible name of a workspace in the sidebar's list while it holds
   * a claim that the account has not seen, like "People, new claims".
   */
  workspaceWithNewClaims: (name: string) => `${name}, new claims`,
});

const NO_MARKED_WORKSPACES: ReadonlySet<string> = Object.freeze(
  new Set<string>(),
);

/**
 * The workspaces of the sidebar's list that carry the marker: each other
 * workspace that the main process names, and the selected workspace while
 * its own claims hold an unseen one (`hasUnseenClaims`). The main process
 * never names the selected workspace, and a name of it in a state from
 * before a switch is ignored, so the selected workspace's mark follows its
 * claims alone. Nothing is marked while no device is signed in, before the
 * first state of the workspaces, or for a workspace that the list does not
 * hold.
 */
export function markedWorkspaces(
  marks: ClaimMarksScreenView,
  claims: ClaimsScreenView,
  workspaces: WorkspacePanelView,
): ReadonlySet<string> {
  if (workspaces.kind !== "known" || workspaces.state.status === "signed_out") {
    return NO_MARKED_WORKSPACES;
  }
  const { selectedWorkspaceId } = workspaces.state;
  const listed = new Set(workspaces.state.workspaces.map(({ id }) => id));
  const marked = new Set<string>();
  if (marks.kind === "known") {
    for (const workspaceId of marks.state.workspaceIds) {
      if (workspaceId !== selectedWorkspaceId && listed.has(workspaceId)) {
        marked.add(workspaceId);
      }
    }
  }
  if (selectedWorkspaceId !== null && hasUnseenClaims(claims, workspaces)) {
    marked.add(selectedWorkspaceId);
  }
  return marked;
}
