import { expect, test } from "vitest";
import type { ClaimMarksBridge } from "../shared/desktop-bridge.ts";
import type {
  ClaimMarksView,
  ClaimsView,
  WorkspaceView,
} from "../shared/ipc-contract.ts";
import {
  CLAIM_MARK_MESSAGES,
  type ClaimMarksScreenView,
  followClaimMarks,
  initialClaimMarksView,
  markedWorkspaces,
} from "./claim-marks-view.ts";
import type { ClaimsScreenView } from "./claims-view.ts";
import type { WorkspacePanelView } from "./workspace-view.ts";

const WORKSPACE_A = "0192f0a0-7b3c-7d4e-8f50-0000000000a1";
const WORKSPACE_B = "0192f0a0-7b3c-7d4e-8f50-0000000000a2";
const WORKSPACE_C = "0192f0a0-7b3c-7d4e-8f50-0000000000a3";
const UNLISTED = "0192f0a0-7b3c-7d4e-8f50-0000000000a9";

function workspaces(
  overrides: Partial<WorkspaceView> = {},
): WorkspacePanelView {
  return {
    kind: "known",
    state: {
      revision: 1,
      status: "ready",
      workspaces: [
        { id: WORKSPACE_A, name: "Workspace A" },
        { id: WORKSPACE_B, name: "Workspace B" },
        { id: WORKSPACE_C, name: "Workspace C" },
      ],
      selectedWorkspaceId: WORKSPACE_A,
      projects: [],
      openProjectId: null,
      ...overrides,
    } as WorkspaceView,
  };
}

function marks(...workspaceIds: readonly string[]): ClaimMarksScreenView {
  return { kind: "known", state: { revision: 2, workspaceIds } };
}

function claims(unseen: boolean, workspaceId = WORKSPACE_A): ClaimsScreenView {
  const state: ClaimsView = {
    revision: 3,
    status: "ready",
    workspaceId,
    claims: [
      {
        memberId: "0192f0a0-7b3c-7d4e-8f50-0000000000d1",
        login: "linus",
        verifiedAt: "2026-11-12T09:00:00.000Z",
        accountCreatedAt: "2026-10-01T00:00:00.000Z",
        via: "invitation",
        claimedAt: "2026-11-12T09:30:00.000Z",
        unseen,
      },
    ],
  };
  return { kind: "known", state };
}

const NO_CLAIMS: ClaimsScreenView = { kind: "pending" };

test("the other workspaces that the main process names are marked, and the selected one by its own claims only", () => {
  expect([
    ...markedWorkspaces(marks(WORKSPACE_B), NO_CLAIMS, workspaces()),
  ]).toEqual([WORKSPACE_B]);
  // The selected workspace's mark follows its claims, as the people item's
  // does: named by a state from before a switch, it is not marked.
  expect([
    ...markedWorkspaces(
      marks(WORKSPACE_A, WORKSPACE_C),
      claims(false),
      workspaces(),
    ),
  ]).toEqual([WORKSPACE_C]);
  expect(
    [
      ...markedWorkspaces(marks(WORKSPACE_C), claims(true), workspaces()),
    ].sort(),
  ).toEqual([WORKSPACE_A, WORKSPACE_C]);
  // Claims of another workspace than the selected one mark nothing.
  expect([
    ...markedWorkspaces(marks(), claims(true, WORKSPACE_B), workspaces()),
  ]).toEqual([]);
  // A workspace that the list does not hold is never marked.
  expect([
    ...markedWorkspaces(marks(UNLISTED, WORKSPACE_B), NO_CLAIMS, workspaces()),
  ]).toEqual([WORKSPACE_B]);
});

test("nothing is marked while signed out, before the first state of the workspaces or of the marks, or without the subscription", () => {
  for (const view of [
    workspaces({ status: "signed_out" }),
    { kind: "pending" } as const,
    { kind: "unavailable" } as const,
  ]) {
    expect(markedWorkspaces(marks(WORKSPACE_B), claims(true), view).size).toBe(
      0,
    );
  }
  for (const view of [
    { kind: "pending" } as const,
    { kind: "unavailable" } as const,
  ]) {
    expect([...markedWorkspaces(view, NO_CLAIMS, workspaces())]).toEqual([]);
    // The selected workspace still follows its own claims.
    expect([...markedWorkspaces(view, claims(true), workspaces())]).toEqual([
      WORKSPACE_A,
    ]);
  }
});

test("the marks start pending with the bridge and unavailable without it, and following them reports each state and a refusal, asking for nothing else", () => {
  expect(initialClaimMarksView(true)).toEqual({ kind: "pending" });
  expect(initialClaimMarksView(false)).toEqual({ kind: "unavailable" });
  const views: ClaimMarksScreenView[] = [];
  let deliver: (state: ClaimMarksView) => void = () => undefined;
  let refuse: () => void = () => undefined;
  let ended = 0;
  const bridge: Pick<ClaimMarksBridge, "subscribeState"> = {
    subscribeState: (listener, onError) => {
      deliver = listener;
      refuse = onError ?? (() => undefined);
      return () => {
        ended += 1;
      };
    },
  };
  const stop = followClaimMarks(bridge, (view) => views.push(view));
  deliver({ revision: 1, workspaceIds: [WORKSPACE_B] });
  refuse();
  stop();
  expect(views).toEqual([
    { kind: "known", state: { revision: 1, workspaceIds: [WORKSPACE_B] } },
    { kind: "unavailable" },
  ]);
  expect(ended).toBe(1);
});

test("the accessible name of a marked workspace is its name followed by the fixed words, like the people item's", () => {
  expect(CLAIM_MARK_MESSAGES.workspaceWithNewClaims("Workspace B")).toBe(
    "Workspace B, new claims",
  );
});
