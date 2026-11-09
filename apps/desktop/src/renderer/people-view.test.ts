import { expect, test } from "vitest";
import type { PeopleBridge } from "../shared/desktop-bridge.ts";
import {
  PERSON_ROLES,
  WORKSPACE_PROBLEMS,
  type PeopleView,
  type PersonView,
} from "../shared/ipc-contract.ts";
import {
  describeMorePeople,
  describePeopleScreen,
  followPeople,
  formatPeopleDate,
  initialPeopleScreenView,
  PEOPLE_MESSAGES,
  PEOPLE_PROBLEM_MESSAGES,
  peopleDateFormat,
  ROLE_LABELS,
  type PeopleScreenView,
} from "./people-view.ts";

const WORKSPACE = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3";
const OWNER = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c1";
const ADMIN = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c2";
const MEMBER = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c3";
const UNCLAIMED = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c4";
const FORMER = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c5";
const ERASED = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c6";
const NEVER_CLAIMED = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c7";
const SECOND_MEMBER = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c8";
const SECOND_UNCLAIMED = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c9";

const VERIFIED_AT = "2026-11-06T08:00:00.000Z";

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
    verifiedAt: VERIFIED_AT,
    former: false,
    ...overrides,
  };
}

const PEOPLE: readonly PersonView[] = [
  person(OWNER, "Ada", { role: "owner", login: "ada-l" }),
  person(ADMIN, "Grace", { role: "admin", login: "grace-h" }),
  person(MEMBER, "Linus"),
  person(UNCLAIMED, "Margaret", {
    claimed: false,
    login: null,
    verifiedAt: null,
  }),
  person(FORMER, "Alan", { role: "admin", former: true, login: "alan-t" }),
  person(ERASED, "Edsger", { former: true, login: null, verifiedAt: null }),
  person(NEVER_CLAIMED, "Barbara", {
    former: true,
    claimed: false,
    login: null,
    verifiedAt: null,
  }),
];

const READY: PeopleView = {
  revision: 4,
  status: "ready",
  workspaceId: WORKSPACE,
  workspaceName: "Team",
  ownMemberId: MEMBER,
  people: PEOPLE,
  morePeople: 0,
};

function known(overrides: Partial<PeopleView> = {}): PeopleScreenView {
  return { kind: "known", state: { ...READY, ...overrides } as PeopleView };
}

test("the view starts pending with the bridge and unavailable without it", () => {
  expect(initialPeopleScreenView(true)).toEqual({ kind: "pending" });
  expect(initialPeopleScreenView(false)).toEqual({ kind: "unavailable" });
});

test("following the people reports every state, a refused subscription, and ends the subscription", () => {
  const fake = {
    listener: undefined as ((state: PeopleView) => void) | undefined,
    onError: undefined as (() => void) | undefined,
    ended: 0,
  };
  const bridge: Pick<PeopleBridge, "subscribeState"> = {
    subscribeState: (listener, onError) => {
      fake.listener = listener;
      fake.onError = onError;
      return () => {
        fake.ended += 1;
      };
    },
  };
  const views: PeopleScreenView[] = [];

  const stop = followPeople(bridge, (view) => views.push(view));
  fake.listener?.(READY);
  fake.onError?.();
  stop();

  expect(views).toEqual([
    { kind: "known", state: READY },
    { kind: "unavailable" },
  ]);
  expect(fake.ended).toBe(1);
});

test("each state without people has its own fixed text and lists nothing, with the workspace's name when there is one", () => {
  const unnamed = { workspaceId: null, workspaceName: null, people: [] };
  const cases: readonly [PeopleScreenView, string, string | null][] = [
    [{ kind: "unavailable" }, "People are not available.", null],
    [{ kind: "pending" }, "Checking the people.", null],
    [
      known({ status: "signed_out", ...unnamed }),
      "People appear once this device is signed in and ready.",
      null,
    ],
    // True both without any workspace and without a selected one.
    [
      known({ status: "no_workspace", ...unnamed }),
      "No workspace is selected.",
      null,
    ],
    [known({ status: "loading", people: [] }), "Loading the people.", "Team"],
    [known({ people: [] }), "No people yet.", "Team"],
  ];
  for (const [view, status, workspaceName] of cases) {
    expect(describePeopleScreen(view), status).toEqual({
      status,
      workspaceName,
      lists: null,
      adminHint: false,
    });
  }
});

test("a ready state lists the active people and then the former members apart, in the main process's order", () => {
  const { status, lists } = describePeopleScreen(known());

  expect(status).toBe("");
  expect(lists?.active).toEqual([
    {
      memberId: OWNER,
      displayName: "Ada",
      role: "Owner",
      you: false,
      github: { login: "ada-l", verifiedAt: VERIFIED_AT },
      note: null,
    },
    {
      memberId: ADMIN,
      displayName: "Grace",
      role: "Admin",
      you: false,
      github: { login: "grace-h", verifiedAt: VERIFIED_AT },
      note: null,
    },
    {
      memberId: MEMBER,
      displayName: "Linus",
      role: "Member",
      you: true,
      github: { login: "octocat", verifiedAt: VERIFIED_AT },
      note: null,
    },
    {
      memberId: UNCLAIMED,
      displayName: "Margaret",
      role: "Member",
      you: false,
      github: null,
      note: "Not claimed yet",
    },
  ]);
  // A former member shows no role; one whose account's data was erased
  // shows that no login is kept, and one that was never claimed says so.
  expect(lists?.former).toEqual([
    {
      memberId: FORMER,
      displayName: "Alan",
      role: null,
      you: false,
      github: { login: "alan-t", verifiedAt: VERIFIED_AT },
      note: null,
    },
    {
      memberId: ERASED,
      displayName: "Edsger",
      role: null,
      you: false,
      github: null,
      note: "No GitHub login",
    },
    {
      memberId: NEVER_CLAIMED,
      displayName: "Barbara",
      role: null,
      you: false,
      github: null,
      note: "Never claimed",
    },
  ]);
  expect(lists?.morePeople).toBe(0);
});

test("the active people are sorted owner, admins, claimed members, then unclaimed people, each group in the main process's order", () => {
  const unclaimed = { claimed: false, login: null, verifiedAt: null };
  const { lists } = describePeopleScreen(
    known({
      // The main process's order, after events added people at the end.
      people: [
        person(UNCLAIMED, "Margaret", unclaimed),
        person(SECOND_MEMBER, "Barbara L"),
        person(FORMER, "Alan", { role: "admin", former: true }),
        person(ADMIN, "Grace", { role: "admin" }),
        person(SECOND_UNCLAIMED, "Hedy", unclaimed),
        person(MEMBER, "Linus"),
        person(OWNER, "Ada", { role: "owner" }),
        person(ERASED, "Edsger", { former: true }),
      ],
    }),
  );
  expect(lists?.active.map((row) => row.memberId)).toEqual([
    OWNER,
    ADMIN,
    SECOND_MEMBER,
    MEMBER,
    UNCLAIMED,
    SECOND_UNCLAIMED,
  ]);
  // The former members keep the main process's order.
  expect(lists?.former.map((row) => row.memberId)).toEqual([FORMER, ERASED]);
});

test("only the account's own person is marked", () => {
  for (const ownMemberId of [OWNER, ADMIN, UNCLAIMED, null]) {
    const { lists } = describePeopleScreen(known({ ownMemberId }));
    const marked = [...(lists?.active ?? []), ...(lists?.former ?? [])]
      .filter((row) => row.you)
      .map((row) => row.memberId);
    expect(marked).toEqual(ownMemberId === null ? [] : [ownMemberId]);
  }
});

test("the hint to make someone an admin shows to the owner only, while no active person is an admin and an active, claimed person could become one", () => {
  const noAdmin = PEOPLE.map((entry) =>
    entry.memberId === ADMIN ? { ...entry, role: "member" as const } : entry,
  );
  const hint = (overrides: Partial<PeopleView>) =>
    describePeopleScreen(known(overrides)).adminHint;

  // The owner of a workspace without an admin, with claimed members; a
  // former admin does not count.
  expect(hint({ ownMemberId: OWNER, people: noAdmin })).toBe(true);
  // An active admin ends it.
  expect(hint({ ownMemberId: OWNER, people: PEOPLE })).toBe(false);
  // Without an active, claimed person besides the owner, nobody could be
  // promoted: only unclaimed people and former members.
  const ownerAlone = noAdmin.filter(
    (entry) => entry.role === "owner" || entry.former || !entry.claimed,
  );
  expect(ownerAlone.some((entry) => !entry.former && !entry.claimed)).toBe(
    true,
  );
  expect(ownerAlone.some((entry) => entry.former && entry.claimed)).toBe(true);
  expect(hint({ ownMemberId: OWNER, people: ownerAlone })).toBe(false);
  // One claimed member is enough.
  expect(
    hint({
      ownMemberId: OWNER,
      people: [...ownerAlone, person(SECOND_MEMBER, "Barbara L")],
    }),
  ).toBe(true);
  // Nobody else sees it, and never an admin.
  for (const ownMemberId of [MEMBER, UNCLAIMED, FORMER, null]) {
    expect(hint({ ownMemberId, people: noAdmin }), String(ownMemberId)).toBe(
      false,
    );
  }
  expect(hint({ ownMemberId: ADMIN, people: PEOPLE })).toBe(false);
  // With people left out, the screen cannot know.
  expect(hint({ ownMemberId: OWNER, people: noAdmin, morePeople: 1 })).toBe(
    false,
  );
  // While unavailable with the people loaded before, it still shows.
  expect(
    hint({
      status: "unavailable",
      problem: "unavailable",
      ownMemberId: OWNER,
      people: noAdmin,
    } as Partial<PeopleView>),
  ).toBe(true);
  // A former owner, for example after a transfer, is not the owner.
  expect(
    hint({
      ownMemberId: FORMER,
      people: noAdmin.map((entry) =>
        entry.memberId === FORMER
          ? { ...entry, role: "owner" as const }
          : entry,
      ),
    }),
  ).toBe(false);
  expect(PEOPLE_MESSAGES.adminHint).toBe(
    "Only you can manage this workspace. Consider making someone you trust an admin, so they can also invite people and answer join requests.",
  );
});

test("an unavailable state shows its problem, with the people loaded before or alone", () => {
  for (const problem of WORKSPACE_PROBLEMS) {
    const withPeople = describePeopleScreen(
      known({ status: "unavailable", problem } as Partial<PeopleView>),
    );
    expect(withPeople.status).toBe(PEOPLE_PROBLEM_MESSAGES[problem]);
    expect(withPeople.lists?.active).toHaveLength(4);
    const alone = describePeopleScreen(
      known({
        status: "unavailable",
        problem,
        people: [],
      } as Partial<PeopleView>),
    );
    expect(alone).toEqual({
      status: PEOPLE_PROBLEM_MESSAGES[problem],
      workspaceName: "Team",
      lists: null,
      adminHint: false,
    });
  }
  expect(Object.keys(PEOPLE_PROBLEM_MESSAGES).sort()).toEqual(
    [...WORKSPACE_PROBLEMS].sort(),
  );
});

test("every role has a text", () => {
  expect(Object.keys(ROLE_LABELS).sort()).toEqual([...PERSON_ROLES].sort());
  expect(ROLE_LABELS).toEqual({
    owner: "Owner",
    admin: "Admin",
    member: "Member",
  });
});

test("a workspace without active people says so and still lists its former members", () => {
  const { status, lists } = describePeopleScreen(
    known({ people: PEOPLE.filter((entry) => entry.former) }),
  );
  expect(status).toBe(PEOPLE_MESSAGES.noPeople);
  expect(lists?.active).toEqual([]);
  expect(lists?.former.map((row) => row.memberId)).toEqual([
    FORMER,
    ERASED,
    NEVER_CLAIMED,
  ]);
});

test("the note counts the people left out, with the digits grouped in the locale", () => {
  const english = new Intl.NumberFormat("en-US");
  expect(describeMorePeople(1, english)).toBe("1 more person is not shown.");
  expect(describeMorePeople(1200, english)).toBe(
    "1,200 more people are not shown.",
  );
  expect(describePeopleScreen(known({ morePeople: 7 })).lists?.morePeople).toBe(
    7,
  );
});

test("a verified date is shown in the given locale and time zone, and a value that is not a date stays as it is", () => {
  const format = peopleDateFormat({ locale: "en-US", timeZone: "UTC" });
  expect(formatPeopleDate(VERIFIED_AT, format)).toBe("Nov 6, 2026");
  // Late in the evening in UTC is the next day in Istanbul.
  expect(
    formatPeopleDate(
      "2026-11-06T22:30:00.000Z",
      peopleDateFormat({ locale: "en-US", timeZone: "Europe/Istanbul" }),
    ),
  ).toBe("Nov 7, 2026");
  expect(formatPeopleDate("yesterday", format)).toBe("yesterday");
  // The system's time zone and the person's locale by default.
  expect(peopleDateFormat().resolvedOptions().timeZone).toBe(
    new Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
});
