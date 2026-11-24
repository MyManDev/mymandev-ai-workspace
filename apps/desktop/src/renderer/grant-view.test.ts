import { CAPABILITY_RISK } from "@mymandev/permissions/capabilities";
import {
  CAPABILITIES,
  GRANT_LIFETIME_SECONDS,
  GRANT_ROUTE_ERRORS,
  SHELL_GRANT_MAX_LIFETIME_SECONDS,
} from "@mymandev/protocol";
import { afterEach, expect, test, vi } from "vitest";
import type {
  AgentActivityView,
  AgentView,
  GrantCapabilityResult,
  GrantsView,
  GrantView,
  ProjectRepositoriesView,
  RevokeGrantResult,
} from "../shared/ipc-contract.ts";
import {
  GRANT_CAPABILITY_REFUSALS,
  REVOKE_GRANT_REFUSALS,
} from "../shared/ipc-contract.ts";
import { agentTimeFormat } from "./agent-view.ts";
import {
  askConfirmation,
  bundleableCapabilities,
  changeGrantForm,
  confirmedGrantOf,
  CONNECTION_PROBLEM_MESSAGES,
  createGrantActions,
  describeGrantResult,
  describeGrantSection,
  describeRevokeResult,
  endConfirmation,
  endHiddenConfirmation,
  EXPIRY_CHOICES,
  expiryChoices,
  GRANT_MESSAGES,
  GRANT_REFUSAL_MESSAGES,
  GRANT_RESULT_MESSAGES,
  grantRequestOf,
  INITIAL_CAPABILITY,
  INITIAL_GRANT_FORM,
  missingShellGitCapabilities,
  needsProviderConnections,
  NO_EXPIRY_ID,
  OFFERED_CAPABILITIES,
  preselectableCapabilities,
  proposedExpiryId,
  REVOKE_REFUSAL_MESSAGES,
  submitGrant,
  type ConnectionsPanelView,
  type GrantActionsView,
  type GrantFormState,
  type GrantFormView,
  type GrantSectionInput,
  type GrantSectionView,
  type GrantsPanelView,
} from "./grant-view.ts";
import {
  describeCapability,
  HIGHEST_RISK_CONFIRMATIONS,
  REPOSITORY_PROVIDER_STATEMENT,
  RISK_LABELS,
  SHELL_PROPOSED_LIFETIME_SECONDS,
  SHELL_STATEMENTS,
  shellGitStatement,
} from "./permission-view.ts";

afterEach(() => {
  vi.doUnmock("@mymandev/permissions/capabilities");
  vi.resetModules();
});

const PROJECT = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192e1";
const WORKSPACE = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a1";
const HERE = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192f1";
const SECOND = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192f2";
const ELSEWHERE = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192f3";
const THEIRS = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192f4";
const WEB = "0192f2a0-7c3e-7a1b-8c4d-5e6f70819201";
const API = "0192f2a0-7c3e-7a1b-8c4d-5e6f70819202";
const CONNECTION = "0192f2a0-7c3e-7a1b-8c4d-5e6f70819301";
const GRANT_1 = "0192f2a0-7c3e-7a1b-8c4d-5e6f70819401";
const GRANT_2 = "0192f2a0-7c3e-7a1b-8c4d-5e6f70819402";
const GRANT_3 = "0192f2a0-7c3e-7a1b-8c4d-5e6f70819403";
const AT = "2026-11-24T10:00:00.000Z";
const NOW = Date.parse("2026-11-24T12:00:00.000Z");
const FORMAT = agentTimeFormat({ locale: "en-US", timeZone: "UTC" });

function agent(
  id: string,
  name: string,
  flags: Partial<Pick<AgentView, "ownedByMe" | "grantableHere">> = {},
): AgentView {
  return {
    id,
    name,
    ownerName: "Ada",
    disabledAt: null,
    ownedByMe: flags.ownedByMe ?? false,
    grantableHere: flags.grantableHere ?? false,
  };
}

function agentsState(agents: readonly AgentView[]): AgentActivityView {
  return {
    status: "ready",
    revision: 1,
    workspaceId: WORKSPACE,
    projectId: PROJECT,
    agents,
    unfinishedRuns: [],
    moreUnfinishedRuns: 0,
    finishedRuns: [],
  };
}

const REPOSITORIES: ProjectRepositoriesView = {
  status: "ready",
  revision: 1,
  workspaceId: WORKSPACE,
  projectId: PROJECT,
  links: "ready",
  repositories: [
    {
      repositoryId: WEB,
      name: "web",
      linked: false,
      mountId: null,
      removable: true,
    },
    {
      repositoryId: API,
      name: "api",
      linked: false,
      mountId: null,
      removable: true,
    },
  ],
};

function grant(id: string, overrides: Partial<GrantView> = {}): GrantView {
  return {
    id,
    agentId: HERE,
    capability: "repo.read",
    repositoryId: WEB,
    providerConnectionId: null,
    createdAt: AT,
    expiresAt: null,
    expired: false,
    ...overrides,
  };
}

function grantsState(grants: readonly GrantView[], usable = true): GrantsView {
  return { revision: 1, projectId: PROJECT, usable, grants };
}

const CONNECTIONS: ConnectionsPanelView = {
  kind: "known",
  result: {
    outcome: "ok",
    connections: [{ id: CONNECTION, kind: "claude", label: "Work laptop" }],
  },
};

function input(overrides: Partial<GrantSectionInput> = {}): GrantSectionInput {
  return {
    agents: {
      kind: "known",
      state: agentsState([
        agent(HERE, "Builder", { ownedByMe: true, grantableHere: true }),
        agent(SECOND, "Reviewer", { ownedByMe: true, grantableHere: true }),
        agent(ELSEWHERE, "Laptop agent", { ownedByMe: true }),
        agent(THEIRS, "Their agent"),
      ]),
    },
    repositories: { kind: "known", state: REPOSITORIES },
    grants: { kind: "known", state: grantsState([]) },
    connections: CONNECTIONS,
    form: INITIAL_GRANT_FORM,
    now: NOW,
    timeFormat: FORMAT,
    ...overrides,
  };
}

function formOf(view: GrantSectionView) {
  if (view.kind !== "form" || view.form === null) {
    throw new Error("no form");
  }
  return view.form;
}

/** The form with the shell chosen on `web`, and the proposed expiry. */
const SHELL_FORM: GrantFormState = {
  ...INITIAL_GRANT_FORM,
  capability: "terminal.execute",
  scopeId: WEB,
};

function grantsOf(...grants: GrantView[]): GrantsPanelView {
  return { kind: "known", state: grantsState(grants) };
}

/** The form after "Grant" asked for the confirmation of what `form` shows. */
function confirming(
  state: GrantFormState,
  overrides: Partial<GrantSectionInput> = {},
): { readonly state: GrantFormState; readonly form: GrantFormView } {
  const shown = formOf(
    describeGrantSection(input({ ...overrides, form: state })),
  );
  const submission = submitGrant(shown);
  if (submission.kind !== "confirm") {
    throw new Error(`"Grant" did not ask for the confirmation`);
  }
  const next = askConfirmation(state, submission.pending);
  return {
    state: next,
    form: formOf(describeGrantSection(input({ ...overrides, form: next }))),
  };
}

test("the form offers every capability, the standard ones first and terminal.execute last, each with its risk label from CAPABILITY_RISK", () => {
  expect([...OFFERED_CAPABILITIES].sort()).toEqual([...CAPABILITIES].sort());
  expect(OFFERED_CAPABILITIES.at(-1)).toBe("terminal.execute");
  const form = formOf(describeGrantSection(input()));
  expect(form.capabilities).toEqual(
    OFFERED_CAPABILITIES.map((capability) => ({
      capability,
      riskLabel: RISK_LABELS[CAPABILITY_RISK[capability]],
    })),
  );
  expect(
    form.capabilities
      .filter((choice) => choice.riskLabel === RISK_LABELS.highest)
      .map((choice) => choice.capability),
  ).toEqual(["terminal.execute"]);
  // A standard capability: its label and what it allows, and no step of
  // its own.
  expect(form).toMatchObject({
    capability: "repo.read",
    risk: "standard",
    riskLabel: "Standard risk",
    meaning: "Read the files of the repository.",
    details: [],
    needsConfirmation: false,
    confirmation: undefined,
  });

  // The shell: the highest risk, what it allows, and what a shell can do.
  const shell = formOf(describeGrantSection(input({ form: SHELL_FORM })));
  expect(shell).toMatchObject({
    capability: "terminal.execute",
    risk: "highest",
    riskLabel: "Highest risk",
    meaning: "Run a shell that starts in the repository.",
    details: SHELL_STATEMENTS,
    statements: [],
    scopeKind: "repository",
    needsConfirmation: true,
    confirmation: undefined,
  });
});

test("terminal.execute is never preselected and never bundled: the form starts with, and falls back to, a capability that may be preselected", () => {
  expect(preselectableCapabilities(OFFERED_CAPABILITIES)).toEqual(
    OFFERED_CAPABILITIES.filter(
      (capability) => capability !== "terminal.execute",
    ),
  );
  expect(bundleableCapabilities(OFFERED_CAPABILITIES)).not.toContain(
    "terminal.execute",
  );
  expect(bundleableCapabilities(CAPABILITIES)).toEqual(
    CAPABILITIES.filter((capability) => capability !== "terminal.execute"),
  );
  expect(INITIAL_CAPABILITY).toBe("repo.read");
  expect(describeCapability(INITIAL_CAPABILITY).mayBePreselected).toBe(true);
  expect(INITIAL_GRANT_FORM).toEqual({
    agentId: null,
    capability: "repo.read",
    scopeId: null,
    expiryId: null,
    confirming: null,
  });
  expect(formOf(describeGrantSection(input())).capability).toBe("repo.read");
  // A form state that names no offered capability falls back to the first
  // one that may be preselected, never to the shell.
  const unknown = formOf(
    describeGrantSection(
      input({
        form: {
          ...INITIAL_GRANT_FORM,
          capability: "repo.admin" as unknown as "repo.read",
        },
      }),
    ),
  );
  expect(unknown.capability).toBe(INITIAL_CAPABILITY);
});

test("what the form may preselect or bundle follows CAPABILITY_RISK, not a list of its own", async () => {
  vi.resetModules();
  vi.doMock("@mymandev/permissions/capabilities", async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@mymandev/permissions/capabilities")
      >();
    return {
      ...actual,
      CAPABILITY_RISK: Object.freeze({
        ...actual.CAPABILITY_RISK,
        "repo.read": "highest",
      }),
    };
  });
  const model = await import("./grant-view.ts");

  expect(model.INITIAL_CAPABILITY).toBe("repo.write");
  expect(model.OFFERED_CAPABILITIES.slice(-2)).toEqual([
    "repo.read",
    "terminal.execute",
  ]);
  expect(
    model.preselectableCapabilities(model.OFFERED_CAPABILITIES),
  ).not.toContain("repo.read");
  expect(
    model.bundleableCapabilities(model.OFFERED_CAPABILITIES),
  ).not.toContain("repo.read");
  // A capability labelled highest needs the confirmation step too.
  const form = formOf(
    model.describeGrantSection(
      input({
        form: {
          ...model.INITIAL_GRANT_FORM,
          capability: "repo.read",
          scopeId: WEB,
        },
      }),
    ),
  );
  expect(form.needsConfirmation).toBe(true);
  expect(model.submitGrant(form).kind).toBe("confirm");
});

test("each expiry lies within the protocol's bounds, the shell's included, and the shell is offered none without an expiry", () => {
  for (const choice of EXPIRY_CHOICES) {
    if (choice.seconds !== null) {
      expect(choice.seconds).toBeGreaterThanOrEqual(GRANT_LIFETIME_SECONDS.min);
      expect(choice.seconds).toBeLessThanOrEqual(
        SHELL_GRANT_MAX_LIFETIME_SECONDS,
      );
      expect(Number.isInteger(choice.seconds)).toBe(true);
    }
  }
  expect(EXPIRY_CHOICES[0]?.seconds).toBeNull();
  expect(expiryChoices("repo.read")).toEqual(EXPIRY_CHOICES);
  expect(
    expiryChoices("terminal.execute").map((choice) => choice.seconds),
  ).toEqual([3_600, 86_400, 604_800, 2_592_000]);
  expect(new Set(EXPIRY_CHOICES.map((choice) => choice.id)).size).toBe(
    EXPIRY_CHOICES.length,
  );
  expect(
    expiryChoices("terminal.execute").every(
      (choice) =>
        choice.seconds !== null &&
        choice.seconds >= GRANT_LIFETIME_SECONDS.min &&
        choice.seconds <= SHELL_GRANT_MAX_LIFETIME_SECONDS,
    ),
  ).toBe(true);
});

test("the shell is proposed an expiry of 24 hours, which the person can change but not remove; the other capabilities keep an optional expiry and are proposed none", () => {
  expect(proposedExpiryId("terminal.execute")).toBe("day");
  expect(EXPIRY_CHOICES.find((choice) => choice.id === "day")?.seconds).toBe(
    SHELL_PROPOSED_LIFETIME_SECONDS,
  );
  for (const capability of CAPABILITIES) {
    if (capability !== "terminal.execute") {
      expect(proposedExpiryId(capability), capability).toBe(NO_EXPIRY_ID);
      expect(
        formOf(
          describeGrantSection(
            input({ form: { ...INITIAL_GRANT_FORM, capability } }),
          ),
        ).expiryId,
      ).toBe(NO_EXPIRY_ID);
    }
  }
  expect(NO_EXPIRY_ID).toBe(EXPIRY_CHOICES[0]?.id);

  // The shell: the proposed day, no choice without an expiry, and a note.
  const shell = formOf(describeGrantSection(input({ form: SHELL_FORM })));
  expect(shell.expiryId).toBe("day");
  expect(shell.expiries.map((choice) => choice.id)).toEqual([
    "hour",
    "day",
    "week",
    "month",
  ]);
  expect(shell.expiryNote).toBe(GRANT_MESSAGES.shellExpiry);
  expect(grantRequestOf(shell)).toEqual({
    capability: "terminal.execute",
    scopeId: WEB,
    lifetimeSeconds: SHELL_PROPOSED_LIFETIME_SECONDS,
  });
  // The person changes it.
  const week = formOf(
    describeGrantSection(
      input({ form: changeGrantForm(SHELL_FORM, { expiryId: "week" }) }),
    ),
  );
  expect(grantRequestOf(week)?.lifetimeSeconds).toBe(604_800);
  // The person cannot remove it: "none" is not offered, and a state that
  // names it gets the proposed day.
  const none = formOf(
    describeGrantSection(
      input({ form: changeGrantForm(SHELL_FORM, { expiryId: "none" }) }),
    ),
  );
  expect(none.expiryId).toBe("day");
  expect(grantRequestOf(none)?.lifetimeSeconds).toBe(86_400);
  // A view that offers "none" for the shell anyway sends nothing.
  expect(
    grantRequestOf({ ...shell, expiries: EXPIRY_CHOICES, expiryId: "none" }),
  ).toBeNull();
  expect(
    submitGrant({ ...shell, expiries: EXPIRY_CHOICES, expiryId: "none" }),
  ).toEqual({ kind: "none" });
  expect(formOf(describeGrantSection(input())).expiryNote).toBeUndefined();

  // Another capability is proposed none again; the shell its day again.
  const back = changeGrantForm(
    changeGrantForm(SHELL_FORM, { expiryId: "month" }),
    { capability: "repo.read" },
  );
  expect(formOf(describeGrantSection(input({ form: back }))).expiryId).toBe(
    "none",
  );
  const again = changeGrantForm(
    { ...INITIAL_GRANT_FORM, expiryId: "hour" },
    { capability: "terminal.execute" },
  );
  expect(formOf(describeGrantSection(input({ form: again }))).expiryId).toBe(
    "day",
  );
});

test("the shell is granted on its own after a separate confirmation: Grant only asks, and the confirmation sends exactly the grant shown, with confirmedHighestRisk", () => {
  // A standard capability goes at once, without the flag.
  const read = formOf(
    describeGrantSection(
      input({ form: { ...INITIAL_GRANT_FORM, scopeId: WEB } }),
    ),
  );
  expect(submitGrant(read)).toEqual({
    kind: "send",
    agentId: HERE,
    request: { capability: "repo.read", scopeId: WEB, lifetimeSeconds: null },
  });

  // The shell: "Grant" only asks for the confirmation.
  const shell = formOf(describeGrantSection(input({ form: SHELL_FORM })));
  expect(submitGrant(shell)).toEqual({
    kind: "confirm",
    pending: {
      agentId: HERE,
      request: {
        capability: "terminal.execute",
        scopeId: WEB,
        lifetimeSeconds: 86_400,
      },
    },
  });
  // Without the confirmation, nothing would send it.
  expect(confirmedGrantOf(SHELL_FORM, shell)).toBeNull();

  const asked = confirming(SHELL_FORM);
  expect(asked.form.confirmation).toEqual({
    text: HIGHEST_RISK_CONFIRMATIONS["terminal.execute"],
    agent: "Builder",
    scope: "web",
    expiry: "1 day",
    statements: [shellGitStatement(["git.commit", "git.push"])],
    pending: asked.state.confirming,
  });
  // While it waits, "Grant" does nothing.
  expect(submitGrant(asked.form)).toEqual({ kind: "none" });
  expect(confirmedGrantOf(asked.state, asked.form)).toEqual({
    agentId: HERE,
    request: {
      capability: "terminal.execute",
      scopeId: WEB,
      lifetimeSeconds: 86_400,
      confirmedHighestRisk: true,
    },
  });
  // A standard capability never carries the flag.
  expect(
    confirmedGrantOf(
      askConfirmation(
        { ...INITIAL_GRANT_FORM, scopeId: WEB },
        { agentId: HERE, request: grantRequestOf(read)! },
      ),
      read,
    ),
  ).toBeNull();
});

test("cancelling, or changing the agent, the capability, the scope, or the expiry, ends the confirmation, and nothing can be sent for it", () => {
  const asked = confirming(SHELL_FORM);
  const changes = [
    endConfirmation(asked.state),
    changeGrantForm(asked.state, { agentId: SECOND }),
    changeGrantForm(asked.state, { capability: "repo.write" }),
    changeGrantForm(asked.state, { scopeId: API }),
    changeGrantForm(asked.state, { expiryId: "hour" }),
    // Choosing the same values again ends it as well.
    changeGrantForm(asked.state, { agentId: HERE }),
    changeGrantForm(asked.state, { scopeId: WEB }),
    changeGrantForm(asked.state, { expiryId: "day" }),
    changeGrantForm(asked.state, { capability: "terminal.execute" }),
  ];
  for (const state of changes) {
    expect(state.confirming).toBeNull();
    const form = formOf(describeGrantSection(input({ form: state })));
    expect(form.confirmation).toBeUndefined();
    expect(confirmedGrantOf(state, form)).toBeNull();
    // The view that showed the confirmation sends nothing either.
    expect(confirmedGrantOf(state, asked.form)).toBeNull();
  }
  // A grant that the form no longer shows, such as an agent that is no
  // longer grantable here, shows no confirmation.
  const gone = formOf(
    describeGrantSection(
      input({
        form: asked.state,
        agents: {
          kind: "known",
          state: agentsState([
            agent(SECOND, "Reviewer", { ownedByMe: true, grantableHere: true }),
          ]),
        },
      }),
    ),
  );
  expect(gone.confirmation).toBeUndefined();
  expect(confirmedGrantOf(asked.state, gone)).toBeNull();
  // A confirmation of another grant than the view shows sends nothing.
  const other = askConfirmation(SHELL_FORM, {
    agentId: HERE,
    request: {
      capability: "terminal.execute",
      scopeId: API,
      lifetimeSeconds: 86_400,
    },
  });
  expect(confirmedGrantOf(other, asked.form)).toBeNull();
  expect(
    formOf(describeGrantSection(input({ form: other }))).confirmation,
  ).toBeUndefined();
});

test("a confirmation that the section stops showing ends, so it never comes back when the form shows its grant again", () => {
  const asked = confirming(SHELL_FORM);
  const shown = describeGrantSection(input({ form: asked.state }));
  // While it is shown, it waits.
  expect(endHiddenConfirmation(asked.state, shown)).toBe(asked.state);
  // Without a confirmation, nothing changes.
  expect(endHiddenConfirmation(SHELL_FORM, shown)).toBe(SHELL_FORM);

  const hidings: [string, Partial<GrantSectionInput>][] = [
    [
      "the agents are read again",
      {
        agents: {
          kind: "known",
          state: { ...agentsState([]), status: "loading" },
        },
      },
    ],
    ["the agents are not known", { agents: { kind: "pending" } }],
    [
      "the agent is no longer grantable here",
      {
        agents: {
          kind: "known",
          state: agentsState([
            agent(HERE, "Builder", { ownedByMe: true }),
            agent(SECOND, "Reviewer", { ownedByMe: true, grantableHere: true }),
          ]),
        },
      },
    ],
    [
      "no agent is grantable here",
      { agents: { kind: "known", state: agentsState([]) } },
    ],
    [
      "the scope is gone",
      {
        repositories: {
          kind: "known",
          state: {
            ...REPOSITORIES,
            repositories: REPOSITORIES.repositories.filter(
              (repository) => repository.repositoryId !== WEB,
            ),
          },
        },
      },
    ],
    ["the repositories are not known", { repositories: { kind: "pending" } }],
  ];
  for (const [label, hiding] of hidings) {
    const hidden = describeGrantSection(
      input({ ...hiding, form: asked.state }),
    );
    expect(
      hidden.kind === "form" ? hidden.form?.confirmation : undefined,
      label,
    ).toBeUndefined();
    // Kept, it would come back with the form's grant.
    expect(
      formOf(describeGrantSection(input({ form: asked.state }))).confirmation,
      label,
    ).toBeDefined();
    const ended = endHiddenConfirmation(asked.state, hidden);
    expect(ended, label).toEqual({ ...asked.state, confirming: null });
    const back = formOf(describeGrantSection(input({ form: ended })));
    expect(back.confirmation, label).toBeUndefined();
    expect(confirmedGrantOf(ended, asked.form), label).toBeNull();
    // The person's choices stay.
    expect(back.capability, label).toBe("terminal.execute");
    expect(back.scopeId, label).toBe(WEB);
  }
});

test("the confirmation says that the shell can still commit and push only while the agent lacks git.commit or git.push on the repository, from its current grants", () => {
  const commit = grant(GRANT_1, { capability: "git.commit" });
  const push = grant(GRANT_2, { capability: "git.push" });
  const statementsWith = (grants: GrantsPanelView) =>
    confirming(SHELL_FORM, { grants }).form.confirmation?.statements;

  expect(statementsWith(grantsOf())).toEqual([
    shellGitStatement(["git.commit", "git.push"]),
  ]);
  expect(statementsWith(grantsOf(commit))).toEqual([
    shellGitStatement(["git.push"]),
  ]);
  expect(statementsWith(grantsOf(push))).toEqual([
    shellGitStatement(["git.commit"]),
  ]);
  // Both granted on this repository: nothing to say.
  expect(statementsWith(grantsOf(commit, push))).toEqual([]);
  // An expired grant, a grant on another repository, and a grant of
  // another agent do not count.
  for (const grants of [
    grantsOf(commit, { ...push, expired: true }),
    grantsOf(commit, { ...push, expiresAt: "2026-11-24T11:00:00.000Z" }),
    grantsOf(commit, { ...push, repositoryId: API }),
    grantsOf(commit, { ...push, agentId: SECOND }),
  ]) {
    expect(statementsWith(grants)).toEqual([shellGitStatement(["git.push"])]);
  }
  // Without the agent's grants, it is said without naming them.
  for (const grants of [
    { kind: "pending" } as const,
    { kind: "unavailable" } as const,
    { kind: "known", state: grantsState([commit, push], false) } as const,
  ]) {
    expect(statementsWith(grants)).toEqual([shellGitStatement("unknown")]);
    expect(missingShellGitCapabilities(grants, HERE, WEB, NOW)).toBe("unknown");
  }
  expect(
    missingShellGitCapabilities(grantsOf(commit, push), HERE, WEB, NOW),
  ).toEqual([]);
});

test("an active shell grant in the list says that the shell can still commit and push while the agent lacks git.commit or git.push on its repository", () => {
  const shell = grant(GRANT_1, {
    capability: "terminal.execute",
    expiresAt: "2026-11-25T12:00:00.000Z",
  });
  const statementsOf = (...grants: GrantView[]) => {
    const view = describeGrantSection(input({ grants: grantsOf(...grants) }));
    if (view.kind !== "form") {
      throw new Error("no form");
    }
    return Object.fromEntries(
      view.grants.map((item) => [item.grantId, item.statements]),
    );
  };

  expect(statementsOf(shell)).toEqual({
    [GRANT_1]: [shellGitStatement(["git.commit", "git.push"])],
  });
  expect(
    statementsOf(shell, grant(GRANT_2, { capability: "git.commit" })),
  ).toEqual({
    [GRANT_1]: [shellGitStatement(["git.push"])],
    [GRANT_2]: [],
  });
  expect(
    statementsOf(
      shell,
      grant(GRANT_2, { capability: "git.commit" }),
      grant(GRANT_3, { capability: "git.push" }),
    ),
  ).toEqual({ [GRANT_1]: [], [GRANT_2]: [], [GRANT_3]: [] });
  // A shell grant on another repository is judged by that repository.
  expect(
    statementsOf(
      { ...shell, repositoryId: API },
      grant(GRANT_2, { capability: "git.commit" }),
      grant(GRANT_3, { capability: "git.push" }),
    )[GRANT_1],
  ).toEqual([shellGitStatement(["git.commit", "git.push"])]);
  // An expired shell grant is not granted: nothing to say.
  expect(
    statementsOf({ ...shell, expiresAt: "2026-11-24T11:00:00.000Z" }),
  ).toEqual({ [GRANT_1]: [] });
});

test("the form says that repo.read with provider.use sends the repository's content to the provider wherever either is chosen, as a statement and not a check", () => {
  for (const capability of CAPABILITIES) {
    const form = formOf(
      describeGrantSection(
        input({ form: { ...INITIAL_GRANT_FORM, capability } }),
      ),
    );
    expect(form.statements, capability).toEqual(
      capability === "repo.read" || capability === "provider.use"
        ? [REPOSITORY_PROVIDER_STATEMENT]
        : [],
    );
  }
  // Whatever the agent holds: it is said, never checked.
  for (const grants of [
    grantsOf(),
    grantsOf(
      grant(GRANT_1, {
        capability: "provider.use",
        repositoryId: null,
        providerConnectionId: CONNECTION,
      }),
    ),
    { kind: "pending" } as const,
  ]) {
    expect(formOf(describeGrantSection(input({ grants }))).statements).toEqual([
      REPOSITORY_PROVIDER_STATEMENT,
    ]);
  }
});

test("only the agents that this device may grant for are offered; the owner's other devices and other members' agents never are", () => {
  const form = formOf(describeGrantSection(input()));
  expect(form.agents).toEqual([
    { id: HERE, label: "Builder" },
    { id: SECOND, label: "Reviewer" },
  ]);
  expect(form.agentId).toBe(HERE);
  // A chosen agent that is no longer grantable here falls back.
  expect(
    formOf(
      describeGrantSection(
        input({ form: { ...INITIAL_GRANT_FORM, agentId: ELSEWHERE } }),
      ),
    ).agentId,
  ).toBe(HERE);
  expect(
    formOf(
      describeGrantSection(
        input({ form: { ...INITIAL_GRANT_FORM, agentId: SECOND } }),
      ),
    ).agentId,
  ).toBe(SECOND);

  // On another device of the owner, or for another member: no form at all.
  for (const agents of [
    [agent(ELSEWHERE, "Laptop agent", { ownedByMe: true })],
    [agent(THEIRS, "Their agent")],
    [],
  ]) {
    expect(
      describeGrantSection(
        input({ agents: { kind: "known", state: agentsState(agents) } }),
      ),
    ).toEqual({
      kind: "form",
      form: null,
      notes: [GRANT_MESSAGES.noGrantableAgent],
      grants: [],
      grantsNote: undefined,
    });
  }
});

test("the section waits for the agents, and says when granting is not available or no project is open", () => {
  expect(
    describeGrantSection(input({ agents: { kind: "unavailable" } })),
  ).toEqual({ kind: "message", text: GRANT_MESSAGES.unavailable });
  expect(describeGrantSection(input({ agents: { kind: "pending" } }))).toEqual({
    kind: "message",
    text: GRANT_MESSAGES.pending,
  });
  expect(
    describeGrantSection(
      input({
        agents: {
          kind: "known",
          state: { ...agentsState([]), status: "no_project", projectId: null },
        },
      }),
    ),
  ).toEqual({ kind: "message", text: GRANT_MESSAGES.noProject });
  expect(
    describeGrantSection(
      input({
        agents: {
          kind: "known",
          state: { ...agentsState([]), status: "loading" },
        },
      }),
    ),
  ).toEqual({ kind: "message", text: GRANT_MESSAGES.pending });
});

test("the provider connections are needed only while an agent of the open project is grantable here", () => {
  const known = (agents: readonly AgentView[]) =>
    ({ kind: "known", state: agentsState(agents) }) as const;
  expect(needsProviderConnections({ kind: "unavailable" })).toBe(false);
  expect(needsProviderConnections({ kind: "pending" })).toBe(false);
  expect(needsProviderConnections(known([]))).toBe(false);
  expect(
    needsProviderConnections(
      known([
        agent(ELSEWHERE, "Laptop agent", { ownedByMe: true }),
        agent(THEIRS, "Their agent"),
      ]),
    ),
  ).toBe(false);
  expect(
    needsProviderConnections(
      known([
        agent(THEIRS, "Their agent"),
        agent(HERE, "Builder", { ownedByMe: true, grantableHere: true }),
      ]),
    ),
  ).toBe(true);
  expect(
    needsProviderConnections({
      kind: "known",
      state: {
        ...agentsState([
          agent(HERE, "Builder", { ownedByMe: true, grantableHere: true }),
        ]),
        status: "no_project",
        projectId: null,
      },
    }),
  ).toBe(false);
});

test("when the agents could not be read, the section says that it cannot check now, not that no agent is hosted here", () => {
  const unavailable = (agents: readonly AgentView[]) =>
    describeGrantSection(
      input({
        agents: {
          kind: "known",
          state: {
            ...agentsState(agents),
            status: "unavailable",
            problem: "unavailable",
          },
        },
      }),
    );
  const unknown = {
    kind: "form",
    form: null,
    notes: [GRANT_MESSAGES.agentsUnknown],
    grants: [],
    grantsNote: undefined,
  };
  expect(unavailable([])).toEqual(unknown);
  expect(unavailable([agent(THEIRS, "Their agent")])).toEqual(unknown);
  expect(GRANT_MESSAGES.agentsUnknown).not.toBe(
    GRANT_MESSAGES.noGrantableAgent,
  );
  // Agents read before the failure that are grantable here keep the form;
  // the server still decides each grant.
  expect(
    formOf(
      unavailable([
        agent(HERE, "Builder", { ownedByMe: true, grantableHere: true }),
      ]),
    ).agentId,
  ).toBe(HERE);
  // A list that was read says that no agent is hosted here.
  expect(
    describeGrantSection(
      input({
        agents: {
          kind: "known",
          state: agentsState([agent(THEIRS, "Their agent")]),
        },
      }),
    ),
  ).toEqual({ ...unknown, notes: [GRANT_MESSAGES.noGrantableAgent] });
});

test("a repository capability offers the project's repositories, and provider.use this device's connections, each chosen by the person", () => {
  const form = formOf(describeGrantSection(input()));
  expect(form.scopeKind).toBe("repository");
  expect(form.scopes).toEqual([
    { id: WEB, label: "web" },
    { id: API, label: "api" },
  ]);
  // No scope is chosen before the person does.
  expect(form.scopeId).toBeNull();
  expect(form.ready).toBe(false);
  expect(grantRequestOf(form)).toBeNull();

  const chosen = formOf(
    describeGrantSection(
      input({ form: { ...INITIAL_GRANT_FORM, scopeId: API, expiryId: "day" } }),
    ),
  );
  expect(chosen.ready).toBe(true);
  expect(grantRequestOf(chosen)).toEqual({
    capability: "repo.read",
    scopeId: API,
    lifetimeSeconds: 86_400,
  });

  const provider = formOf(
    describeGrantSection(
      input({
        form: {
          ...INITIAL_GRANT_FORM,
          capability: "provider.use",
          // A repository is not a scope of provider.use.
          scopeId: API,
        },
      }),
    ),
  );
  expect(provider.scopeKind).toBe("provider_connection");
  expect(provider.scopes).toEqual([{ id: CONNECTION, label: "Work laptop" }]);
  expect(provider.scopeId).toBeNull();
  expect(
    grantRequestOf(
      formOf(
        describeGrantSection(
          input({
            form: {
              ...INITIAL_GRANT_FORM,
              capability: "provider.use",
              scopeId: CONNECTION,
              expiryId: "not-a-choice",
            },
          }),
        ),
      ),
    ),
  ).toEqual({
    capability: "provider.use",
    scopeId: CONNECTION,
    lifetimeSeconds: null,
  });
});

test("the form says why no scope can be chosen", () => {
  const providerForm = {
    ...INITIAL_GRANT_FORM,
    capability: "provider.use" as const,
  };
  const note = (overrides: Partial<GrantSectionInput>) =>
    formOf(describeGrantSection(input(overrides))).scopeNote;
  expect(note({})).toBeUndefined();
  expect(
    note({
      repositories: {
        kind: "known",
        state: { ...REPOSITORIES, repositories: [] },
      },
    }),
  ).toBe(GRANT_MESSAGES.noRepositories);
  expect(note({ repositories: { kind: "pending" } })).toBe(
    GRANT_MESSAGES.repositoriesUnknown,
  );
  expect(note({ form: providerForm, connections: { kind: "pending" } })).toBe(
    GRANT_MESSAGES.connectionsPending,
  );
  expect(
    note({
      form: providerForm,
      connections: {
        kind: "known",
        result: { outcome: "ok", connections: [] },
      },
    }),
  ).toBe(GRANT_MESSAGES.noConnections);
  for (const reason of Object.keys(CONNECTION_PROBLEM_MESSAGES) as (
    "not_signed_in" | "rate_limited" | "unavailable" | "failed"
  )[]) {
    expect(
      note({
        form: providerForm,
        connections: { kind: "known", result: { outcome: "refused", reason } },
      }),
    ).toBe(CONNECTION_PROBLEM_MESSAGES[reason]);
  }
});

test("the list holds the selected agent's grants with their scope and expiry, and says when they cannot be shown", () => {
  const view = describeGrantSection(
    input({
      grants: {
        kind: "known",
        state: grantsState([
          grant(GRANT_1),
          grant(GRANT_2, {
            capability: "provider.use",
            repositoryId: null,
            providerConnectionId: CONNECTION,
            expiresAt: "2026-11-25T12:00:00.000Z",
          }),
          grant(GRANT_3, {
            repositoryId: "0192f2a0-7c3e-7a1b-8c4d-5e6f70819299",
            expiresAt: "2026-11-24T12:00:00.000Z",
          }),
          grant("0192f2a0-7c3e-7a1b-8c4d-5e6f70819404", { agentId: SECOND }),
        ]),
      },
    }),
  );
  if (view.kind !== "form") {
    throw new Error("no form");
  }
  expect(view.grants).toEqual([
    {
      grantId: GRANT_1,
      capability: "repo.read",
      scope: "web",
      expiry: GRANT_MESSAGES.neverExpires,
      expired: false,
      statements: [],
    },
    {
      grantId: GRANT_2,
      capability: "provider.use",
      scope: "Work laptop",
      expiry: `Expires ${FORMAT.format(new Date("2026-11-25T12:00:00.000Z"))}`,
      expired: false,
      statements: [],
    },
    {
      // Expired at its time, by the screen's clock too.
      grantId: GRANT_3,
      capability: "repo.read",
      scope: GRANT_MESSAGES.unknownRepository,
      expiry: `Expired ${FORMAT.format(new Date("2026-11-24T12:00:00.000Z"))}`,
      expired: true,
      statements: [],
    },
  ]);
  expect(view.grantsNote).toBeUndefined();

  const none = describeGrantSection(input());
  expect(none.kind === "form" && none.grantsNote).toBe(GRANT_MESSAGES.noGrants);
  for (const grants of [
    { kind: "pending" } as const,
    { kind: "unavailable" } as const,
    { kind: "known", state: grantsState([grant(GRANT_1)], false) } as const,
  ]) {
    const unusable = describeGrantSection(input({ grants }));
    expect(unusable.kind === "form" && unusable.grantsNote).toBe(
      GRANT_MESSAGES.grantsUnavailable,
    );
    expect(unusable.kind === "form" && unusable.grants).toEqual([]);
  }
});

test("every refusal of a grant and a revocation has its sentence, every code of the grant routes its own, and a wait names its time", () => {
  for (const reason of GRANT_CAPABILITY_REFUSALS) {
    const text = describeGrantResult({
      outcome: "refused",
      reason,
      retryAfterMs:
        reason === "too_soon" || reason === "rate_limited" ? 90_000 : null,
    });
    expect(text, reason).toMatch(
      /^The permission was not granted\. [A-Z].*\.$/,
    );
  }
  for (const reason of REVOKE_GRANT_REFUSALS) {
    const text = describeRevokeResult({
      outcome: "refused",
      reason,
      retryAfterMs:
        reason === "too_soon" || reason === "rate_limited" ? 90_000 : null,
    });
    expect(text, reason).toMatch(
      /^The permission was not revoked\. [A-Z].*\.$/,
    );
  }
  // The codes of the routes beyond the common ones have their own sentence.
  const common = [
    "bad_request",
    "unauthorized",
    "rate_limited",
    "internal_error",
  ];
  for (const code of GRANT_ROUTE_ERRORS.grantCapability) {
    if (!common.includes(code)) {
      expect(Object.hasOwn(GRANT_REFUSAL_MESSAGES, code), code).toBe(true);
    }
  }
  for (const code of GRANT_ROUTE_ERRORS.revokeGrant) {
    if (!common.includes(code)) {
      expect(Object.hasOwn(REVOKE_REFUSAL_MESSAGES, code), code).toBe(true);
    }
  }
  expect(
    describeGrantResult({
      outcome: "refused",
      reason: "rate_limited",
      retryAfterMs: 90_000,
    }),
  ).toBe(
    "The permission was not granted. The server asked to wait: too many requests, or too many permissions granted in 24 hours. Try again in 2 minutes.",
  );
  expect(
    describeGrantResult({
      outcome: "refused",
      reason: "grant_limit",
      retryAfterMs: null,
    }),
  ).toBe(
    "The permission was not granted. The agent or this device has as many permissions as it may have. Revoke one first.",
  );
  expect(describeGrantResult({ outcome: "ok", grantId: GRANT_1 })).toBe(
    GRANT_RESULT_MESSAGES.granted,
  );
  expect(describeGrantResult({ outcome: "unknown" })).toBe(
    GRANT_RESULT_MESSAGES.grantUnknown,
  );
  expect(describeRevokeResult({ outcome: "ok" })).toBe(
    GRANT_RESULT_MESSAGES.revoked,
  );
  expect(describeRevokeResult({ outcome: "unknown" })).toBe(
    GRANT_RESULT_MESSAGES.revokeUnknown,
  );
});

test("the actions run one at a time and say how each went, also when the bridge fails", async () => {
  const views: GrantActionsView[] = [];
  let resolveGrant: (result: GrantCapabilityResult) => void = () => undefined;
  const calls: unknown[][] = [];
  const actions = createGrantActions(
    {
      grant: (...args) => {
        calls.push(["grant", ...args]);
        return new Promise((resolve) => {
          resolveGrant = resolve;
        });
      },
      revoke: (...args) => {
        calls.push(["revoke", ...args]);
        return Promise.reject(new Error("refused"));
      },
    },
    (view) => views.push(view),
  );
  const request = {
    capability: "repo.read" as const,
    scopeId: WEB,
    lifetimeSeconds: null,
  };
  const first = actions.grant(HERE, request);
  // A second action while the first waits sends nothing.
  await actions.revoke(HERE, GRANT_1);
  expect(calls).toEqual([["grant", HERE, request]]);
  resolveGrant({ outcome: "refused", reason: "conflict", retryAfterMs: null });
  await first;
  await actions.revoke(HERE, GRANT_1);
  expect(views).toEqual([
    { running: true, message: undefined },
    {
      running: false,
      message: `${GRANT_RESULT_MESSAGES.notGranted} ${GRANT_REFUSAL_MESSAGES.conflict}`,
    },
    { running: true, message: undefined },
    {
      running: false,
      message: `${GRANT_RESULT_MESSAGES.notRevoked} ${GRANT_RESULT_MESSAGES.notSent}`,
    },
  ]);
  const revoked: RevokeGrantResult = { outcome: "ok" };
  expect(describeRevokeResult(revoked)).toBe("The permission was revoked.");
});
