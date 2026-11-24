import {
  CAPABILITIES,
  GRANT_LIFETIME_SECONDS,
  GRANT_ROUTE_ERRORS,
  SHELL_GRANT_MAX_LIFETIME_SECONDS,
} from "@mymandev/protocol";
import { expect, test } from "vitest";
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
  CONNECTION_PROBLEM_MESSAGES,
  createGrantActions,
  describeGrantResult,
  describeGrantSection,
  describeRevokeResult,
  EXPIRY_CHOICES,
  expiryChoices,
  GRANT_MESSAGES,
  GRANT_REFUSAL_MESSAGES,
  GRANT_RESULT_MESSAGES,
  grantRequestOf,
  INITIAL_GRANT_FORM,
  OFFERED_CAPABILITIES,
  REVOKE_REFUSAL_MESSAGES,
  type ConnectionsPanelView,
  type GrantActionsView,
  type GrantSectionInput,
  type GrantSectionView,
} from "./grant-view.ts";

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

test("the form offers every capability but the highest-risk one, terminal.execute, which waits for #77", () => {
  expect([...OFFERED_CAPABILITIES]).toEqual(
    CAPABILITIES.filter((capability) => capability !== "terminal.execute"),
  );
  const form = formOf(describeGrantSection(input()));
  expect(form.capabilities).not.toContain("terminal.execute");
  // A form state that names the shell falls back to the first choice.
  const shell = formOf(
    describeGrantSection(
      input({
        form: { ...INITIAL_GRANT_FORM, capability: "terminal.execute" },
      }),
    ),
  );
  expect(shell.capability).toBe("repo.read");
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
    },
    {
      grantId: GRANT_2,
      capability: "provider.use",
      scope: "Work laptop",
      expiry: `Expires ${FORMAT.format(new Date("2026-11-25T12:00:00.000Z"))}`,
      expired: false,
    },
    {
      // Expired at its time, by the screen's clock too.
      grantId: GRANT_3,
      capability: "repo.read",
      scope: GRANT_MESSAGES.unknownRepository,
      expiry: `Expired ${FORMAT.format(new Date("2026-11-24T12:00:00.000Z"))}`,
      expired: true,
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
