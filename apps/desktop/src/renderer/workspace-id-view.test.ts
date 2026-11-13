import { expect, test } from "vitest";
import type { WorkspaceBridge } from "../shared/desktop-bridge.ts";
import type {
  CopyWorkspaceIdResult,
  PeopleView,
  PersonView,
} from "../shared/ipc-contract.ts";
import type { PeopleScreenView } from "./people-view.ts";
import {
  createWorkspaceIdCopy,
  describeWorkspaceId,
  describeWorkspaceIdCopy,
  IDLE_WORKSPACE_ID_COPY,
  WORKSPACE_ID_MESSAGES,
  type WorkspaceIdCopyView,
} from "./workspace-id-view.ts";

const WORKSPACE = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3";
const OTHER_WORKSPACE = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a4";
const OWN = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c1";
const OTHER = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c2";

function person(
  memberId: string,
  overrides: Partial<PersonView> = {},
): PersonView {
  return {
    memberId,
    displayName: "Ada",
    role: "member",
    claimed: true,
    login: "octocat",
    verifiedAt: "2026-11-06T22:30:00.000Z",
    former: false,
    ...overrides,
  };
}

const READY: PeopleView = {
  revision: 4,
  status: "ready",
  workspaceId: WORKSPACE,
  workspaceName: "Team",
  ownMemberId: OWN,
  people: [person(OWN), person(OTHER, { role: "owner" })],
  morePeople: 0,
  ownershipOffer: null,
  maxUnclaimedMembers: null,
};

function known(overrides: Partial<PeopleView> = {}): PeopleScreenView {
  return { kind: "known", state: { ...READY, ...overrides } as PeopleView };
}

test("every active member of the workspace sees its ID, whatever the role", () => {
  for (const role of ["owner", "admin", "member"] as const) {
    expect(
      describeWorkspaceId(
        known({ people: [person(OWN, { role }), person(OTHER)] }),
      ),
      role,
    ).toBe(WORKSPACE);
  }
  expect(describeWorkspaceId(known())).toBe(WORKSPACE);
});

test("no ID shows before the people are ready, without a selection, or without the account's own active person", () => {
  const cases: [string, PeopleScreenView][] = [
    ["unavailable", { kind: "unavailable" }],
    ["pending", { kind: "pending" }],
    ["signed out", known({ status: "signed_out" })],
    ["no workspace", known({ status: "no_workspace" })],
    ["loading", known({ status: "loading" })],
    ["unavailable state", known({ status: "unavailable", problem: "failed" })],
    ["no selection", known({ workspaceId: null })],
    ["no own person", known({ ownMemberId: null })],
    ["own person not listed", known({ people: [person(OTHER)] })],
    [
      "own person former",
      known({ people: [person(OWN, { former: true }), person(OTHER)] }),
    ],
  ];
  for (const [name, view] of cases) {
    expect(describeWorkspaceId(view), name).toBeNull();
  }
});

test("the sentence of the last copy shows only for the ID that it copied, and nothing before the first copy or while one runs", () => {
  const copied: WorkspaceIdCopyView = {
    running: false,
    last: { workspaceId: WORKSPACE, copied: true },
  };
  const notCopied: WorkspaceIdCopyView = {
    running: false,
    last: { workspaceId: WORKSPACE, copied: false },
  };

  expect(describeWorkspaceIdCopy(copied, WORKSPACE)).toBe(
    "The workspace ID was copied.",
  );
  expect(describeWorkspaceIdCopy(notCopied, WORKSPACE)).toBe(
    "The workspace ID could not be copied. Select it and copy it instead.",
  );
  expect(describeWorkspaceIdCopy(IDLE_WORKSPACE_ID_COPY, WORKSPACE)).toBe("");
  expect(
    describeWorkspaceIdCopy({ running: true, last: undefined }, WORKSPACE),
  ).toBe("");
  // After a switch, the sentence never speaks of another workspace's ID.
  expect(describeWorkspaceIdCopy(copied, OTHER_WORKSPACE)).toBe("");
  expect(describeWorkspaceIdCopy(notCopied, null)).toBe("");
  expect(WORKSPACE_ID_MESSAGES).toEqual({
    label: "Workspace ID: ",
    hint: "Someone who is not in this workspace can ask to join it with this ID. The owner or an admin decides.",
    copy: "Copy",
    copied: "The workspace ID was copied.",
    notCopied:
      "The workspace ID could not be copied. Select it and copy it instead.",
  });
  expect(Object.isFrozen(WORKSPACE_ID_MESSAGES)).toBe(true);
});

/** A bridge whose answers the test settles, recording every call. */
function fakeBridge() {
  const calls: unknown[][] = [];
  const answers: {
    resolve: (value: CopyWorkspaceIdResult) => void;
    reject: (error: unknown) => void;
  }[] = [];
  const bridge: Pick<WorkspaceBridge, "copyId"> = {
    copyId: (...args: unknown[]) => {
      calls.push(args);
      return new Promise((resolve, reject) => {
        answers.push({ resolve, reject });
      });
    },
  };
  return { bridge, calls, answers };
}

test("a copy passes exactly the ID to the bridge, empties the sentence at its start, and reports copied for ok", async () => {
  const fake = fakeBridge();
  const views: WorkspaceIdCopyView[] = [];
  const copy = createWorkspaceIdCopy(fake.bridge, (view) => views.push(view));

  const done = copy.copy(WORKSPACE);
  expect(fake.calls).toEqual([[WORKSPACE]]);
  expect(views).toEqual([{ running: true, last: undefined }]);
  fake.answers[0]?.resolve({ outcome: "ok" });
  await done;

  expect(views).toEqual([
    { running: true, last: undefined },
    { running: false, last: { workspaceId: WORKSPACE, copied: true } },
  ]);
});

test("a refusal, a failure, a call that rejects, and a bridge that throws report not copied", async () => {
  const endings: ((
    fake: ReturnType<typeof fakeBridge>,
  ) => Promise<void> | void)[] = [
    (fake) =>
      fake.answers[0]?.resolve({ outcome: "refused", reason: "not_found" }),
    (fake) =>
      fake.answers[0]?.resolve({ outcome: "refused", reason: "invalid" }),
    (fake) => fake.answers[0]?.resolve({ outcome: "failed" }),
    (fake) => fake.answers[0]?.reject(new Error("refused by the contract")),
  ];
  for (const end of endings) {
    const fake = fakeBridge();
    const views: WorkspaceIdCopyView[] = [];
    const copy = createWorkspaceIdCopy(fake.bridge, (view) => views.push(view));
    const done = copy.copy(WORKSPACE);
    await end(fake);
    await done;
    expect(views.at(-1)).toEqual({
      running: false,
      last: { workspaceId: WORKSPACE, copied: false },
    });
  }
  const views: WorkspaceIdCopyView[] = [];
  const throwing = createWorkspaceIdCopy(
    {
      copyId: () => {
        throw new TypeError("no bridge");
      },
    },
    (view) => views.push(view),
  );
  await throwing.copy(WORKSPACE);
  expect(views).toEqual([
    { running: true, last: undefined },
    { running: false, last: { workspaceId: WORKSPACE, copied: false } },
  ]);
});

test("one copy runs at a time: a click while one runs calls nothing, and the next one after it ends goes through", async () => {
  const fake = fakeBridge();
  const views: WorkspaceIdCopyView[] = [];
  const copy = createWorkspaceIdCopy(fake.bridge, (view) => views.push(view));

  const first = copy.copy(WORKSPACE);
  await copy.copy(WORKSPACE);
  await copy.copy(OTHER_WORKSPACE);
  expect(fake.calls).toEqual([[WORKSPACE]]);
  expect(views).toHaveLength(1);
  fake.answers[0]?.resolve({ outcome: "ok" });
  await first;

  const second = copy.copy(OTHER_WORKSPACE);
  expect(fake.calls).toEqual([[WORKSPACE], [OTHER_WORKSPACE]]);
  // The start empties the sentence, so that the same one is announced again.
  expect(views.at(-1)).toEqual({ running: true, last: undefined });
  fake.answers[1]?.resolve({ outcome: "ok" });
  await second;
  expect(views.at(-1)).toEqual({
    running: false,
    last: { workspaceId: OTHER_WORKSPACE, copied: true },
  });
});
