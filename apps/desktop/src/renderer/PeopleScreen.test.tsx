import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";
import {
  WORKSPACE_PROBLEMS,
  type PeopleView,
  type PersonView,
} from "../shared/ipc-contract.ts";
import { PeopleScreen, PeopleScreenContent } from "./PeopleScreen.tsx";
import {
  PEOPLE_MESSAGES,
  PEOPLE_PROBLEM_MESSAGES,
  peopleDateFormat,
  type PeopleScreenView,
} from "./people-view.ts";

const WORKSPACE = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3";
const OWNER = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c1";
const MEMBER = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c3";
const UNCLAIMED = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c4";
const FORMER = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c5";
const NEVER_CLAIMED = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c6";

const VERIFIED_AT = "2026-11-06T22:30:00.000Z";

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

const READY: PeopleView = {
  revision: 4,
  status: "ready",
  workspaceId: WORKSPACE,
  workspaceName: "Team",
  ownMemberId: OWNER,
  people: [
    person(OWNER, "Ada", { role: "owner", login: "ada-l" }),
    person(MEMBER, "Linus"),
    person(UNCLAIMED, "Margaret", {
      claimed: false,
      login: null,
      verifiedAt: null,
    }),
    person(FORMER, "Alan", { role: "admin", former: true, login: "alan-t" }),
    person(NEVER_CLAIMED, "Barbara", {
      former: true,
      claimed: false,
      login: null,
      verifiedAt: null,
    }),
  ],
  morePeople: 0,
};

function known(overrides: Partial<PeopleView> = {}): PeopleScreenView {
  return { kind: "known", state: { ...READY, ...overrides } as PeopleView };
}

/** A fixed locale and a time zone that is not UTC, whatever the machine's. */
const ISTANBUL_DATES = peopleDateFormat({
  locale: "en-GB",
  timeZone: "Europe/Istanbul",
});

function render(view: PeopleScreenView): string {
  return renderToString(
    <PeopleScreenContent view={view} dateFormat={ISTANBUL_DATES} />,
  );
}

/** Text as React escapes it. */
function escaped(text: string): string {
  return text.replaceAll("'", "&#x27;");
}

const TITLE =
  '<section aria-labelledby="people-title"><h2 id="people-title">People</h2>';
const ACTIONS_LATER = `<p class="placeholder-note">${PEOPLE_MESSAGES.actionsLater}</p></section>`;
const HINT = `<p class="people-hint">${PEOPLE_MESSAGES.adminHint}</p>`;
/** The selected workspace's name below the heading. */
const NAMED =
  '<p class="people-workspace">Workspace: <span dir="auto">Team</span></p>';

function status(text: string): string {
  return `<p class="people-status" role="status">${escaped(text)}</p>`;
}

function attributeValues(html: string, name: string): string[] {
  return [...html.matchAll(new RegExp(`\\s${name}="([^"]*)"`, "g"))].map(
    ([, value]) => value ?? "",
  );
}

test("each state without people shows its text in the status paragraph, and no list, below the workspace's name when there is one", () => {
  const unnamed = { workspaceId: null, workspaceName: null, people: [] };
  const cases: [PeopleScreenView, string, string][] = [
    [{ kind: "unavailable" }, "People are not available.", ""],
    [{ kind: "pending" }, "Checking the people.", ""],
    [
      known({ status: "signed_out", ...unnamed }),
      "People appear once this device is signed in and ready.",
      "",
    ],
    [
      known({ status: "no_workspace", ...unnamed }),
      "No workspace is selected.",
      "",
    ],
    [known({ status: "loading", people: [] }), "Loading the people.", NAMED],
    [known({ people: [] }), "No people yet.", NAMED],
  ];
  for (const [view, text, name] of cases) {
    expect(render(view), text).toBe(
      TITLE + name + status(text) + ACTIONS_LATER,
    );
  }
});

test("a ready state lists each person with the name, the role, and the login with its date, the own person marked, and the former members apart", () => {
  const html = render(known());

  expect(html).toBe(
    TITLE +
      NAMED +
      status("") +
      HINT +
      '<ul class="people-list" aria-labelledby="people-title">' +
      '<li class="person">' +
      '<p class="person-name"><span dir="auto">Ada</span><span class="person-you"> (you)</span></p>' +
      '<p class="person-meta">Owner</p>' +
      '<p class="person-meta">GitHub <span class="person-login" translate="no">ada-l</span>, last verified <time dateTime="2026-11-06T22:30:00.000Z">7 Nov 2026</time></p>' +
      "</li>" +
      '<li class="person">' +
      '<p class="person-name"><span dir="auto">Linus</span></p>' +
      '<p class="person-meta">Member</p>' +
      '<p class="person-meta">GitHub <span class="person-login" translate="no">octocat</span>, last verified <time dateTime="2026-11-06T22:30:00.000Z">7 Nov 2026</time></p>' +
      "</li>" +
      '<li class="person">' +
      '<p class="person-name"><span dir="auto">Margaret</span></p>' +
      '<p class="person-meta">Member</p>' +
      '<p class="person-meta">Not claimed yet</p>' +
      "</li>" +
      "</ul>" +
      '<h3 class="people-heading" id="former-people-heading">Former members</h3>' +
      '<ul class="people-list" aria-labelledby="former-people-heading">' +
      '<li class="person">' +
      '<p class="person-name"><span dir="auto">Alan</span></p>' +
      '<p class="person-meta">GitHub <span class="person-login" translate="no">alan-t</span>, last verified <time dateTime="2026-11-06T22:30:00.000Z">7 Nov 2026</time></p>' +
      "</li>" +
      '<li class="person">' +
      '<p class="person-name"><span dir="auto">Barbara</span></p>' +
      '<p class="person-meta">Never claimed</p>' +
      "</li>" +
      "</ul>" +
      ACTIONS_LATER,
  );
});

test("the hint to make someone an admin shows to the owner only, when someone could become an admin", () => {
  expect(render(known())).toContain(HINT);
  expect(render(known({ ownMemberId: MEMBER }))).not.toContain("people-hint");
  // Only unclaimed people besides the owner: nobody can be promoted.
  expect(
    render(
      known({
        people: READY.people.filter((entry) => entry.memberId !== MEMBER),
      }),
    ),
  ).not.toContain("people-hint");
  expect(
    render(
      known({
        people: [
          ...READY.people,
          person("0192f2a0-7c3e-7a1b-8c4d-5e6f708192c7", "Grace", {
            role: "admin",
          }),
        ],
      }),
    ),
  ).not.toContain("people-hint");
});

test("people left out are counted after the last list", () => {
  const html = render(known({ morePeople: 2 }));
  const note = `<p class="people-note">${new Intl.NumberFormat().format(2)} more people are not shown.</p>`;
  expect(html).toContain(`</ul>${note}${ACTIONS_LATER}`);
  expect(html.indexOf(note)).toBeGreaterThan(
    html.indexOf("former-people-heading"),
  );
});

test("without former members there is no former group, and people left out are counted", () => {
  const html = render(
    known({
      people: READY.people.filter((entry) => !entry.former),
      morePeople: 1200,
    }),
  );

  expect(html).not.toContain("Former members");
  expect(html).not.toContain("former-people-heading");
  expect(html).toContain(
    `<p class="people-note">${new Intl.NumberFormat().format(1200)} more people are not shown.</p>`,
  );
  // With people left out, the screen does not know whether an admin exists.
  expect(html).not.toContain("people-hint");
});

test("an unavailable state shows its problem with the people loaded before, or alone", () => {
  for (const problem of WORKSPACE_PROBLEMS) {
    const withPeople = render(
      known({ status: "unavailable", problem } as Partial<PeopleView>),
    );
    expect(withPeople).toContain(status(PEOPLE_PROBLEM_MESSAGES[problem]));
    expect(withPeople).toContain('<span dir="auto">Ada</span>');

    const alone = render(
      known({
        status: "unavailable",
        problem,
        people: [],
      } as Partial<PeopleView>),
    );
    expect(alone).toBe(
      TITLE + NAMED + status(PEOPLE_PROBLEM_MESSAGES[problem]) + ACTIONS_LATER,
    );
  }
});

test("names and logins are rendered as text, never as markup", () => {
  const html = render(
    known({
      workspaceName: "<b>Team</b>",
      people: [
        person(OWNER, '<img src="x" onerror="alert(1)">', { role: "owner" }),
        // A right-to-left name takes its direction from its content.
        person(MEMBER, "\u05e9\u05dc\u05d5\u05dd <b>"),
      ],
    }),
  );

  expect(html).toContain(
    '<span dir="auto">&lt;img src=&quot;x&quot; onerror=&quot;alert(1)&quot;&gt;</span>',
  );
  expect(html).toContain(
    '<span dir="auto">\u05e9\u05dc\u05d5\u05dd &lt;b&gt;</span>',
  );
  expect(html).toContain(
    '<p class="people-workspace">Workspace: <span dir="auto">&lt;b&gt;Team&lt;/b&gt;</span></p>',
  );
  expect(html).not.toContain("<img");
  expect(html).not.toContain("<b>");
});

test("the screen's ids are unique, every reference points to one of them, no ID is shown, and nothing uses a style attribute", () => {
  const html = render(known());

  const ids = attributeValues(html, "id");
  expect(ids).toEqual(["people-title", "former-people-heading"]);
  for (const reference of attributeValues(html, "aria-labelledby")) {
    expect(ids).toContain(reference);
  }
  // The Content Security Policy allows no inline styles.
  expect(html).not.toMatch(/\sstyle=/);
  for (const id of [WORKSPACE, OWNER, MEMBER, UNCLAIMED, FORMER]) {
    expect(html).not.toContain(id);
  }
});

test("the screen with a bridge waits for the first people, and without one says that they are not available", () => {
  const people = {
    getState: () => new Promise<PeopleView>(() => undefined),
    subscribeState: () => () => undefined,
  };
  expect(renderToString(<PeopleScreen people={people} />)).toContain(
    status("Checking the people."),
  );
  expect(renderToString(<PeopleScreen people={undefined} />)).toContain(
    status("People are not available."),
  );
});
