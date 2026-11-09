import { expect, test } from "vitest";
import type { PeopleActionsBridge } from "../shared/desktop-bridge.ts";
import {
  PEOPLE_LIMITS,
  PERSON_ACTION_REFUSALS,
  type DefinePersonResult,
  type PeopleView,
  type PersonActionRefusal,
  type PersonActionResult,
  type PersonView,
} from "../shared/ipc-contract.ts";
import { MAX_CLOCK_WAIT_MS } from "./device-view.ts";
import {
  ASKING_ACTIONS,
  clockDelay,
  createPeopleActions,
  describePeopleActionQuestion,
  describePeopleActionResult,
  describePeopleActions,
  describeWait,
  focusesTitleAfterClose,
  IDLE_PEOPLE_ACTIONS,
  isOffered,
  MAX_PERSON_NAME_LENGTH,
  nextPeopleActionsChange,
  PEOPLE_ACTION_DONE_MESSAGES,
  PEOPLE_ACTION_NOT_DONE_MESSAGES,
  PEOPLE_ACTION_UNKNOWN_MESSAGES,
  unclaimedLimitReached,
  watchClockReads,
  type PeopleActionKind,
  type PeopleActionRequest,
  type PeopleActionsView,
} from "./people-actions-view.ts";
import type { PeopleScreenView } from "./people-view.ts";

const WORKSPACE = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3";
const OTHER_WORKSPACE = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a4";
const OWNER = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c1";
const ADMIN = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c2";
const MEMBER = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c3";
const UNCLAIMED = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c4";
const FORMER = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c5";
const SECOND_ADMIN = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c6";

const NOW = Date.parse("2026-11-09T12:00:00.000Z");
const EXPIRES_AT = "2026-11-12T12:00:00.000Z";

function person(
  memberId: string,
  displayName: string,
  overrides: Partial<PersonView> = {},
): PersonView {
  return {
    memberId,
    displayName,
    role: "member",
    claimed: true,
    login: "octocat",
    verifiedAt: "2026-11-06T22:30:00.000Z",
    former: false,
    ...overrides,
  };
}

const PEOPLE: readonly PersonView[] = [
  person(OWNER, "Ada", { role: "owner" }),
  person(ADMIN, "Grace", { role: "admin" }),
  person(SECOND_ADMIN, "Edsger", { role: "admin" }),
  person(MEMBER, "Linus"),
  person(UNCLAIMED, "Margaret", {
    claimed: false,
    login: null,
    verifiedAt: null,
  }),
  person(FORMER, "Alan", { former: true }),
];

const READY: PeopleView = {
  revision: 4,
  status: "ready",
  workspaceId: WORKSPACE,
  workspaceName: "Team",
  ownMemberId: OWNER,
  people: PEOPLE,
  morePeople: 0,
  ownershipOffer: null,
  maxUnclaimedMembers: 50,
};

function state(overrides: Partial<PeopleView> = {}): PeopleView {
  return { ...READY, ...overrides } as PeopleView;
}

function known(overrides: Partial<PeopleView> = {}): PeopleScreenView {
  return { kind: "known", state: state(overrides) };
}

/** The kinds of the actions on each person, by display name. */
function kindsByName(view: PeopleScreenView, now = NOW) {
  const model = describePeopleActions(view, now);
  const names = new Map(
    PEOPLE.map((entry) => [entry.memberId, entry.displayName]),
  );
  return Object.fromEntries(
    [...model.personActions].map(([memberId, requests]) => [
      names.get(memberId),
      requests.map((request) => request.kind),
    ]),
  );
}

test("the longest name matches the contract's", () => {
  expect(MAX_PERSON_NAME_LENGTH).toBe(PEOPLE_LIMITS.displayName);
});

test("the owner defines people, renames and removes unclaimed ones, removes any other claimed person, promotes members, demotes admins, offers the ownership, and cannot leave", () => {
  const model = describePeopleActions(known(), NOW);
  expect(kindsByName(known())).toEqual({
    Grace: ["demote", "offer", "remove"],
    Edsger: ["demote", "offer", "remove"],
    Linus: ["promote", "offer", "remove"],
    Margaret: ["rename", "remove"],
  });
  expect(model.defineIn).toBe(WORKSPACE);
  expect(model.leave).toBeNull();
  expect(model.offer).toBeNull();
  // Each request names the workspace that the screen showed and the person.
  expect(model.personActions.get(UNCLAIMED)).toEqual([
    {
      kind: "rename",
      workspaceId: WORKSPACE,
      memberId: UNCLAIMED,
      name: "Margaret",
    },
    {
      kind: "remove",
      workspaceId: WORKSPACE,
      memberId: UNCLAIMED,
      name: "Margaret",
      claimed: false,
    },
  ]);
});

test("an admin defines people, renames and removes unclaimed ones, removes claimed members only, and may leave", () => {
  const view = known({ ownMemberId: ADMIN });
  const model = describePeopleActions(view, NOW);
  expect(kindsByName(view)).toEqual({
    Linus: ["remove"],
    Margaret: ["rename", "remove"],
  });
  expect(model.defineIn).toBe(WORKSPACE);
  expect(model.leave).toEqual({
    kind: "leave",
    workspaceId: WORKSPACE,
    workspaceName: "Team",
  });
});

test("a member has no action on people, defines nobody, and may leave", () => {
  const model = describePeopleActions(known({ ownMemberId: MEMBER }), NOW);
  expect(model.personActions.size).toBe(0);
  expect(model.defineIn).toBeNull();
  expect(model.leave?.kind).toBe("leave");
});

test("nothing is offered before the people are ready, without a workspace, or without the own active person", () => {
  const none = {
    defineIn: null,
    personActions: new Map(),
    offer: null,
    leave: null,
  };
  const views: PeopleScreenView[] = [
    { kind: "unavailable" },
    { kind: "pending" },
    known({ status: "loading" }),
    known({ status: "signed_out" }),
    known({ status: "no_workspace", workspaceId: null }),
    known({ status: "unavailable", problem: "failed" } as Partial<PeopleView>),
    known({ workspaceId: null }),
    known({ ownMemberId: null }),
    // A former member's person is not the account's active one.
    known({ ownMemberId: FORMER }),
  ];
  for (const view of views) {
    expect(describePeopleActions(view, NOW), JSON.stringify(view)).toEqual(
      none,
    );
  }
});

test("the owner sees a live offer with its target and its withdrawal, and offers it to nobody else meanwhile", () => {
  const offered = {
    ownershipOffer: { memberId: MEMBER, expiresAt: EXPIRES_AT },
  };
  const model = describePeopleActions(known(offered), NOW);
  expect(model.offer).toEqual({
    kind: "made",
    targetName: "Linus",
    expiresAt: EXPIRES_AT,
    withdraw: {
      kind: "withdraw",
      workspaceId: WORKSPACE,
      workspaceName: "Team",
    },
  });
  expect(kindsByName(known(offered))).toEqual({
    Grace: ["demote", "remove"],
    Edsger: ["demote", "remove"],
    Linus: ["promote", "remove"],
    Margaret: ["rename", "remove"],
  });
  // A target that the screen does not list has no name.
  expect(
    describePeopleActions(
      known({
        ownershipOffer: {
          memberId: "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c9",
          expiresAt: EXPIRES_AT,
        },
      }),
      NOW,
    ).offer,
  ).toMatchObject({ kind: "made", targetName: null });
});

test("only the offer's target may accept it, and only before it expires", () => {
  const offered = {
    ownershipOffer: { memberId: MEMBER, expiresAt: EXPIRES_AT },
  };
  expect(
    describePeopleActions(known({ ...offered, ownMemberId: MEMBER }), NOW)
      .offer,
  ).toEqual({
    kind: "received",
    expiresAt: EXPIRES_AT,
    accept: { kind: "accept", workspaceId: WORKSPACE, workspaceName: "Team" },
  });
  // Another admin or member sees no offer, even if the view held one.
  for (const own of [ADMIN, UNCLAIMED]) {
    expect(
      describePeopleActions(known({ ...offered, ownMemberId: own }), NOW).offer,
    ).toBeNull();
  }
  // At its end, and after it, neither the target nor the owner sees it, and
  // the owner may offer again.
  const end = Date.parse(EXPIRES_AT);
  for (const now of [end, end + 1]) {
    expect(
      describePeopleActions(known({ ...offered, ownMemberId: MEMBER }), now)
        .offer,
    ).toBeNull();
    expect(describePeopleActions(known(offered), now).offer).toBeNull();
    expect(kindsByName(known(offered), now)["Linus"]).toContain("offer");
  }
  expect(
    describePeopleActions(
      known({
        ownMemberId: MEMBER,
        ownershipOffer: { memberId: MEMBER, expiresAt: "not a time" },
      }),
      NOW,
    ).offer,
  ).toBeNull();
});

test("the clock reads again at the end of the live offer only", () => {
  const offered = known({
    ownershipOffer: { memberId: MEMBER, expiresAt: EXPIRES_AT },
  });
  expect(nextPeopleActionsChange(offered, NOW)).toBe(Date.parse(EXPIRES_AT));
  expect(
    nextPeopleActionsChange(offered, Date.parse(EXPIRES_AT)),
  ).toBeUndefined();
  expect(nextPeopleActionsChange(known(), NOW)).toBeUndefined();
  expect(nextPeopleActionsChange({ kind: "pending" }, NOW)).toBeUndefined();
});

test("a request is offered while the screen offers the same action on the same person in the same workspace", () => {
  const model = describePeopleActions(known(), NOW);
  const remove: PeopleActionRequest = {
    kind: "remove",
    workspaceId: WORKSPACE,
    memberId: MEMBER,
    name: "Linus",
    claimed: true,
  };
  expect(isOffered(model, remove)).toBe(true);
  expect(isOffered(model, { ...remove, workspaceId: OTHER_WORKSPACE })).toBe(
    false,
  );
  expect(isOffered(model, { ...remove, memberId: FORMER })).toBe(false);
  // The same person with another claim or name is another question.
  expect(isOffered(model, { ...remove, claimed: false })).toBe(false);
  expect(isOffered(model, { ...remove, name: "Linus T." })).toBe(false);
  expect(
    isOffered(model, {
      kind: "rename",
      workspaceId: WORKSPACE,
      memberId: MEMBER,
      name: "Linus",
    }),
  ).toBe(false);
  // The person went away.
  expect(
    isOffered(
      describePeopleActions(
        known({ people: PEOPLE.filter((entry) => entry.memberId !== MEMBER) }),
        NOW,
      ),
      remove,
    ),
  ).toBe(false);

  const workspace = { workspaceId: WORKSPACE, workspaceName: "Team" };
  const offered = {
    ownershipOffer: { memberId: MEMBER, expiresAt: EXPIRES_AT },
  };
  const accept: PeopleActionRequest = { kind: "accept", ...workspace };
  const target = known({ ...offered, ownMemberId: MEMBER });
  expect(isOffered(describePeopleActions(target, NOW), accept)).toBe(true);
  expect(
    isOffered(describePeopleActions(target, Date.parse(EXPIRES_AT)), accept),
  ).toBe(false);
  expect(
    isOffered(describePeopleActions(known(offered), NOW), {
      kind: "withdraw",
      ...workspace,
    }),
  ).toBe(true);
  expect(isOffered(model, { kind: "withdraw", ...workspace })).toBe(false);
  expect(isOffered(model, { kind: "leave", ...workspace })).toBe(false);
  expect(
    isOffered(describePeopleActions(known({ ownMemberId: MEMBER }), NOW), {
      kind: "leave",
      ...workspace,
    }),
  ).toBe(true);
});

const ALL_KINDS: readonly PeopleActionKind[] = [
  "define",
  "rename",
  "remove",
  "promote",
  "demote",
  "offer",
  "withdraw",
  "accept",
  "leave",
];

test("every destructive action, every role change except a promotion, and a rename ask first; a promotion, a withdrawal, and a definition do not", () => {
  expect([...ASKING_ACTIONS].sort()).toEqual([
    "accept",
    "demote",
    "leave",
    "offer",
    "remove",
    "rename",
  ]);
  const workspace = { workspaceId: WORKSPACE, workspaceName: "<b>Team</b>" };
  const target = {
    workspaceId: WORKSPACE,
    memberId: MEMBER,
    name: "<i>Linus</i>",
  };
  expect(
    describePeopleActionQuestion({ kind: "remove", ...target, claimed: true }),
  ).toEqual({
    title: "Remove this person?",
    text: "They lose access to the workspace at once. Their agents in its projects are disabled, the permissions on them are revoked, their unfinished runs are cancelled, and the invitations that they created and that are still open are revoked. Their messages stay, and they are listed as a former member. To come back, they need a new invitation or join request.",
    confirm: "Remove",
    name: "<i>Linus</i>",
  });
  expect(
    describePeopleActionQuestion({ kind: "remove", ...target, claimed: false }),
  ).toMatchObject({
    title: "Remove this unclaimed person?",
    confirm: "Remove",
  });
  expect(
    describePeopleActionQuestion({ kind: "demote", ...target }),
  ).toMatchObject({
    title: "Make this admin a member?",
    confirm: "Make member",
    name: "<i>Linus</i>",
  });
  expect(
    describePeopleActionQuestion({ kind: "offer", ...target }),
  ).toMatchObject({
    title: "Offer the ownership to this person?",
    confirm: "Offer ownership",
  });
  expect(
    describePeopleActionQuestion({ kind: "rename", ...target }),
  ).toMatchObject({
    title: "Rename this person",
    confirm: "Save",
  });
  expect(
    describePeopleActionQuestion({ kind: "leave", ...workspace }),
  ).toMatchObject({
    title: "Leave this workspace?",
    text: "You lose access to the workspace and its projects at once. Your agents in its projects are disabled, the permissions on them are revoked, your unfinished runs are cancelled, and the invitations that you created and that are still open are revoked. To come back, you need a new invitation or join request.",
    confirm: "Leave",
    name: "<b>Team</b>",
  });
  expect(
    describePeopleActionQuestion({ kind: "accept", ...workspace }),
  ).toMatchObject({
    title: "Accept the ownership of this workspace?",
    confirm: "Accept the ownership",
    name: "<b>Team</b>",
  });
  expect(
    describePeopleActionQuestion({ kind: "promote", ...target }),
  ).toBeUndefined();
  expect(
    describePeopleActionQuestion({ kind: "withdraw", ...workspace }),
  ).toBeUndefined();
});

test("a confirmed action and an unknown answer have a fixed sentence for each action, and an unknown one says to check and that nothing is sent again", () => {
  const done = ALL_KINDS.map((kind) =>
    describePeopleActionResult(kind, { outcome: "ok" }, READY),
  );
  expect(done).toEqual(
    ALL_KINDS.map((kind) => PEOPLE_ACTION_DONE_MESSAGES[kind]),
  );
  expect(new Set(done).size).toBe(ALL_KINDS.length);
  expect(
    describePeopleActionResult(
      "define",
      { outcome: "ok", memberId: MEMBER },
      READY,
    ),
  ).toBe("The person was added.");
  const unknown = ALL_KINDS.map((kind) =>
    describePeopleActionResult(kind, { outcome: "unknown" }, READY),
  );
  expect(unknown).toEqual(
    ALL_KINDS.map((kind) => PEOPLE_ACTION_UNKNOWN_MESSAGES[kind]),
  );
  expect(new Set(unknown).size).toBe(ALL_KINDS.length);
  for (const text of unknown) {
    expect(text).toMatch(/^It is not known whether /);
    expect(text).toContain("Check ");
    expect(text).toContain("the request is not sent again on its own.");
  }
  expect(PEOPLE_ACTION_UNKNOWN_MESSAGES.leave).toContain(
    "Check the list of workspaces",
  );
});

function refused(
  reason: PersonActionRefusal,
  retryAfterMs: number | null = null,
): PersonActionResult {
  return { outcome: "refused", reason, retryAfterMs };
}

test("each refusal has its own fixed text after the action's start, and the waits say how long", () => {
  const texts: Record<PersonActionRefusal, string> = {
    invalid: "The request was not valid.",
    not_selected:
      "Another workspace was selected before it was sent. Check the list, then try again.",
    not_signed_in:
      "This device is not signed in, or the server did not accept its sign-in.",
    unavailable:
      "This device cannot send it now. Wait until the sign-in or the current change of the account is finished, then try again.",
    too_soon:
      "This device sent many changes in a short time. Try again in 30 seconds.",
    rate_limited: "The server asked to wait. Try again in 2 minutes.",
    not_allowed: "Your role in this workspace does not allow it.",
    not_found:
      "The server does not know this workspace or this person for your account. Check the list.",
    conflict:
      "The person or the ownership offer has changed in the meantime. Check the list.",
    device_too_new:
      "Promoting an admin and offering the ownership need a device that was registered at least 72 hours ago. Use an older device, or try again later.",
    failed: "The server refused it.",
  };
  expect(Object.keys(texts).sort()).toEqual([...PERSON_ACTION_REFUSALS].sort());
  expect(new Set(Object.values(texts)).size).toBe(
    PERSON_ACTION_REFUSALS.length,
  );
  const waits: Partial<Record<PersonActionRefusal, number>> = {
    too_soon: 30_000,
    rate_limited: 120_000,
  };
  for (const kind of ALL_KINDS.filter((entry) => entry !== "define")) {
    for (const reason of PERSON_ACTION_REFUSALS) {
      const text =
        reason === "invalid" && kind === "rename"
          ? "The name is not allowed. Use visible characters, without line breaks."
          : texts[reason];
      expect(
        describePeopleActionResult(
          kind,
          refused(reason, waits[reason] ?? null),
          READY,
        ),
        `${kind} ${reason}`,
      ).toBe(`${PEOPLE_ACTION_NOT_DONE_MESSAGES[kind]} ${text}`);
    }
  }
  expect(describePeopleActionResult("define", refused("invalid"), READY)).toBe(
    "The person could not be added. The name is not allowed. Use visible characters, without line breaks.",
  );
  expect(new Set(Object.values(PEOPLE_ACTION_NOT_DONE_MESSAGES)).size).toBe(
    ALL_KINDS.length,
  );
});

test("a wait is said in seconds, minutes, or hours, rounded up", () => {
  expect(describeWait(1)).toBe("1 second");
  expect(describeWait(1_000)).toBe("1 second");
  expect(describeWait(1_001)).toBe("2 seconds");
  expect(describeWait(59_000)).toBe("59 seconds");
  expect(describeWait(59_001)).toBe("1 minute");
  expect(describeWait(60_000)).toBe("1 minute");
  expect(describeWait(61_000)).toBe("2 minutes");
  expect(describeWait(3_600_000)).toBe("1 hour");
  expect(describeWait(3_600_001)).toBe("2 hours");
});

test("a definition's rate limit names the unclaimed limit only when the people show it reached", () => {
  const limited = refused("rate_limited", 60_000);
  const general =
    "The person could not be added. The server asked to wait. Try again in 1 minute.";
  // One unclaimed person.
  expect(
    describePeopleActionResult(
      "define",
      limited,
      state({ maxUnclaimedMembers: 1 }),
    ),
  ).toBe(
    "The person could not be added. The workspace already has as many unclaimed people as it allows (1). Remove one, or wait until someone claims one, then try again.",
  );
  for (const people of [
    state({ maxUnclaimedMembers: 2 }),
    state({ maxUnclaimedMembers: null }),
    undefined,
  ]) {
    expect(describePeopleActionResult("define", limited, people)).toBe(general);
  }
  // A former unclaimed person does not count.
  const formerUnclaimed = state({
    maxUnclaimedMembers: 1,
    people: PEOPLE.map((entry) =>
      entry.memberId === UNCLAIMED ? { ...entry, former: true } : entry,
    ),
  });
  expect(unclaimedLimitReached(formerUnclaimed)).toBe(false);
  expect(describePeopleActionResult("define", limited, formerUnclaimed)).toBe(
    general,
  );
  // Only a definition: another action's rate limit is always a wait.
  expect(
    describePeopleActionResult(
      "rename",
      limited,
      state({ maxUnclaimedMembers: 1 }),
    ),
  ).toBe(
    "The name could not be changed. The server asked to wait. Try again in 1 minute.",
  );
});

// The controller.

interface Call {
  readonly name: string;
  readonly args: readonly string[];
}

/** A fake bridge that records each call and answers with `answer`. */
function fakeBridge(
  answer: () => Promise<PersonActionResult | DefinePersonResult>,
): { readonly bridge: PeopleActionsBridge; readonly calls: Call[] } {
  const calls: Call[] = [];
  const record =
    (name: string) =>
    (...args: string[]) => {
      calls.push({ name, args });
      return answer();
    };
  const bridge = {
    define: record("define"),
    rename: record("rename"),
    remove: record("remove"),
    promote: record("promote"),
    demote: record("demote"),
    leave: record("leave"),
    offerOwnership: record("offerOwnership"),
    withdrawOwnershipOffer: record("withdrawOwnershipOffer"),
    acceptOwnershipOffer: record("acceptOwnershipOffer"),
  } as unknown as PeopleActionsBridge;
  return { bridge, calls };
}

/**
 * A controller over a fake bridge that has seen `first`, the owner's ready
 * people by default, as the screen shows them before any click.
 */
function controllerWith(
  answer: () => Promise<PersonActionResult | DefinePersonResult>,
  first: PeopleScreenView = known(),
) {
  const { bridge, calls } = fakeBridge(answer);
  const views: PeopleActionsView[] = [];
  const actions = createPeopleActions(bridge, (view) => views.push(view));
  actions.listChanged(first, NOW);
  const last = () => views.at(-1) ?? IDLE_PEOPLE_ACTIONS;
  return { actions, calls, views, last };
}

/** An answer that waits until the test resolves it. */
function pending() {
  const answers: ((result: PersonActionResult | DefinePersonResult) => void)[] =
    [];
  const answer = () =>
    new Promise<PersonActionResult | DefinePersonResult>((done) => {
      answers.push(done);
    });
  const resolve = (result: PersonActionResult | DefinePersonResult) =>
    answers.shift()?.(result);
  return { answer, resolve };
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await Promise.resolve();
  }
}

const TARGET = { workspaceId: WORKSPACE, memberId: MEMBER, name: "Linus" };
const IN_WORKSPACE = { workspaceId: WORKSPACE, workspaceName: "Team" };

test("an action that asks first opens its question and sends nothing until it is confirmed, once, with its arguments", async () => {
  const requests: [PeopleActionRequest, string, string[]][] = [
    [
      { kind: "remove", ...TARGET, claimed: true },
      "remove",
      [WORKSPACE, MEMBER],
    ],
    [{ kind: "demote", ...TARGET }, "demote", [WORKSPACE, MEMBER]],
    [{ kind: "offer", ...TARGET }, "offerOwnership", [WORKSPACE, MEMBER]],
    [{ kind: "accept", ...IN_WORKSPACE }, "acceptOwnershipOffer", [WORKSPACE]],
    [{ kind: "leave", ...IN_WORKSPACE }, "leave", [WORKSPACE]],
    [{ kind: "rename", ...TARGET }, "rename", [WORKSPACE, MEMBER, "Linus"]],
  ];
  for (const [request, name, args] of requests) {
    const { actions, calls, last } = controllerWith(() =>
      Promise.resolve({ outcome: "ok" }),
    );
    await expect(actions.start(request)).resolves.toBe(false);
    expect(calls, request.kind).toEqual([]);
    expect(last().dialog?.request).toBe(request);
    const done = await actions.confirm();
    expect(calls, request.kind).toEqual([{ name, args }]);
    expect(last()).toEqual({
      running: false,
      message: PEOPLE_ACTION_DONE_MESSAGES[request.kind],
      dialog: undefined,
      defineDraft: "",
      defineProblem: undefined,
    });
    // The control leaves the page with the next people, except a rename's.
    expect(done, request.kind).toBe(request.kind !== "rename");
    // The question is closed: a second confirm sends nothing.
    await expect(actions.confirm()).resolves.toBe(false);
    expect(calls).toHaveLength(1);
  }
});

test("a cancelled question sends nothing", async () => {
  const { actions, calls, last } = controllerWith(() =>
    Promise.resolve({ outcome: "ok" }),
  );
  await actions.start({ kind: "remove", ...TARGET, claimed: true });
  actions.cancel();
  expect(last().dialog).toBeUndefined();
  await expect(actions.confirm()).resolves.toBe(false);
  expect(calls).toEqual([]);
  expect(last().message).toBeUndefined();
});

test("a promotion and a withdrawal run at once", async () => {
  const { actions, calls, last } = controllerWith(() =>
    Promise.resolve({ outcome: "ok" }),
  );
  await expect(actions.start({ kind: "promote", ...TARGET })).resolves.toBe(
    true,
  );
  await expect(
    actions.start({ kind: "withdraw", ...IN_WORKSPACE }),
  ).resolves.toBe(true);
  expect(calls).toEqual([
    { name: "promote", args: [WORKSPACE, MEMBER] },
    { name: "withdrawOwnershipOffer", args: [WORKSPACE] },
  ]);
  expect(last().message).toBe("The ownership offer was withdrawn.");
});

test("one action runs at a time: while one runs, nothing else starts, confirms, or defines", async () => {
  let resolve: (result: PersonActionResult) => void = () => undefined;
  const { actions, calls, last } = controllerWith(
    () =>
      new Promise<PersonActionResult>((done) => {
        resolve = done;
      }),
  );
  const first = actions.start({ kind: "promote", ...TARGET });
  expect(last()).toMatchObject({ running: true, message: undefined });

  const second = actions.start({ kind: "promote", ...TARGET });
  // Nothing was sent for the second one.
  expect(calls).toHaveLength(1);
  await expect(second).resolves.toBe(false);
  await expect(
    actions.start({ kind: "remove", ...TARGET, claimed: true }),
  ).resolves.toBe(false);
  expect(last().dialog).toBeUndefined();
  actions.editDefineDraft("Grace");
  await expect(actions.define(WORKSPACE)).resolves.toBe(false);
  await expect(actions.confirm()).resolves.toBe(false);
  expect(calls).toHaveLength(1);

  resolve({ outcome: "ok" });
  await expect(first).resolves.toBe(true);
  expect(last()).toMatchObject({
    running: false,
    message: "The person is now an admin.",
  });
});

test("an unknown answer says so, asks to check the list, and is never sent again", async () => {
  for (const request of [
    { kind: "promote", ...TARGET },
    { kind: "remove", ...TARGET, claimed: true },
  ] as const) {
    const { actions, calls, last } = controllerWith(() =>
      Promise.resolve({ outcome: "unknown" }),
    );
    await actions.start(request);
    const done = await actions.confirm();
    await settle();
    expect(done).toBe(false);
    expect(calls).toHaveLength(1);
    expect(last()).toEqual({
      running: false,
      message: PEOPLE_ACTION_UNKNOWN_MESSAGES[request.kind],
      dialog: undefined,
      defineDraft: "",
      defineProblem: undefined,
    });
  }
  const { actions, calls, last } = controllerWith(() =>
    Promise.resolve({ outcome: "unknown" }),
  );
  actions.editDefineDraft("Grace");
  await actions.define(WORKSPACE);
  await settle();
  expect(calls).toHaveLength(1);
  expect(last().message).toBe(PEOPLE_ACTION_UNKNOWN_MESSAGES.define);
  // The field keeps the name, so that nothing is added twice by mistake
  // without the person's own click.
  expect(last().defineDraft).toBe("Grace");
});

test("a call that fails on its way says that nothing was sent", async () => {
  const { actions, calls, last } = controllerWith(() =>
    Promise.reject(new Error("refused by the contract")),
  );
  await expect(actions.start({ kind: "promote", ...TARGET })).resolves.toBe(
    false,
  );
  expect(calls).toHaveLength(1);
  expect(last()).toMatchObject({
    running: false,
    message:
      "The person could not be made an admin. It was not sent. Try again.",
  });
});

test("a refusal's sentence uses the latest people for the unclaimed limit", async () => {
  const { actions, last } = controllerWith(() =>
    Promise.resolve(refused("rate_limited", 5_000)),
  );
  actions.listChanged(known({ maxUnclaimedMembers: 1 }), NOW);
  actions.editDefineDraft("Grace");
  await actions.define(WORKSPACE);
  expect(last().message).toContain("as many unclaimed people as it allows (1)");
  actions.listChanged(known({ maxUnclaimedMembers: 3 }), NOW);
  await actions.define(WORKSPACE);
  expect(last().message).toBe(
    "The person could not be added. The server asked to wait. Try again in 5 seconds.",
  );
});

test("a definition sends the trimmed name, empties the field once confirmed, and checks the name first, with the problem apart from the results", async () => {
  const { actions, calls, last } = controllerWith(() =>
    Promise.resolve({ outcome: "ok", memberId: UNCLAIMED }),
  );
  for (const [draft, problem] of [
    ["", "Enter a name."],
    ["   ", "Enter a name."],
    [
      "x".repeat(MAX_PERSON_NAME_LENGTH + 1),
      "A name has at most 64 characters.",
    ],
  ] as const) {
    actions.editDefineDraft(draft);
    await actions.define(WORKSPACE);
    expect(last()).toMatchObject({
      running: false,
      message: undefined,
      defineDraft: draft,
      defineProblem: problem,
    });
  }
  expect(calls).toEqual([]);

  actions.editDefineDraft(`  ${"x".repeat(MAX_PERSON_NAME_LENGTH)}  `);
  await actions.define(WORKSPACE);
  expect(calls).toEqual([
    { name: "define", args: [WORKSPACE, "x".repeat(MAX_PERSON_NAME_LENGTH)] },
  ]);
  expect(last()).toMatchObject({
    message: "The person was added.",
    defineDraft: "",
    defineProblem: undefined,
  });
});

// 32 characters outside the Basic Multilingual Plane are 64 UTF-16 code
// units: the most that the contract and the protocol's zod `.max` allow.
const WIDE_NAME = "\u{1F600}".repeat(32);

test("a name is counted in UTF-16 code units, as the contract and the protocol count it", async () => {
  expect(WIDE_NAME).toHaveLength(MAX_PERSON_NAME_LENGTH);
  const { actions, calls, last } = controllerWith(() =>
    Promise.resolve({ outcome: "ok", memberId: UNCLAIMED }),
  );
  actions.editDefineDraft(`${WIDE_NAME}a`);
  await actions.define(WORKSPACE);
  expect(calls).toEqual([]);
  expect(last().defineProblem).toBe("A name has at most 64 characters.");
  actions.editDefineDraft(WIDE_NAME);
  await actions.define(WORKSPACE);
  expect(calls).toEqual([{ name: "define", args: [WORKSPACE, WIDE_NAME] }]);

  calls.length = 0;
  await actions.start({
    kind: "rename",
    workspaceId: WORKSPACE,
    memberId: UNCLAIMED,
    name: "Margaret",
  });
  actions.editDialogDraft(`${WIDE_NAME}a`);
  await actions.confirm();
  expect(calls).toEqual([]);
  expect(last().dialog?.problem).toBe("A name has at most 64 characters.");
  actions.editDialogDraft(WIDE_NAME);
  await actions.confirm();
  expect(calls).toEqual([
    { name: "rename", args: [WORKSPACE, UNCLAIMED, WIDE_NAME] },
  ]);
});

test("a refused definition keeps the name in the field", async () => {
  const { actions, last } = controllerWith(() =>
    Promise.resolve(refused("not_allowed")),
  );
  actions.editDefineDraft("Grace");
  await actions.define(WORKSPACE);
  expect(last()).toMatchObject({
    message:
      "The person could not be added. Your role in this workspace does not allow it.",
    defineDraft: "Grace",
  });
});

test("a rename starts with the current name, keeps its question open with a problem, and sends the trimmed name", async () => {
  const { actions, calls, last } = controllerWith(() =>
    Promise.resolve({ outcome: "ok" }),
  );
  await actions.start({ kind: "rename", ...TARGET });
  expect(last().dialog).toMatchObject({ draft: "Linus", problem: undefined });
  for (const [draft, problem] of [
    [" ", "Enter a name."],
    [
      "y".repeat(MAX_PERSON_NAME_LENGTH + 1),
      "A name has at most 64 characters.",
    ],
  ] as const) {
    actions.editDialogDraft(draft);
    await expect(actions.confirm()).resolves.toBe(false);
    expect(last().dialog).toMatchObject({ draft, problem });
  }
  expect(calls).toEqual([]);
  actions.editDialogDraft(" Linus T. ");
  await actions.confirm();
  expect(calls).toEqual([
    { name: "rename", args: [WORKSPACE, MEMBER, "Linus T."] },
  ]);
  expect(last().dialog).toBeUndefined();
});

test("another selected workspace closes the question, empties the field, and drops the sentence", async () => {
  const { actions, last } = controllerWith(() =>
    Promise.resolve({ outcome: "ok" }),
  );
  await actions.start({ kind: "promote", ...TARGET });
  await actions.start({ kind: "remove", ...TARGET, claimed: true });
  actions.editDefineDraft("Grace");
  expect(last()).toMatchObject({
    message: "The person is now an admin.",
    defineDraft: "Grace",
  });
  // The same workspace changes nothing.
  actions.listChanged(known({ revision: 5 }), NOW);
  expect(last().dialog).toBeDefined();

  actions.listChanged(known({ workspaceId: OTHER_WORKSPACE }), NOW);
  expect(last()).toEqual(IDLE_PEOPLE_ACTIONS);
});

test("the sentence of a confirmed leave stays through the switch that the leave brings, but not through a sign-out or a later switch", async () => {
  for (const next of [
    { workspaceId: OTHER_WORKSPACE },
    { status: "no_workspace", workspaceId: null },
  ] as const) {
    const { actions, last } = controllerWith(
      () => Promise.resolve({ outcome: "ok" }),
      known({ ownMemberId: MEMBER }),
    );
    await actions.start({ kind: "leave", ...IN_WORKSPACE });
    await actions.confirm();
    actions.listChanged(known(next), NOW);
    expect(last().message).toBe("You left the workspace.");
    actions.listChanged(known({ workspaceId: WORKSPACE }), NOW);
    expect(last().message).toBeUndefined();
  }
  const { actions, last } = controllerWith(
    () => Promise.resolve({ outcome: "ok" }),
    known({ ownMemberId: MEMBER }),
  );
  await actions.start({ kind: "leave", ...IN_WORKSPACE });
  await actions.confirm();
  actions.listChanged(known({ status: "signed_out", workspaceId: null }), NOW);
  expect(last().message).toBeUndefined();

  // A leave that was not confirmed keeps no sentence through a switch.
  const unknown = controllerWith(
    () => Promise.resolve({ outcome: "unknown" }),
    known({ ownMemberId: MEMBER }),
  );
  await unknown.actions.start({ kind: "leave", ...IN_WORKSPACE });
  await unknown.actions.confirm();
  unknown.actions.listChanged(known({ workspaceId: OTHER_WORKSPACE }), NOW);
  expect(unknown.last().message).toBeUndefined();
});

test("a confirmed leave whose answer arrives after the switch keeps its sentence, but not through the next switch, and lets the focus move", async () => {
  const { answer, resolve } = pending();
  const { actions, last } = controllerWith(
    answer,
    known({ ownMemberId: MEMBER }),
  );
  await actions.start({ kind: "leave", ...IN_WORKSPACE });
  const done = actions.confirm();
  actions.listChanged(known({ workspaceId: OTHER_WORKSPACE }), NOW);
  resolve({ outcome: "ok" });
  // The leave's control went with its workspace, so the focus may move to
  // the title if it was left on that control or on the page.
  await expect(done).resolves.toBe(true);
  expect(last().message).toBe("You left the workspace.");
  // The switch that the leave brought has happened: a later one, by the
  // person, ends the sentence.
  actions.listChanged(known({ workspaceId: WORKSPACE }), NOW);
  expect(last().message).toBeUndefined();
});

test("a confirmed leave whose answer arrives after a sign-out shows no sentence and moves no focus, also once the next session is signed in", async () => {
  for (const after of [
    [known({ status: "signed_out", workspaceId: null })],
    [
      known({ status: "signed_out", workspaceId: null }),
      known({ status: "no_workspace", workspaceId: null }),
    ],
    [
      known({ status: "signed_out", workspaceId: null }),
      known({ workspaceId: OTHER_WORKSPACE }),
    ],
  ]) {
    const { answer, resolve } = pending();
    const { actions, last } = controllerWith(
      answer,
      known({ ownMemberId: MEMBER }),
    );
    await actions.start({ kind: "leave", ...IN_WORKSPACE });
    const done = actions.confirm();
    for (const view of after) {
      actions.listChanged(view, NOW);
    }
    resolve({ outcome: "ok" });
    await expect(done).resolves.toBe(false);
    expect(last().message, String(after.length)).toBeUndefined();
  }
  // Without a sign-out, the leave's own switch to no workspace keeps it.
  const { answer, resolve } = pending();
  const { actions, last } = controllerWith(
    answer,
    known({ ownMemberId: MEMBER }),
  );
  await actions.start({ kind: "leave", ...IN_WORKSPACE });
  const done = actions.confirm();
  actions.listChanged(
    known({ status: "no_workspace", workspaceId: null }),
    NOW,
  );
  resolve({ outcome: "ok" });
  await expect(done).resolves.toBe(true);
  expect(last().message).toBe("You left the workspace.");
});

test("every sign-out ends the session, not only the first one of the controller's life", async () => {
  const { answer, resolve } = pending();
  const { actions, last } = controllerWith(
    answer,
    known({ ownMemberId: MEMBER }),
  );
  const signedOut = known({ status: "signed_out", workspaceId: null });
  actions.listChanged(signedOut, NOW);
  actions.listChanged(known({ ownMemberId: MEMBER }), NOW);
  await actions.start({ kind: "leave", ...IN_WORKSPACE });
  const done = actions.confirm();
  actions.listChanged(signedOut, NOW);
  resolve({ outcome: "ok" });
  await expect(done).resolves.toBe(false);
  expect(last().message).toBeUndefined();
});

test("an answer after a switch away and back to its workspace counts as after a switch", async () => {
  const { answer, resolve } = pending();
  const { actions, last } = controllerWith(answer);
  actions.editDefineDraft("Grace");
  const defined = actions.define(WORKSPACE);
  actions.listChanged(known({ workspaceId: OTHER_WORKSPACE }), NOW);
  actions.listChanged(known(), NOW);
  actions.editDefineDraft("Edsger");
  resolve({ outcome: "ok", memberId: UNCLAIMED });
  await defined;
  expect(last()).toMatchObject({ message: undefined, defineDraft: "Edsger" });

  const promotion = pending();
  const other = controllerWith(promotion.answer);
  const promoted = other.actions.start({ kind: "promote", ...TARGET });
  other.actions.listChanged(
    known({ status: "signed_out", workspaceId: null }),
    NOW,
  );
  other.actions.listChanged(known(), NOW);
  promotion.resolve({ outcome: "ok" });
  await expect(promoted).resolves.toBe(false);
  expect(other.last().message).toBeUndefined();
});

test("editing a name ends the problem of the name as it was", async () => {
  const { actions, last } = controllerWith(() =>
    Promise.resolve({ outcome: "ok" }),
  );
  actions.editDefineDraft(" ");
  await actions.define(WORKSPACE);
  expect(last().defineProblem).toBe("Enter a name.");
  actions.editDefineDraft("G");
  expect(last()).toMatchObject({ defineDraft: "G", defineProblem: undefined });

  await actions.start({
    kind: "rename",
    workspaceId: WORKSPACE,
    memberId: UNCLAIMED,
    name: "Margaret",
  });
  actions.editDialogDraft("");
  await actions.confirm();
  expect(last().dialog?.problem).toBe("Enter a name.");
  actions.editDialogDraft("M");
  expect(last().dialog).toMatchObject({ draft: "M", problem: undefined });
});

test("a sign-out always ends the question, the field, and the sentence, also after no workspace was selected", async () => {
  const { actions, last } = controllerWith(
    () => Promise.resolve({ outcome: "ok" }),
    known({ ownMemberId: MEMBER }),
  );
  await actions.start({ kind: "leave", ...IN_WORKSPACE });
  await actions.confirm();
  const none = { status: "no_workspace", workspaceId: null } as const;
  actions.listChanged(known(none), NOW);
  expect(last().message).toBe("You left the workspace.");
  actions.listChanged(known({ status: "signed_out", workspaceId: null }), NOW);
  expect(last()).toEqual(IDLE_PEOPLE_ACTIONS);

  // With a field and its problem.
  const other = controllerWith(() => Promise.resolve({ outcome: "ok" }));
  other.actions.editDefineDraft(" ");
  await other.actions.define(WORKSPACE);
  other.actions.listChanged(known({ status: "loading" }), NOW);
  expect(other.last()).toMatchObject({
    defineDraft: " ",
    defineProblem: "Enter a name.",
  });
  other.actions.listChanged(
    known({ status: "signed_out", workspaceId: WORKSPACE }),
    NOW,
  );
  expect(other.last()).toEqual(IDLE_PEOPLE_ACTIONS);
});

test("an answer that arrives after another workspace was selected or after a sign-out shows no sentence, moves no focus, and keeps a name typed since", async () => {
  for (const next of [
    known({ workspaceId: OTHER_WORKSPACE }),
    known({ status: "signed_out", workspaceId: null }),
  ]) {
    const { answer, resolve } = pending();
    const { actions, last } = controllerWith(answer);
    const promoted = actions.start({ kind: "promote", ...TARGET });
    actions.listChanged(next, NOW);
    actions.editDefineDraft("Typed after the switch");
    resolve({ outcome: "ok" });
    await expect(promoted).resolves.toBe(false);
    expect(last()).toEqual({
      ...IDLE_PEOPLE_ACTIONS,
      defineDraft: "Typed after the switch",
    });
  }

  // A definition confirmed after the switch leaves the new field alone.
  const { answer, resolve } = pending();
  const { actions, last } = controllerWith(answer);
  actions.editDefineDraft("Grace");
  const defined = actions.define(WORKSPACE);
  actions.listChanged(known({ workspaceId: OTHER_WORKSPACE }), NOW);
  actions.editDefineDraft("Edsger");
  resolve({ outcome: "ok", memberId: UNCLAIMED });
  await defined;
  expect(last()).toMatchObject({ message: undefined, defineDraft: "Edsger" });
});

test("a definition's rate limit names the unclaimed limit of its own workspace only while that limit is known", async () => {
  const { answer, resolve } = pending();
  const { actions, last } = controllerWith(
    answer,
    known({ maxUnclaimedMembers: 1 }),
  );
  actions.editDefineDraft("Grace");
  const defined = actions.define(WORKSPACE);
  // The same workspace reloads, and the limit is not known for now.
  actions.listChanged(known({ revision: 5, maxUnclaimedMembers: null }), NOW);
  resolve(refused("rate_limited", 5_000));
  await defined;
  expect(last().message).toBe(
    "The person could not be added. The server asked to wait. Try again in 5 seconds.",
  );
});

test("an open question that the screen stops offering ends in the controller, never comes back on its own, and sends nothing", async () => {
  const admin = known({ ownMemberId: ADMIN });
  // Linus, a claimed member, is promoted to admin: an admin cannot remove
  // an admin.
  const promoted = known({
    ownMemberId: ADMIN,
    people: PEOPLE.map((entry) =>
      entry.memberId === MEMBER ? { ...entry, role: "admin" as const } : entry,
    ),
  });
  const offered = {
    ownershipOffer: { memberId: MEMBER, expiresAt: EXPIRES_AT },
  };
  const cases: [
    PeopleScreenView,
    PeopleActionRequest,
    PeopleScreenView,
    number,
  ][] = [
    [admin, { kind: "remove", ...TARGET, claimed: true }, promoted, NOW],
    [
      admin,
      { kind: "remove", ...TARGET, claimed: true },
      known({ ownMemberId: ADMIN, status: "loading" }),
      NOW,
    ],
    [
      admin,
      { kind: "remove", ...TARGET, claimed: true },
      { kind: "pending" },
      NOW,
    ],
    [
      known({ ...offered, ownMemberId: MEMBER }),
      { kind: "accept", ...IN_WORKSPACE },
      known({ ...offered, ownMemberId: MEMBER }),
      Date.parse(EXPIRES_AT),
    ],
  ];
  for (const [first, request, gone, at] of cases) {
    const { actions, calls, last } = controllerWith(
      () => Promise.resolve({ outcome: "ok" }),
      first,
    );
    await actions.start(request);
    expect(last().dialog?.request).toBe(request);
    actions.listChanged(first, NOW);
    expect(last().dialog?.request, "still offered").toBe(request);
    actions.listChanged(gone, at);
    expect(last().dialog, JSON.stringify(gone)).toBeUndefined();
    // Offered again: the question stays closed.
    actions.listChanged(first, NOW);
    expect(last().dialog).toBeUndefined();
    await expect(actions.confirm()).resolves.toBe(false);
    expect(calls).toEqual([]);
  }
});

test("an open Remove question ends when its person is claimed or renamed, so it never shows an outdated text", async () => {
  const unclaimed = {
    kind: "remove",
    workspaceId: WORKSPACE,
    memberId: UNCLAIMED,
    name: "Margaret",
    claimed: false,
  } as const;
  for (const change of [
    {
      claimed: true,
      login: "margaret-h",
      verifiedAt: "2026-11-09T10:00:00.000Z",
    },
    { displayName: "Margaret H." },
  ]) {
    const { actions, calls, last } = controllerWith(() =>
      Promise.resolve({ outcome: "ok" }),
    );
    await actions.start(unclaimed);
    actions.listChanged(
      known({
        people: PEOPLE.map((entry) =>
          entry.memberId === UNCLAIMED ? { ...entry, ...change } : entry,
        ),
      }),
      NOW,
    );
    expect(last().dialog, JSON.stringify(change)).toBeUndefined();
    await actions.confirm();
    expect(calls).toEqual([]);
  }
});

test("the focus moves to the title when a question ends after its button left the page", () => {
  expect(focusesTitleAfterClose(true, false, true)).toBe(true);
  expect(focusesTitleAfterClose(true, false, false)).toBe(false);
  expect(focusesTitleAfterClose(true, true, true)).toBe(false);
  expect(focusesTitleAfterClose(false, false, true)).toBe(false);
});

test("the clock waits until the change, never less than nothing, and at most the longest timer", () => {
  expect(clockDelay(Date.parse(EXPIRES_AT), NOW)).toBe(
    Date.parse(EXPIRES_AT) - NOW,
  );
  expect(clockDelay(NOW - 1, NOW)).toBe(0);
  expect(clockDelay(NOW + MAX_CLOCK_WAIT_MS + 1, NOW)).toBe(MAX_CLOCK_WAIT_MS);
  expect(MAX_CLOCK_WAIT_MS).toBe(2_147_483_647);
});

test("the clock is read again when the window gets the focus or the document's visibility changes, each on its own target, and not after the watch ends", () => {
  const win = new EventTarget();
  const doc = new EventTarget();
  const reads: string[] = [];
  const stop = watchClockReads(win, doc, () => {
    reads.push("read");
  });
  const fire = (target: EventTarget, type: string) => {
    reads.length = 0;
    target.dispatchEvent(new Event(type));
    return reads.length;
  };
  expect(fire(win, "focus"), "window focus").toBe(1);
  expect(fire(doc, "visibilitychange"), "document visibility").toBe(1);
  // Each event reads it only on its own target.
  expect(fire(win, "visibilitychange"), "window visibility").toBe(0);
  expect(fire(doc, "focus"), "document focus").toBe(0);
  stop();
  for (const target of [win, doc]) {
    for (const type of ["focus", "visibilitychange"]) {
      expect(fire(target, type), `${type} after the end`).toBe(0);
    }
  }
});

test("the people never change from an answer: the controller holds no people", async () => {
  const { actions, last } = controllerWith(() =>
    Promise.resolve({ outcome: "ok", memberId: UNCLAIMED }),
  );
  actions.editDefineDraft("Grace");
  await actions.define(WORKSPACE);
  expect(Object.keys(last()).sort()).toEqual([
    "defineDraft",
    "defineProblem",
    "dialog",
    "message",
    "running",
  ]);
  // The new person's member ID stays out of what the screen shows.
  expect(JSON.stringify(last())).not.toContain(UNCLAIMED);
});
