import {
  CAPABILITY_RISK,
  CAPABILITY_SCOPE,
  GRANT_SCOPE_KINDS,
  type CapabilityRisk,
  type GrantScopeKind,
} from "@mymandev/permissions/capabilities";

// The presentation model of the permission screen, after the presentation
// rules of ADR 0015 (P-70, P-71) and #77. It is built only from the
// vocabulary of `@mymandev/permissions`: the capability names are the keys of
// `CAPABILITY_RISK`, the scope kinds come from `CAPABILITY_SCOPE`, and the
// risk of each capability is read from `CAPABILITY_RISK` and nowhere else.
// Nothing here grants, checks, or infers a capability: the screen only says
// what each capability means, and it never derives one capability from
// another or from a risk label.
//
// It imports `@mymandev/permissions/capabilities`, which imports no value,
// never the package's main entry, whose schemas and checks would bring zod
// and `@mymandev/protocol` into the renderer, also on the development server.

/** One capability name, as `@mymandev/permissions` classifies it. */
export type PermissionCapability = keyof typeof CAPABILITY_RISK;

/** The capabilities that `CAPABILITY_RISK` labels `highest`. */
export type HighestRiskCapability = {
  [C in PermissionCapability]: (typeof CAPABILITY_RISK)[C] extends "highest"
    ? C
    : never;
}[PermissionCapability];

/**
 * A part of a fixed statement: plain text, or a capability name or a command
 * that the screen shows as code.
 */
export type StatementPart =
  | string
  | { readonly capability: PermissionCapability }
  | { readonly command: string };

/** A fixed statement of the screen, as parts. */
export type Statement = readonly StatementPart[];

/** The screen's text for each risk label. The label itself is never shown. */
export const RISK_LABELS: Readonly<Record<CapabilityRisk, string>> =
  Object.freeze({
    standard: "Standard risk",
    highest: "Highest risk",
  });

/** The heading and the sentence of each scope kind. */
export const SCOPE_TEXTS: Readonly<
  Record<GrantScopeKind, { readonly title: string; readonly text: string }>
> = Object.freeze({
  repository: {
    title: "On one repository",
    text: "Each of these permissions is granted on one repository.",
  },
  provider_connection: {
    title: "On one AI provider connection",
    text: "This permission is granted on one AI provider connection on the agent's device.",
  },
});

/** What each capability allows, in one sentence. */
export const CAPABILITY_MEANINGS: Readonly<
  Record<PermissionCapability, string>
> = Object.freeze({
  "repo.read": "Read the files of the repository.",
  "repo.write": "Change the files of the repository.",
  "terminal.execute": "Run a shell that starts in the repository.",
  "git.commit": "Create commits in the repository.",
  "git.push": "Push commits from the repository to its remotes.",
  "provider.use":
    "Send requests to the AI provider of the connection, with the connection's credentials on the agent's device.",
});

/**
 * What a shell can do (ADR 0015, P-70, and #77). The repository scope of
 * `terminal.execute` is where the shell starts, not a sandbox. The end of the
 * last statement is the one that #77 requires while `terminal.execute` is
 * granted while `git.commit` or `git.push` is not; this read-only screen shows
 * it always.
 */
export const SHELL_STATEMENTS: readonly Statement[] = Object.freeze([
  [
    "A shell runs as the user of the agent's device. The repository is only where it starts: it is not a sandbox.",
  ],
  [
    "A shell can read and change files outside the repository, use the network, run ",
    { command: "git commit" },
    " and ",
    { command: "git push" },
    ", and read the credentials stored for that user, including local AI provider credentials.",
  ],
  ["So a shell can send files and those credentials over the network."],
  [
    "A shell can commit and push even without ",
    { capability: "git.commit" },
    " or ",
    { capability: "git.push" },
    ".",
  ],
]);

// OPEN QUESTION for the Project Manager (#77, ADR 0015 P-71): the default
// expiry that the grant of `terminal.execute` proposes, which the person can
// change or remove, is not decided. Neither this text nor the model holds one
// yet.

/**
 * The confirmation that a highest-risk capability needs before it is granted
 * on its own. The type requires one for every capability that
 * `CAPABILITY_RISK` labels `highest`. Granting comes later (#77, after #75).
 */
export const HIGHEST_RISK_CONFIRMATIONS: Readonly<
  Record<HighestRiskCapability, string>
> = Object.freeze({
  "terminal.execute":
    "Allow this agent to run a shell in this repository? The shell runs as the user of the agent's device and is not limited to the repository: it can read and change files outside the repository, use the network, commit and push, and read the credentials stored for that user, including local AI provider credentials.",
});

/**
 * The statements for the whole screen (ADR 0008, ADR 0015, and #77). None of
 * them relates one capability to another for a check: they tell the person
 * what follows from a grant, including that a permission can allow more than
 * its name says.
 */
export const SCREEN_STATEMENTS: readonly Statement[] = Object.freeze([
  [
    "Permissions belong to one agent of this project, and only the agent's owner grants them.",
  ],
  [
    "Each permission is checked on its own: for a check, none includes another, so ",
    { capability: "repo.write" },
    " does not include ",
    { capability: "repo.read" },
    ", and ",
    { capability: "git.push" },
    " does not include ",
    { capability: "git.commit" },
    ". A permission can still let the agent do more than its name says: see ",
    { capability: "terminal.execute" },
    ".",
  ],
  [
    "With ",
    { capability: "repo.read" },
    " on a repository and ",
    { capability: "provider.use" },
    " on an AI provider connection, the agent can send that repository's content to that connection's provider.",
  ],
]);

/** The sentence that says that this screen does not grant yet. */
export const GRANTING_UNAVAILABLE =
  "Granting permissions is not available yet. This screen shows what each permission allows and its risk.";

/** One capability as the screen shows it. */
export interface CapabilityView {
  readonly capability: PermissionCapability;
  readonly scope: GrantScopeKind;
  /** The label from `CAPABILITY_RISK`. */
  readonly risk: CapabilityRisk;
  /** The screen's text for `risk`. */
  readonly riskLabel: string;
  readonly meaning: string;
  /** What a shell can do, for `terminal.execute`; otherwise empty. */
  readonly details: readonly Statement[];
  /**
   * Whether a grant form may select it before the person does. False for a
   * highest-risk capability.
   */
  readonly mayBePreselected: boolean;
  /**
   * Whether it may be granted together with other capabilities, in a bundle
   * or a "select all". False for a highest-risk capability, which is granted
   * on its own.
   */
  readonly mayBeBundled: boolean;
  /**
   * The separate, explicit confirmation of a highest-risk capability, or
   * undefined when the capability needs none of its own.
   */
  readonly confirmation: string | undefined;
}

/** The capabilities of one scope kind. */
export interface ScopeGroupView {
  readonly scope: GrantScopeKind;
  readonly title: string;
  readonly text: string;
  readonly capabilities: readonly CapabilityView[];
}

/** Everything that the permission screen shows. */
export interface PermissionScreenView {
  readonly statements: readonly Statement[];
  readonly groups: readonly ScopeGroupView[];
  readonly unavailable: string;
}

/** The capability names, in the order of the contract. */
function capabilityNames(): PermissionCapability[] {
  return Object.keys(CAPABILITY_RISK).filter(
    (name): name is PermissionCapability =>
      Object.hasOwn(CAPABILITY_RISK, name),
  );
}

function isHighestRisk(
  capability: PermissionCapability,
): capability is HighestRiskCapability {
  return CAPABILITY_RISK[capability] === "highest";
}

/** One capability, with its risk read from `CAPABILITY_RISK`. */
export function describeCapability(
  capability: PermissionCapability,
): CapabilityView {
  const risk = CAPABILITY_RISK[capability];
  const highest = isHighestRisk(capability);
  return {
    capability,
    scope: CAPABILITY_SCOPE[capability],
    risk,
    riskLabel: RISK_LABELS[risk],
    meaning: CAPABILITY_MEANINGS[capability],
    details: capability === "terminal.execute" ? SHELL_STATEMENTS : [],
    mayBePreselected: !highest,
    mayBeBundled: !highest,
    confirmation: highest ? HIGHEST_RISK_CONFIRMATIONS[capability] : undefined,
  };
}

/**
 * The permission screen: the capabilities grouped by their scope kind, in the
 * order of `GRANT_SCOPE_KINDS`. Within a group the standard capabilities come
 * first and a highest-risk capability last, each in the order of the
 * contract, so that the highest-risk capability stands on its own.
 */
export function describePermissionScreen(): PermissionScreenView {
  const capabilities = capabilityNames().map(describeCapability);
  return {
    statements: SCREEN_STATEMENTS,
    groups: GRANT_SCOPE_KINDS.map((scope) => {
      const inScope = capabilities.filter((view) => view.scope === scope);
      return {
        scope,
        title: SCOPE_TEXTS[scope].title,
        text: SCOPE_TEXTS[scope].text,
        capabilities: [
          ...inScope.filter((view) => view.risk !== "highest"),
          ...inScope.filter((view) => view.risk === "highest"),
        ],
      };
    }),
    unavailable: GRANTING_UNAVAILABLE,
  };
}
