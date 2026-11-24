import {
  CAPABILITY_RISK,
  CAPABILITY_RISKS,
  CAPABILITY_SCOPE,
  GRANT_SCOPE_KINDS,
} from "@mymandev/permissions/capabilities";
import {
  CAPABILITIES,
  GRANT_LIFETIME_SECONDS,
  SHELL_GRANT_MAX_LIFETIME_SECONDS,
} from "@mymandev/protocol";
import { afterEach, expect, test, vi } from "vitest";
import {
  CAPABILITY_MEANINGS,
  describeCapabilitiesInOfferOrder,
  describeCapability,
  describePermissionScreen,
  grantStatements,
  HIGHEST_RISK_CONFIRMATIONS,
  HIGHEST_RISK_FALLBACK_CONFIRMATION,
  REPOSITORY_PROVIDER_STATEMENT,
  RISK_LABELS,
  SCOPE_TEXTS,
  SCREEN_STATEMENTS,
  SHELL_GIT_CAPABILITIES,
  SHELL_PROPOSED_LIFETIME_SECONDS,
  SHELL_STATEMENTS,
  shellGitStatement,
  type CapabilityView,
  type PermissionCapability,
  type Statement,
} from "./permission-view.ts";

afterEach(() => {
  vi.doUnmock("@mymandev/permissions/capabilities");
  vi.resetModules();
});

/** The text of a statement, with capability names as plain text. */
function textOf(statement: Statement): string {
  return statement
    .map((part) =>
      typeof part === "string"
        ? part
        : "capability" in part
          ? part.capability
          : part.command,
    )
    .join("");
}

function allCapabilities(): CapabilityView[] {
  return describePermissionScreen().groups.flatMap(
    (group) => group.capabilities,
  );
}

function viewOf(capability: PermissionCapability): CapabilityView {
  const view = allCapabilities().find(
    (candidate) => candidate.capability === capability,
  );
  if (view === undefined) {
    throw new Error(`The screen does not show ${capability}.`);
  }
  return view;
}

test("the screen shows every capability of the contract once, and nothing else", () => {
  const shown = allCapabilities().map((view) => view.capability);

  expect([...shown].sort()).toEqual([...CAPABILITIES].sort());
  expect(Object.keys(CAPABILITY_RISK)).toEqual([...CAPABILITIES]);
});

test("every capability, risk label, and scope kind has its text, and every text is a sentence", () => {
  expect(Object.keys(CAPABILITY_MEANINGS).sort()).toEqual(
    [...CAPABILITIES].sort(),
  );
  expect(Object.keys(RISK_LABELS).sort()).toEqual([...CAPABILITY_RISKS].sort());
  expect(Object.keys(SCOPE_TEXTS).sort()).toEqual(
    [...GRANT_SCOPE_KINDS].sort(),
  );
  for (const text of [
    ...Object.values(CAPABILITY_MEANINGS),
    ...Object.values(SCOPE_TEXTS).map((scope) => scope.text),
    ...Object.values(HIGHEST_RISK_CONFIRMATIONS),
    ...SCREEN_STATEMENTS.map(textOf),
    ...SHELL_STATEMENTS.map(textOf),
  ]) {
    expect(text).toMatch(/^[A-Z].*[.?]$/s);
  }
});

test("the capabilities are grouped by their scope kind from CAPABILITY_SCOPE, in the order of GRANT_SCOPE_KINDS", () => {
  const { groups } = describePermissionScreen();

  expect(groups.map((group) => group.scope)).toEqual([...GRANT_SCOPE_KINDS]);
  for (const group of groups) {
    expect(group.title).toBe(SCOPE_TEXTS[group.scope].title);
    expect(group.text).toBe(SCOPE_TEXTS[group.scope].text);
    for (const view of group.capabilities) {
      expect(view.scope).toBe(CAPABILITY_SCOPE[view.capability]);
      expect(view.scope).toBe(group.scope);
    }
  }
  expect(
    groups.map((group) => [
      group.scope,
      group.capabilities.map((view) => view.capability),
    ]),
  ).toEqual([
    [
      "repository",
      ["repo.read", "repo.write", "git.commit", "git.push", "terminal.execute"],
    ],
    ["provider_connection", ["provider.use"]],
  ]);
});

test("each risk label is read from CAPABILITY_RISK, and terminal.execute alone is shown as the highest risk", () => {
  for (const view of allCapabilities()) {
    expect(view.risk).toBe(CAPABILITY_RISK[view.capability]);
    expect(view.riskLabel).toBe(RISK_LABELS[CAPABILITY_RISK[view.capability]]);
  }
  expect(
    allCapabilities()
      .filter((view) => view.riskLabel === RISK_LABELS.highest)
      .map((view) => view.capability),
  ).toEqual(["terminal.execute"]);
  expect(RISK_LABELS).toEqual({
    standard: "Standard risk",
    highest: "Highest risk",
  });
});

test("the screen follows CAPABILITY_RISK, not a list of its own", async () => {
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
        "terminal.execute": "standard",
        "repo.read": "highest",
      }),
    };
  });
  const model = await import("./permission-view.ts");
  const views = model
    .describePermissionScreen()
    .groups.flatMap((group) => group.capabilities);
  const byName = new Map(views.map((view) => [view.capability, view]));

  expect(byName.get("repo.read")).toMatchObject({
    risk: "highest",
    riskLabel: "Highest risk",
    mayBePreselected: false,
    mayBeBundled: false,
  });
  expect(byName.get("terminal.execute")).toMatchObject({
    risk: "standard",
    riskLabel: "Standard risk",
    mayBePreselected: true,
    mayBeBundled: true,
    confirmation: undefined,
  });
  // A capability that the table labels highest is confirmed on its own,
  // also without a text of its own.
  expect(byName.get("repo.read")?.confirmation).toBe(
    model.HIGHEST_RISK_FALLBACK_CONFIRMATION,
  );
  expect(
    model.describeCapabilitiesInOfferOrder().map((view) => view.capability),
  ).toEqual([
    "repo.write",
    "terminal.execute",
    "git.commit",
    "git.push",
    "provider.use",
    "repo.read",
  ]);
  // The highest-risk capability is listed last in its group.
  expect(views.map((view) => view.capability)).toEqual([
    "repo.write",
    "terminal.execute",
    "git.commit",
    "git.push",
    "repo.read",
    "provider.use",
  ]);
});

test("terminal.execute is never preselected and never part of a bundle or a select all", () => {
  expect(viewOf("terminal.execute")).toMatchObject({
    mayBePreselected: false,
    mayBeBundled: false,
  });
  for (const view of allCapabilities()) {
    if (view.risk === "highest") {
      expect(view.mayBePreselected).toBe(false);
      expect(view.mayBeBundled).toBe(false);
    }
  }
  expect(
    allCapabilities()
      .filter((view) => view.mayBeBundled)
      .map((view) => view.capability),
  ).not.toContain("terminal.execute");
});

test("terminal.execute has its own explicit confirmation, and no other capability has one", () => {
  const confirmation = viewOf("terminal.execute").confirmation;

  expect(confirmation).toBe(HIGHEST_RISK_CONFIRMATIONS["terminal.execute"]);
  expect(confirmation).toBe(
    "Allow this agent to run a shell in this repository? The shell runs as the user of the agent's device and is not limited to the repository: it can read and change files outside the repository, use the network, commit and push, and read the credentials stored for that user, including local AI provider credentials.",
  );
  expect(
    allCapabilities()
      .filter((view) => view.confirmation !== undefined)
      .map((view) => view.capability),
  ).toEqual(["terminal.execute"]);
  expect(Object.keys(HIGHEST_RISK_CONFIRMATIONS)).toEqual(["terminal.execute"]);
});

test("terminal.execute says what a shell can do, and nothing that depends on the agent's grants", () => {
  const details = viewOf("terminal.execute").details;

  expect(details).toBe(SHELL_STATEMENTS);
  expect(details.map(textOf)).toEqual([
    "A shell runs as the user of the agent's device. The repository is only where it starts: it is not a sandbox.",
    "A shell can read and change files outside the repository, use the network, run git commit and git push, and read the credentials stored for that user, including local AI provider credentials.",
    "So a shell can send files and those credentials over the network.",
  ]);
  // The commands are code, like the capability names.
  expect(details[1]).toContainEqual({ command: "git commit" });
  expect(details[1]).toContainEqual({ command: "git push" });
  for (const view of allCapabilities()) {
    if (view.capability !== "terminal.execute") {
      expect(view.details).toEqual([]);
    }
  }
});

test("that the shell can still commit and push is said only while the agent lacks git.commit or git.push on the repository, naming the ones it lacks", () => {
  expect(SHELL_GIT_CAPABILITIES).toEqual(["git.commit", "git.push"]);
  expect(shellGitStatement([])).toBeUndefined();
  expect(shellGitStatement(["git.commit", "git.push"])).toEqual([
    "This agent has neither ",
    { capability: "git.commit" },
    " nor ",
    { capability: "git.push" },
    " on this repository, but the shell can still commit and push.",
  ]);
  // The order of the contract, whatever the order of the list.
  expect(shellGitStatement(["git.push", "git.commit"])).toEqual(
    shellGitStatement(["git.commit", "git.push"]),
  );
  expect(textOf(shellGitStatement(["git.commit"])!)).toBe(
    "This agent does not have git.commit on this repository, but the shell can still commit and push.",
  );
  expect(textOf(shellGitStatement(["git.push"])!)).toBe(
    "This agent does not have git.push on this repository, but the shell can still commit and push.",
  );
  // Without the agent's grants, it is said without naming them.
  expect(textOf(shellGitStatement("unknown")!)).toBe(
    "A shell can commit and push even without git.commit or git.push.",
  );
});

test("the proposed expiry of the shell is 24 hours, within the protocol's bounds of a shell grant", () => {
  expect(SHELL_PROPOSED_LIFETIME_SECONDS).toBe(24 * 60 * 60);
  expect(SHELL_PROPOSED_LIFETIME_SECONDS).toBeGreaterThanOrEqual(
    GRANT_LIFETIME_SECONDS.min,
  );
  expect(SHELL_PROPOSED_LIFETIME_SECONDS).toBeLessThanOrEqual(
    SHELL_GRANT_MAX_LIFETIME_SECONDS,
  );
});

test("the grant form says that repo.read with provider.use sends the repository's content to the provider wherever either is chosen, and nowhere else", () => {
  expect(grantStatements("repo.read")).toEqual([REPOSITORY_PROVIDER_STATEMENT]);
  expect(grantStatements("provider.use")).toEqual([
    REPOSITORY_PROVIDER_STATEMENT,
  ]);
  for (const capability of CAPABILITIES) {
    if (capability !== "repo.read" && capability !== "provider.use") {
      expect(grantStatements(capability), capability).toEqual([]);
    }
  }
  expect(SCREEN_STATEMENTS).toContain(REPOSITORY_PROVIDER_STATEMENT);
});

test("a list of capabilities offers the standard ones in the contract's order and the highest-risk one last", () => {
  expect(
    describeCapabilitiesInOfferOrder().map((view) => view.capability),
  ).toEqual([
    "repo.read",
    "repo.write",
    "git.commit",
    "git.push",
    "provider.use",
    "terminal.execute",
  ]);
  expect(HIGHEST_RISK_FALLBACK_CONFIRMATION).toMatch(/\?/);
});

test("the screen says that repo.read with provider.use sends the repository's content to the provider, and that no permission includes another for a check but can allow more than its name", () => {
  const statements = describePermissionScreen().statements;

  expect(statements).toBe(SCREEN_STATEMENTS);
  expect(statements.map(textOf)).toEqual([
    "Permissions belong to one agent of this project, and only the agent's owner grants them.",
    "Each permission is checked on its own: for a check, none includes another, so repo.write does not include repo.read, and git.push does not include git.commit. A permission can still let the agent do more than its name says: see terminal.execute.",
    "With repo.read on a repository and provider.use on an AI provider connection, the agent can send that repository's content to that connection's provider.",
  ]);
  expect(statements[2]).toEqual([
    "With ",
    { capability: "repo.read" },
    " on a repository and ",
    { capability: "provider.use" },
    " on an AI provider connection, the agent can send that repository's content to that connection's provider.",
  ]);
});

test("the reference part says nothing about granting, which the grant section does (#342)", () => {
  expect(Object.keys(describePermissionScreen()).sort()).toEqual([
    "groups",
    "statements",
  ]);
});

test("each capability says what it allows", () => {
  expect(
    Object.fromEntries(
      allCapabilities().map((view) => [view.capability, view.meaning]),
    ),
  ).toEqual({
    "repo.read": "Read the files of the repository.",
    "repo.write": "Change the files of the repository.",
    "terminal.execute": "Run a shell that starts in the repository.",
    "git.commit": "Create commits in the repository.",
    "git.push": "Push commits from the repository to its remotes.",
    "provider.use":
      "Send requests to the AI provider of the connection, with the connection's credentials on the agent's device.",
  });
  expect(describeCapability("repo.read")).toEqual(viewOf("repo.read"));
});

test("the model is plain data that does not change between calls", () => {
  const first = describePermissionScreen();

  expect(describePermissionScreen()).toEqual(first);
  expect(Object.isFrozen(SCREEN_STATEMENTS)).toBe(true);
  expect(Object.isFrozen(SHELL_STATEMENTS)).toBe(true);
  expect(Object.isFrozen(HIGHEST_RISK_CONFIRMATIONS)).toBe(true);
  expect(JSON.parse(JSON.stringify(first))).toEqual(first);
});
