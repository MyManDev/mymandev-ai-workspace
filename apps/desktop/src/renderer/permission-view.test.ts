import {
  CAPABILITY_RISK,
  CAPABILITY_RISKS,
  CAPABILITY_SCOPE,
  GRANT_SCOPE_KINDS,
} from "@mymandev/permissions/capabilities";
import { CAPABILITIES } from "@mymandev/protocol";
import { afterEach, expect, test, vi } from "vitest";
import {
  CAPABILITY_MEANINGS,
  describeCapability,
  describePermissionScreen,
  GRANTING_UNAVAILABLE,
  HIGHEST_RISK_CONFIRMATIONS,
  RISK_LABELS,
  SCOPE_TEXTS,
  SCREEN_STATEMENTS,
  SHELL_STATEMENTS,
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
    GRANTING_UNAVAILABLE,
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

test("terminal.execute says what a shell can do, and that it can commit and push without git.commit or git.push", () => {
  const details = viewOf("terminal.execute").details;

  expect(details).toBe(SHELL_STATEMENTS);
  expect(details.map(textOf)).toEqual([
    "A shell runs as the user of the agent's device. The repository is only where it starts: it is not a sandbox.",
    "A shell can read and change files outside the repository, use the network, run git commit and git push, and read the credentials stored for that user, including local AI provider credentials.",
    "So a shell can send files and those credentials over the network.",
    "A shell can commit and push even without git.commit or git.push.",
  ]);
  // The commands are code, like the capability names.
  expect(details[1]).toContainEqual({ command: "git commit" });
  expect(details[1]).toContainEqual({ command: "git push" });
  expect(details[3]).toEqual([
    "A shell can commit and push even without ",
    { capability: "git.commit" },
    " or ",
    { capability: "git.push" },
    ".",
  ]);
  for (const view of allCapabilities()) {
    if (view.capability !== "terminal.execute") {
      expect(view.details).toEqual([]);
    }
  }
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

test("the screen says that granting is not available yet", () => {
  expect(describePermissionScreen().unavailable).toBe(
    "Granting permissions is not available yet. This screen shows what each permission allows and its risk.",
  );
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
