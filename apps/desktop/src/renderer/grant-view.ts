import {
  CAPABILITY_SCOPE,
  type CapabilityRisk,
} from "@mymandev/permissions/capabilities";
import type { GrantBridge } from "../shared/desktop-bridge.ts";
import type {
  AgentGrantsReadProblem,
  AgentGrantsResult,
  GrantCapabilityRefusal,
  GrantCapabilityResult,
  GrantRequestView,
  GrantsView,
  GrantView,
  ProviderConnectionReadProblem,
  ProviderConnectionsResult,
  ProviderConnectionView,
  RevokeGrantRefusal,
  RevokeGrantResult,
} from "../shared/ipc-contract.ts";
import type { AgentView } from "../shared/ipc-contract.ts";
import type { AgentPanelView } from "./agent-view.ts";
import { formatAgentTime } from "./agent-view.ts";
import {
  describeCapabilitiesInOfferOrder,
  describeCapability,
  grantStatements,
  SHELL_GIT_CAPABILITIES,
  SHELL_PROPOSED_LIFETIME_SECONDS,
  shellGitStatement,
  type PermissionCapability,
  type ShellGitCapability,
  type Statement,
} from "./permission-view.ts";
import type { ProjectRepositoriesPanelView } from "./project-repositories-view.ts";
import { describeWait } from "./wait-text.ts";

// The grant form and the grant list of the permission screen (#342): which
// agents this device may grant for, one capability on one scope with an
// expiry, and the selected agent's grants with a revoke control. The
// presentation rules of ADR 0015 (#77) apply to both:
//
// - The form offers every capability, each with its risk label from
//   `CAPABILITY_RISK` (through `permission-view.ts`), and says what the
//   chosen one allows, and for `terminal.execute` what a shell can do.
// - It never preselects a capability whose `mayBePreselected` is false, and
//   a bundle or a "select all", which it does not have, could only hold the
//   capabilities whose `mayBeBundled` is set (`bundleableCapabilities`).
// - A capability with its own confirmation, `terminal.execute`, is granted
//   on its own, in a second step: "Grant" asks the person to confirm, and
//   only the confirmation sends the request, with `confirmedHighestRisk`.
//   Cancelling, or changing the agent, the capability, the scope, or the
//   expiry, ends the confirmation, and nothing is sent. A confirmation that
//   the section stops showing ends too (`endHiddenConfirmation`).
// - The shell is proposed an expiry of `SHELL_PROPOSED_LIFETIME_SECONDS`,
//   which the person can change but not remove; the other capabilities
//   keep an optional expiry and are proposed none.
// - The confirmation, and an active shell grant in the list, say that the
//   shell can still commit and push while the agent lacks `git.commit` or
//   `git.push` on the repository, judged from the grants that the screen
//   holds; with `repo.read` and `provider.use` the form says that the two
//   together let the agent send the repository's content to the provider.
//
// The owner's agents that another device hosts (#345) are offered too, in
// the same list of agents, after the ones that this device may grant for.
// For such an agent the section shows no form, because only the host device
// grants, but its grants, which the main process reads on demand
// (`listAgentGrants`), each with a revoke control, and the same statement
// on an active shell grant, judged from that agent's own grants.
//
// The main process checks every value again, and the server decides each
// grant.

/** What the screen knows about the grants of the open project's agents. */
export type GrantsPanelView =
  /** Outside Electron, or the main process refused the subscription. */
  | { readonly kind: "unavailable" }
  /** Waiting for the first state. */
  | { readonly kind: "pending" }
  | { readonly kind: "known"; readonly state: GrantsView };

export function initialGrantsView(bridgeAvailable: boolean): GrantsPanelView {
  return bridgeAvailable ? { kind: "pending" } : { kind: "unavailable" };
}

/**
 * Subscribes to the grants and reports every state as the view; a refused
 * subscription makes the view unavailable. Returns the function that ends
 * the subscription.
 */
export function followGrants(
  bridge: Pick<GrantBridge, "subscribeState">,
  onView: (view: GrantsPanelView) => void,
): () => void {
  return bridge.subscribeState(
    (state) => onView({ kind: "known", state }),
    () => onView({ kind: "unavailable" }),
  );
}

/**
 * What the screen knows about the grants of an agent that another device
 * hosts: read for `agentId`, or waiting for that read; `agentId` null before
 * any read. A view of another agent than the selected one counts as
 * waiting, so a late answer never shows under another agent.
 */
export type AgentGrantsPanelView =
  | { readonly kind: "pending"; readonly agentId: string | null }
  | {
      readonly kind: "known";
      readonly agentId: string;
      readonly result: AgentGrantsResult;
    };

export const NO_AGENT_GRANTS: AgentGrantsPanelView = Object.freeze({
  kind: "pending",
  agentId: null,
});

/** What the screen knows about this device's provider connections. */
export type ConnectionsPanelView =
  | { readonly kind: "pending" }
  | { readonly kind: "known"; readonly result: ProviderConnectionsResult };

/**
 * The capabilities that the form offers: every capability of the contract,
 * the standard ones first and a highest-risk one, `terminal.execute`, last
 * (`describeCapabilitiesInOfferOrder`).
 */
export const OFFERED_CAPABILITIES: readonly PermissionCapability[] =
  Object.freeze(
    describeCapabilitiesInOfferOrder().map((view) => view.capability),
  );

/**
 * The capabilities of `capabilities` that a form may choose before the
 * person does: those whose `mayBePreselected` is set, never a highest-risk
 * one (ADR 0015).
 */
export function preselectableCapabilities(
  capabilities: readonly PermissionCapability[],
): PermissionCapability[] {
  return capabilities.filter(
    (capability) => describeCapability(capability).mayBePreselected,
  );
}

/**
 * The capabilities of `capabilities` that a bundle or a "select all" may
 * hold: those whose `mayBeBundled` is set, never a highest-risk one, which
 * is granted on its own (ADR 0015). The form has no bundle and no "select
 * all" today; one that is added takes its capabilities from here.
 */
export function bundleableCapabilities(
  capabilities: readonly PermissionCapability[],
): PermissionCapability[] {
  return capabilities.filter(
    (capability) => describeCapability(capability).mayBeBundled,
  );
}

function firstPreselectable(): PermissionCapability {
  const [first] = preselectableCapabilities(OFFERED_CAPABILITIES);
  if (first === undefined) {
    throw new Error("The grant form has no capability that it may choose.");
  }
  return first;
}

/**
 * The capability that the form starts with, and falls back to: the first
 * offered capability that may be preselected, never `terminal.execute`.
 */
export const INITIAL_CAPABILITY: PermissionCapability = firstPreselectable();

/** An expiry that the form offers. */
export interface ExpiryChoice {
  readonly id: string;
  readonly label: string;
  /** The lifetime in seconds, or null for a grant without an expiry. */
  readonly seconds: number | null;
}

/**
 * The expiries that the form offers, each within the protocol's bounds of a
 * lifetime: none, or from one hour to 30 days, which is also the longest
 * lifetime of a grant of `terminal.execute`. The tests check them against
 * the protocol's `GRANT_LIFETIME_SECONDS` and
 * `SHELL_GRANT_MAX_LIFETIME_SECONDS`.
 */
export const EXPIRY_CHOICES: readonly ExpiryChoice[] = Object.freeze([
  { id: "none", label: "Does not expire", seconds: null },
  { id: "hour", label: "1 hour", seconds: 3_600 },
  { id: "day", label: "1 day", seconds: 86_400 },
  { id: "week", label: "7 days", seconds: 604_800 },
  { id: "month", label: "30 days", seconds: 2_592_000 },
]);

/**
 * The expiries for `capability`: a grant of `terminal.execute` always
 * expires (#75, decision of 2026-11-14), so it is offered no choice
 * without one; the person can change its expiry but not remove it.
 */
export function expiryChoices(
  capability: PermissionCapability,
): readonly ExpiryChoice[] {
  return capability === "terminal.execute"
    ? EXPIRY_CHOICES.filter((choice) => choice.seconds !== null)
    : EXPIRY_CHOICES;
}

/** The expiry without one, which the form proposes but for the shell. */
export const NO_EXPIRY_ID = "none";

/**
 * The expiry that the form proposes for `capability`: for
 * `terminal.execute`, the choice of `SHELL_PROPOSED_LIFETIME_SECONDS` (24
 * hours, #77); for every other capability, none, as before.
 */
export function proposedExpiryId(capability: PermissionCapability): string {
  if (capability !== "terminal.execute") {
    return NO_EXPIRY_ID;
  }
  const choices = expiryChoices(capability);
  const proposed = choices.find(
    (choice) => choice.seconds === SHELL_PROPOSED_LIFETIME_SECONDS,
  );
  return (proposed ?? choices[0]!).id;
}

/** A grant that waits for the person's confirmation, as the form showed it. */
export interface PendingGrant {
  readonly agentId: string;
  readonly request: GrantRequestView;
}

/** What the person chose in the form. */
export interface GrantFormState {
  readonly agentId: string | null;
  readonly capability: PermissionCapability;
  readonly scopeId: string | null;
  /** The chosen expiry, or null for the one proposed for the capability. */
  readonly expiryId: string | null;
  /**
   * The grant of a capability with its own confirmation that waits for the
   * person to confirm it, or null.
   */
  readonly confirming: PendingGrant | null;
}

export const INITIAL_GRANT_FORM: GrantFormState = Object.freeze({
  agentId: null,
  capability: INITIAL_CAPABILITY,
  scopeId: null,
  expiryId: null,
  confirming: null,
});

/** A change that the person makes in the form. */
export type GrantFormChange =
  | { readonly agentId: string }
  | { readonly capability: PermissionCapability }
  | { readonly scopeId: string }
  | { readonly expiryId: string };

/**
 * The form after the person's change. Every change ends a confirmation
 * that waits, so nothing is sent for it; a new capability needs a new
 * scope and is proposed its own expiry.
 */
export function changeGrantForm(
  state: GrantFormState,
  change: GrantFormChange,
): GrantFormState {
  if ("capability" in change) {
    return {
      ...state,
      capability: change.capability,
      scopeId: null,
      expiryId: null,
      confirming: null,
    };
  }
  return { ...state, ...change, confirming: null };
}

/** The form with the grant that waits for the person's confirmation. */
export function askConfirmation(
  state: GrantFormState,
  pending: PendingGrant,
): GrantFormState {
  return { ...state, confirming: pending };
}

/** The form without a confirmation: cancelled, or answered. */
export function endConfirmation(state: GrantFormState): GrantFormState {
  return state.confirming === null ? state : { ...state, confirming: null };
}

/**
 * The form without a confirmation that the section no longer shows, or
 * `state` itself. The confirmation hides while the form stops showing the
 * grant that the person asked to confirm: the agents are read again, the
 * agent is no longer grantable here, or the scope is gone. Once hidden, it
 * ends, so that it never comes back on its own, and takes the focus, when
 * the form shows that grant again.
 */
export function endHiddenConfirmation(
  state: GrantFormState,
  view: GrantSectionView,
): GrantFormState {
  const shown = view.kind === "form" && view.form?.confirmation !== undefined;
  return shown ? state : endConfirmation(state);
}

function samePending(a: PendingGrant, b: PendingGrant): boolean {
  return (
    a.agentId === b.agentId &&
    a.request.capability === b.request.capability &&
    a.request.scopeId === b.request.scopeId &&
    a.request.lifetimeSeconds === b.request.lifetimeSeconds
  );
}

/** The fixed texts of the grant section. */
export const GRANT_MESSAGES = Object.freeze({
  title: "Grant a permission",
  unavailable: "Granting permissions is not available here.",
  pending: "Checking the agents and their permissions.",
  noProject:
    "Permissions can be granted once this device is signed in and the project is open.",
  noGrantableAgent:
    "No agent of yours in this project is hosted on this device. Only an agent's owner grants it permissions, and only from the device that hosts the agent.",
  hostedElsewhere:
    "This agent is hosted on another device of yours. Only that device grants it permissions; here you can revoke them.",
  otherDevice: "on another device",
  agentsUnknown:
    "The agents of this project could not be read, so it cannot be checked now whether one of yours is hosted on this device.",
  agentLabel: "Agent",
  capabilityLabel: "Permission",
  repositoryLabel: "Repository",
  connectionLabel: "AI provider connection",
  expiryLabel: "Expires",
  chooseRepository: "Choose a repository",
  chooseConnection: "Choose a connection",
  noRepositories: "This project has no registered repository yet.",
  repositoriesUnknown: "The project's repositories are not known yet.",
  connectionsPending: "Reading the AI provider connections of this device.",
  noConnections: "This device has no AI provider connection yet.",
  shellExpiry:
    "A grant of terminal.execute always expires, at the latest after 30 days.",
  submit: "Grant",
  submitConfirmation: "Grant after confirming",
  confirmTitle: "Confirm the highest-risk permission",
  confirm: "Confirm and grant",
  cancel: "Cancel",
  grantsTitle: "Permissions of this agent",
  grantsUnavailable:
    "The permissions of this agent cannot be shown now. They appear once this device has read its grants from the server.",
  agentGrantsPending: "Reading the permissions of this agent from the server.",
  noGrants: "This agent has no permissions yet.",
  revoke: "Revoke",
  neverExpires: "Does not expire",
  unknownRepository: "A repository that is no longer listed",
  unknownConnection: "An AI provider connection that is no longer listed",
  hostConnection:
    "An AI provider connection of the device that hosts the agent",
  running: "Waiting for the server.",
});

/** Why this device's provider connections could not be read. */
export const CONNECTION_PROBLEM_MESSAGES: Readonly<
  Record<ProviderConnectionReadProblem, string>
> = Object.freeze({
  not_signed_in:
    "The AI provider connections of this device cannot be read: the server did not accept this device's sign-in.",
  rate_limited:
    "The AI provider connections of this device cannot be read now: the server asked to wait.",
  unavailable:
    "The AI provider connections of this device cannot be read now: the server could not be reached.",
  failed: "The AI provider connections of this device could not be read.",
});

/**
 * Why the grants of an agent that another device hosts cannot be shown, for
 * each problem of the main process.
 */
export const AGENT_GRANTS_PROBLEM_MESSAGES: Readonly<
  Record<AgentGrantsReadProblem, string>
> = Object.freeze({
  invalid: "The permissions of this agent cannot be read here.",
  not_open: "The agent is not one of this project's agents anymore.",
  not_owner: "Only the agent's owner sees and revokes its permissions.",
  hosted_here:
    "This device hosts the agent, so its permissions come with this device's grants.",
  not_signed_in:
    "The permissions of this agent cannot be read: the server did not accept this device's sign-in.",
  not_found:
    "The server does not know this agent, or you are no longer a member of its workspace.",
  rate_limited:
    "The permissions of this agent cannot be read now: the server asked to wait.",
  unavailable:
    "The permissions of this agent cannot be read now: the server could not be reached.",
  failed: "The permissions of this agent could not be read.",
});

/** The refusals whose sentence names a wait. */
type Wait = "too_soon" | "rate_limited";

/** Why a grant was refused, for each refusal of the main process. */
export const GRANT_REFUSAL_MESSAGES: Readonly<
  Record<Exclude<GrantCapabilityRefusal, Wait>, string>
> &
  Readonly<Record<Wait, (wait: string) => string>> = Object.freeze({
  invalid:
    "The permission, its scope, or its expiry is not one that can be granted here.",
  not_open: "The agent is not one of this project's agents anymore.",
  not_grantable:
    "Only the agent's owner grants it permissions, and only from the device that hosts the agent.",
  busy: "Another permission is still waiting for the server's answer.",
  not_signed_in:
    "This device is not signed in, or the server did not accept its sign-in.",
  unavailable:
    "The server could not be reached, or this device is busy with the account. Try again later.",
  too_soon: (wait: string) =>
    `This device sent too many changes. Try again in ${wait}.`,
  rate_limited: (wait: string) =>
    `The server asked to wait: too many requests, or too many permissions granted in 24 hours. Try again in ${wait}.`,
  forbidden:
    "The server refused: only the agent's owner grants it permissions, and only from the device that hosts the agent.",
  not_found:
    "The server does not know the agent, the repository in this project, or the AI provider connection on this device.",
  conflict:
    "The agent already has this permission on this scope, or the agent is disabled, or the repository, the project, or the connection is no longer active.",
  grant_limit:
    "The agent or this device has as many permissions as it may have. Revoke one first.",
  failed: "The server refused the request.",
});

/** Why a revocation was refused, for each refusal of the main process. */
export const REVOKE_REFUSAL_MESSAGES: Readonly<
  Record<Exclude<RevokeGrantRefusal, Wait>, string>
> &
  Readonly<Record<Wait, (wait: string) => string>> = Object.freeze({
  invalid: "The permission is not one that can be revoked here.",
  not_open: GRANT_REFUSAL_MESSAGES.not_open,
  not_owner: "Only the agent's owner revokes its permissions.",
  not_signed_in: GRANT_REFUSAL_MESSAGES.not_signed_in,
  unavailable: GRANT_REFUSAL_MESSAGES.unavailable,
  too_soon: GRANT_REFUSAL_MESSAGES.too_soon,
  rate_limited: (wait: string) =>
    `The server asked to wait: too many requests. Try again in ${wait}.`,
  forbidden:
    "The server refused: only the agent's owner revokes its permissions.",
  not_found: "The agent does not have this permission anymore.",
  conflict: "The permission is already revoked.",
  failed: GRANT_REFUSAL_MESSAGES.failed,
});

/** The sentences of each outcome. */
export const GRANT_RESULT_MESSAGES = Object.freeze({
  granted: "The permission was granted.",
  notGranted: "The permission was not granted.",
  grantUnknown:
    "Whether the permission was granted is not known. The list shows it once this device has read its grants again.",
  revoked: "The permission was revoked.",
  notRevoked: "The permission was not revoked.",
  revokeUnknown:
    "Whether the permission was revoked is not known. The list shows the change once this device has read its grants again.",
  notSent: "It could not be sent. Try again.",
});

function refusalText<R extends string>(
  messages: Readonly<Record<Exclude<R, Wait>, string>> &
    Readonly<Record<Wait, (wait: string) => string>>,
  reason: R,
  retryAfterMs: number | null,
): string {
  // Each refusal has its sentence; a wait has a function of the wait.
  const entry = (
    messages as Readonly<Record<string, string | ((wait: string) => string)>>
  )[reason];
  return typeof entry === "function"
    ? entry(describeWait(retryAfterMs ?? 0))
    : (entry ?? "");
}

/** The sentence after the answer of a grant. */
export function describeGrantResult(result: GrantCapabilityResult): string {
  switch (result.outcome) {
    case "ok":
      return GRANT_RESULT_MESSAGES.granted;
    case "unknown":
      return GRANT_RESULT_MESSAGES.grantUnknown;
    case "refused":
      return `${GRANT_RESULT_MESSAGES.notGranted} ${refusalText(
        GRANT_REFUSAL_MESSAGES,
        result.reason,
        result.retryAfterMs,
      )}`;
  }
}

/** The sentence after the answer of a revocation. */
export function describeRevokeResult(result: RevokeGrantResult): string {
  switch (result.outcome) {
    case "ok":
      return GRANT_RESULT_MESSAGES.revoked;
    case "unknown":
      return GRANT_RESULT_MESSAGES.revokeUnknown;
    case "refused":
      return `${GRANT_RESULT_MESSAGES.notRevoked} ${refusalText(
        REVOKE_REFUSAL_MESSAGES,
        result.reason,
        result.retryAfterMs,
      )}`;
  }
}

/** One choice of a list: its value and its text. */
export interface Choice {
  readonly id: string;
  readonly label: string;
}

/**
 * One agent of the section's list: an agent of the account's own that this
 * device may grant for, or one that another device hosts, whose grants can
 * only be revoked here.
 */
export interface AgentChoice extends Choice {
  readonly grantable: boolean;
}

/** One grant of the selected agent, as the list shows it. */
export interface GrantItemView {
  readonly grantId: string;
  readonly capability: PermissionCapability;
  /** The repository's name or the connection's label. */
  readonly scope: string;
  /** When it expires or expired, or that it does not. */
  readonly expiry: string;
  readonly expired: boolean;
  /**
   * For an active grant of `terminal.execute`: that the shell can still
   * commit and push while the agent lacks `git.commit` or `git.push` on the
   * repository. Otherwise empty.
   */
  readonly statements: readonly Statement[];
}

/** One capability of the form's list, with its risk label. */
export interface CapabilityChoice {
  readonly capability: PermissionCapability;
  /** The text of its label from `CAPABILITY_RISK`. */
  readonly riskLabel: string;
}

/** The separate confirmation of a highest-risk capability. */
export interface GrantConfirmationView {
  /** The capability's confirmation, `HIGHEST_RISK_CONFIRMATIONS`. */
  readonly text: string;
  readonly agent: string;
  readonly scope: string;
  readonly expiry: string;
  /** That the shell can still commit and push, where it applies. */
  readonly statements: readonly Statement[];
  /** The grant that the confirmation sends, exactly as the form shows it. */
  readonly pending: PendingGrant;
}

/** The grant form, for an agent that this device may grant for. */
export interface GrantFormView {
  /** The selected agent, which this device may grant for. */
  readonly agentId: string;
  readonly capabilities: readonly CapabilityChoice[];
  readonly capability: PermissionCapability;
  /** The chosen capability's label from `CAPABILITY_RISK`, and its text. */
  readonly risk: CapabilityRisk;
  readonly riskLabel: string;
  /** What the chosen capability allows. */
  readonly meaning: string;
  /** What a shell can do, for `terminal.execute`; otherwise empty. */
  readonly details: readonly Statement[];
  /** The statements for the chosen capability (`grantStatements`). */
  readonly statements: readonly Statement[];
  /** `repository` or `provider_connection`: the label of the scope list. */
  readonly scopeKind: "repository" | "provider_connection";
  readonly scopes: readonly Choice[];
  readonly scopeId: string | null;
  /** Why no scope can be chosen, if none can. */
  readonly scopeNote: string | undefined;
  readonly expiries: readonly ExpiryChoice[];
  readonly expiryId: string;
  /** Why no choice without an expiry is offered, for the shell. */
  readonly expiryNote: string | undefined;
  /** Whether the form can be sent: a scope is chosen. */
  readonly ready: boolean;
  /**
   * Whether the chosen capability is granted only after its own
   * confirmation, in a second step.
   */
  readonly needsConfirmation: boolean;
  /**
   * The confirmation that waits for the person, while the form still shows
   * the grant that the person asked to confirm; otherwise undefined.
   */
  readonly confirmation: GrantConfirmationView | undefined;
}

/** The grant section of the permission screen. */
export type GrantSectionView =
  | { readonly kind: "message"; readonly text: string }
  | {
      readonly kind: "form";
      /**
       * The account's own agents of the project: those that this device may
       * grant for first, then those that another device hosts. Empty while
       * there is none.
       */
      readonly agents: readonly AgentChoice[];
      /** The selected agent, or null while none is offered. */
      readonly agentId: string | null;
      /**
       * Null while this device may not grant for the selected agent, or no
       * agent is offered.
       */
      readonly form: GrantFormView | null;
      /** Shown instead of the form, or under it. */
      readonly notes: readonly string[];
      /** The selected agent's grants, or why they cannot be shown. */
      readonly grants: readonly GrantItemView[];
      readonly grantsNote: string | undefined;
    };

export interface GrantSectionInput {
  readonly agents: AgentPanelView;
  readonly repositories: ProjectRepositoriesPanelView;
  readonly grants: GrantsPanelView;
  /** The grants of the selected agent when another device hosts it. */
  readonly agentGrants: AgentGrantsPanelView;
  readonly connections: ConnectionsPanelView;
  readonly form: GrantFormState;
  /** The wall clock in milliseconds, for "expired". */
  readonly now: number;
  readonly timeFormat: Intl.DateTimeFormat;
}

function connectionLabel(connection: ProviderConnectionView): string {
  return connection.label;
}

/**
 * Whether the section needs this device's provider connections: only while
 * an agent of the open project is grantable here. Without one, no form is
 * shown, so the connections are not read.
 */
export function needsProviderConnections(agents: AgentPanelView): boolean {
  return (
    agents.kind === "known" &&
    agents.state.projectId !== null &&
    agents.state.agents.some((agent) => agent.grantableHere)
  );
}

/**
 * The agents that the section offers: the account's own agents that this
 * device may grant for (`grantableHere`), then its enabled agents that
 * another device hosts, whose grants can only be revoked here (#345). A
 * disabled agent is not offered: disabling it revoked its grants.
 */
function offeredAgents(
  agents: readonly AgentView[],
): readonly (AgentChoice & { readonly name: string })[] {
  const grantable = agents.filter((agent) => agent.grantableHere);
  const elsewhere = agents.filter(
    (agent) =>
      agent.ownedByMe && !agent.grantableHere && agent.disabledAt === null,
  );
  return [
    ...grantable.map((agent) => ({
      id: agent.id,
      name: agent.name,
      label: agent.name,
      grantable: true,
    })),
    ...elsewhere.map((agent) => ({
      id: agent.id,
      name: agent.name,
      label: `${agent.name} (${GRANT_MESSAGES.otherDevice})`,
      grantable: false,
    })),
  ];
}

/**
 * The selected agent among the offered ones: the one that the form names,
 * else the first offered, or undefined while none is offered.
 */
function selectedAgent<A extends AgentChoice>(
  offered: readonly A[],
  agentId: string | null,
): A | undefined {
  return offered.find((item) => item.id === agentId) ?? offered[0];
}

/**
 * The agent whose grants the section needs from `listAgentGrants`: the
 * selected agent while another device hosts it, else null, also while the
 * agents are not known or no project is open. The screen reads them only
 * then (#345). It selects as `describeGrantSection` does.
 */
export function agentGrantsToRead(
  agents: AgentPanelView,
  form: GrantFormState,
): string | null {
  if (
    agents.kind !== "known" ||
    agents.state.projectId === null ||
    agents.state.status === "no_project" ||
    agents.state.status === "loading"
  ) {
    return null;
  }
  const agent = selectedAgent(offeredAgents(agents.state.agents), form.agentId);
  return agent === undefined || agent.grantable ? null : agent.id;
}

/**
 * The grant section: a message while the agents are not known, else the
 * account's own agents (`offeredAgents`), the form for the selected agent
 * when this device may grant for it (`grantableHere`), and the selected
 * agent's grants: from the grant state for an agent that this device may
 * grant for, and from `agentGrants` for one that another device hosts,
 * which has no form (#345). When the last reload of the agents failed and
 * no agent is offered, it says that this cannot be checked now rather than
 * that no agent is hosted here. The selection falls back to the first
 * offered agent, a scope that is no longer offered is no longer chosen, and
 * an expiry that is not chosen or not offered falls back to the one
 * proposed for the capability (`proposedExpiryId`). The confirmation of a
 * highest-risk capability shows only while the form shows exactly the
 * grant that the person asked to confirm.
 */
export function describeGrantSection(
  input: GrantSectionInput,
): GrantSectionView {
  const { agents } = input;
  if (agents.kind === "unavailable") {
    return { kind: "message", text: GRANT_MESSAGES.unavailable };
  }
  if (agents.kind === "pending") {
    return { kind: "message", text: GRANT_MESSAGES.pending };
  }
  const { state } = agents;
  if (state.status === "no_project" || state.projectId === null) {
    return { kind: "message", text: GRANT_MESSAGES.noProject };
  }
  if (state.status === "loading") {
    return { kind: "message", text: GRANT_MESSAGES.pending };
  }
  const offered = offeredAgents(state.agents);
  if (offered.length === 0) {
    return {
      kind: "form",
      agents: [],
      agentId: null,
      form: null,
      notes: [
        state.status === "unavailable"
          ? GRANT_MESSAGES.agentsUnknown
          : GRANT_MESSAGES.noGrantableAgent,
      ],
      grants: [],
      grantsNote: undefined,
    };
  }
  const agent = selectedAgent(offered, input.form.agentId)!;
  const choices: readonly AgentChoice[] = offered.map(
    ({ id, label, grantable }) => ({ id, label, grantable }),
  );
  if (!agent.grantable) {
    return {
      kind: "form",
      agents: choices,
      agentId: agent.id,
      form: null,
      notes: [GRANT_MESSAGES.hostedElsewhere],
      ...elsewhereGrantList(input, agent.id),
    };
  }
  const held = heldGrants(input.grants);
  const capability = OFFERED_CAPABILITIES.includes(input.form.capability)
    ? input.form.capability
    : INITIAL_CAPABILITY;
  const described = describeCapability(capability);
  const scopeKind = CAPABILITY_SCOPE[capability];
  const { scopes, scopeNote, names } = scopeChoices(input, scopeKind);
  const scope = scopes.find((item) => item.id === input.form.scopeId);
  const expiries = expiryChoices(capability);
  const expiry =
    expiries.find((choice) => choice.id === input.form.expiryId) ??
    expiries.find((choice) => choice.id === proposedExpiryId(capability))!;
  const needsConfirmation = described.confirmation !== undefined;
  const shown: PendingGrant | null =
    scope === undefined
      ? null
      : {
          agentId: agent.id,
          request: {
            capability,
            scopeId: scope.id,
            lifetimeSeconds: expiry.seconds,
          },
        };
  const { confirming } = input.form;
  const confirmation: GrantConfirmationView | undefined =
    described.confirmation === undefined ||
    shown === null ||
    confirming === null ||
    !samePending(confirming, shown)
      ? undefined
      : {
          text: described.confirmation,
          agent: agent.name,
          scope: scope!.label,
          expiry: expiry.label,
          statements: shellStatements(
            input,
            held,
            agent.id,
            capability,
            scopeKind === "repository" ? scope!.id : null,
          ),
          pending: shown,
        };
  const form: GrantFormView = {
    agentId: agent.id,
    capabilities: OFFERED_CAPABILITIES.map((item) => ({
      capability: item,
      riskLabel: describeCapability(item).riskLabel,
    })),
    capability,
    risk: described.risk,
    riskLabel: described.riskLabel,
    meaning: described.meaning,
    details: described.details,
    statements: grantStatements(capability),
    scopeKind,
    scopes,
    scopeId: scope?.id ?? null,
    scopeNote,
    expiries,
    expiryId: expiry.id,
    expiryNote: expiries.some((choice) => choice.seconds === null)
      ? undefined
      : GRANT_MESSAGES.shellExpiry,
    ready: scope !== undefined,
    needsConfirmation,
    confirmation,
  };
  const listed = grantList(input, held, agent.id, names);
  return {
    kind: "form",
    agents: choices,
    agentId: agent.id,
    form,
    notes: [],
    ...listed,
  };
}

/** Whether a grant of the list is expired at `now`. */
function isExpired(grant: GrantView, now: number): boolean {
  return (
    grant.expired ||
    (grant.expiresAt !== null && now >= Date.parse(grant.expiresAt))
  );
}

/** The grants that the grant state holds, or `unknown` while it holds none that are usable. */
function heldGrants(grants: GrantsPanelView): readonly GrantView[] | "unknown" {
  return grants.kind !== "known" ||
    !grants.state.usable ||
    grants.state.projectId === null
    ? "unknown"
    : grants.state.grants;
}

/**
 * Which of `git.commit` and `git.push` the agent lacks on `repositoryId`,
 * judged from `held`, the agent's grants that the screen holds, those that
 * have not expired (a revoked grant is not held), or `unknown` while the
 * screen holds none that it can use. `held` is the grant state for an
 * agent that this device may grant for, and the agent's own read for one
 * that another device hosts (#345).
 */
export function missingShellGitCapabilitiesIn(
  held: readonly GrantView[] | "unknown",
  agentId: string,
  repositoryId: string,
  now: number,
): readonly ShellGitCapability[] | "unknown" {
  if (held === "unknown") {
    return "unknown";
  }
  return SHELL_GIT_CAPABILITIES.filter(
    (capability) =>
      !held.some(
        (grant) =>
          grant.agentId === agentId &&
          grant.capability === capability &&
          grant.repositoryId === repositoryId &&
          !isExpired(grant, now),
      ),
  );
}

/**
 * Which of `git.commit` and `git.push` the agent lacks on `repositoryId`,
 * judged from the grant state (`missingShellGitCapabilitiesIn`).
 */
export function missingShellGitCapabilities(
  grants: GrantsPanelView,
  agentId: string,
  repositoryId: string,
  now: number,
): readonly ShellGitCapability[] | "unknown" {
  return missingShellGitCapabilitiesIn(
    heldGrants(grants),
    agentId,
    repositoryId,
    now,
  );
}

/**
 * For `terminal.execute` on a repository, that the shell can still commit
 * and push, where it applies (`shellGitStatement`), judged from `held`;
 * otherwise nothing.
 */
function shellStatements(
  input: GrantSectionInput,
  held: readonly GrantView[] | "unknown",
  agentId: string,
  capability: PermissionCapability,
  repositoryId: string | null,
): readonly Statement[] {
  if (capability !== "terminal.execute" || repositoryId === null) {
    return [];
  }
  const statement = shellGitStatement(
    missingShellGitCapabilitiesIn(held, agentId, repositoryId, input.now),
  );
  return statement === undefined ? [] : [statement];
}

/** The scope choices of a kind, and the names of every known scope. */
function scopeChoices(
  input: GrantSectionInput,
  scopeKind: "repository" | "provider_connection",
): {
  readonly scopes: readonly Choice[];
  readonly scopeNote: string | undefined;
  readonly names: ReadonlyMap<string, string>;
} {
  const names = new Map<string, string>();
  const { repositories, connections } = input;
  const repositoryChoices: Choice[] =
    repositories.kind === "known"
      ? repositories.state.repositories.map((repository) => ({
          id: repository.repositoryId,
          label: repository.name,
        }))
      : [];
  const connectionChoices: Choice[] =
    connections.kind === "known" && connections.result.outcome === "ok"
      ? connections.result.connections.map((connection) => ({
          id: connection.id,
          label: connectionLabel(connection),
        }))
      : [];
  for (const choice of [...repositoryChoices, ...connectionChoices]) {
    names.set(choice.id, choice.label);
  }
  if (scopeKind === "repository") {
    const known =
      repositories.kind === "known" && repositories.state.status === "ready";
    return {
      scopes: repositoryChoices,
      scopeNote: !known
        ? GRANT_MESSAGES.repositoriesUnknown
        : repositoryChoices.length === 0
          ? GRANT_MESSAGES.noRepositories
          : undefined,
      names,
    };
  }
  return {
    scopes: connectionChoices,
    scopeNote:
      connections.kind === "pending"
        ? GRANT_MESSAGES.connectionsPending
        : connections.result.outcome === "refused"
          ? CONNECTION_PROBLEM_MESSAGES[connections.result.reason]
          : connectionChoices.length === 0
            ? GRANT_MESSAGES.noConnections
            : undefined,
    names,
  };
}

/** The selected agent's grants from the grant state, or why they cannot be shown. */
function grantList(
  input: GrantSectionInput,
  held: readonly GrantView[] | "unknown",
  agentId: string,
  names: ReadonlyMap<string, string>,
): {
  readonly grants: readonly GrantItemView[];
  readonly grantsNote: string | undefined;
} {
  if (held === "unknown") {
    return { grants: [], grantsNote: GRANT_MESSAGES.grantsUnavailable };
  }
  return grantItems(input, held, agentId, (grant) => {
    const scopeId = grant.repositoryId ?? grant.providerConnectionId ?? "";
    return (
      names.get(scopeId) ??
      (grant.repositoryId === null
        ? GRANT_MESSAGES.unknownConnection
        : GRANT_MESSAGES.unknownRepository)
    );
  });
}

/**
 * The grants of an agent that another device hosts, from its own read, or
 * why they cannot be shown (#345). A read of another agent counts as
 * waiting. A repository is named from the project's repositories; a
 * provider connection is one of the host device, which this device cannot
 * name.
 */
function elsewhereGrantList(
  input: GrantSectionInput,
  agentId: string,
): {
  readonly grants: readonly GrantItemView[];
  readonly grantsNote: string | undefined;
} {
  const read = input.agentGrants;
  if (read.kind !== "known" || read.agentId !== agentId) {
    return { grants: [], grantsNote: GRANT_MESSAGES.agentGrantsPending };
  }
  if (read.result.outcome === "refused") {
    return {
      grants: [],
      grantsNote: AGENT_GRANTS_PROBLEM_MESSAGES[read.result.reason],
    };
  }
  if (read.result.agentId !== agentId) {
    return { grants: [], grantsNote: GRANT_MESSAGES.agentGrantsPending };
  }
  const { repositories } = input;
  const names = new Map<string, string>(
    repositories.kind === "known"
      ? repositories.state.repositories.map((repository) => [
          repository.repositoryId,
          repository.name,
        ])
      : [],
  );
  return grantItems(input, read.result.grants, agentId, (grant) =>
    grant.repositoryId === null
      ? GRANT_MESSAGES.hostConnection
      : (names.get(grant.repositoryId) ?? GRANT_MESSAGES.unknownRepository),
  );
}

/**
 * The agent's grants of `held` as the list shows them, each with its scope
 * named by `scopeOf`, its expiry, and, for an active shell grant, the
 * statement that it can still commit and push, judged from `held`.
 */
function grantItems(
  input: GrantSectionInput,
  held: readonly GrantView[],
  agentId: string,
  scopeOf: (grant: GrantView) => string,
): {
  readonly grants: readonly GrantItemView[];
  readonly grantsNote: string | undefined;
} {
  const items = held
    .filter((grant) => grant.agentId === agentId)
    .map((grant): GrantItemView => {
      const scope = scopeOf(grant);
      const expired = isExpired(grant, input.now);
      const expiry =
        grant.expiresAt === null
          ? GRANT_MESSAGES.neverExpires
          : `${expired ? "Expired" : "Expires"} ${formatAgentTime(
              grant.expiresAt,
              input.timeFormat,
            )}`;
      return {
        grantId: grant.id,
        capability: grant.capability,
        scope,
        expiry,
        expired,
        // Only a grant that has not expired is granted.
        statements: expired
          ? []
          : shellStatements(
              input,
              held,
              agentId,
              grant.capability,
              grant.repositoryId,
            ),
      };
    });
  return {
    grants: items,
    grantsNote: items.length === 0 ? GRANT_MESSAGES.noGrants : undefined,
  };
}

/**
 * The request that the form shows, or null while it is not ready. The
 * expiry is looked up in `expiryChoices` of the capability, never in the
 * view's own list, so a grant of the shell never goes without one.
 */
export function grantRequestOf(form: GrantFormView): GrantRequestView | null {
  if (!form.ready || form.scopeId === null) {
    return null;
  }
  const expiry = expiryChoices(form.capability).find(
    (choice) => choice.id === form.expiryId,
  );
  if (expiry === undefined) {
    return null;
  }
  return {
    capability: form.capability,
    scopeId: form.scopeId,
    lifetimeSeconds: expiry.seconds,
  };
}

/** What "Grant" does with the form. */
export type GrantSubmission =
  /** A capability without its own confirmation: the request goes. */
  | {
      readonly kind: "send";
      readonly agentId: string;
      readonly request: GrantRequestView;
    }
  /** A capability with its own confirmation: the person is asked first. */
  | { readonly kind: "confirm"; readonly pending: PendingGrant }
  /** Not ready, or a confirmation already waits: nothing. */
  | { readonly kind: "none" };

/**
 * What "Grant" does: it sends a capability that needs no confirmation of
 * its own, and for one that does, `terminal.execute`, it only asks for the
 * confirmation. Nothing is sent for it here.
 */
export function submitGrant(form: GrantFormView): GrantSubmission {
  const request = grantRequestOf(form);
  if (request === null || form.confirmation !== undefined) {
    return { kind: "none" };
  }
  return form.needsConfirmation ||
    describeCapability(form.capability).confirmation !== undefined
    ? { kind: "confirm", pending: { agentId: form.agentId, request } }
    : { kind: "send", agentId: form.agentId, request };
}

/**
 * The request that the person's confirmation sends, with
 * `confirmedHighestRisk`, or null. It is sent only while the form state
 * still waits for this confirmation and the form still shows the grant
 * that the person was asked to confirm: a change of the agent, the
 * capability, the scope, or the expiry since ended it.
 */
export function confirmedGrantOf(
  state: GrantFormState,
  form: GrantFormView,
): { readonly agentId: string; readonly request: GrantRequestView } | null {
  const shown = form.confirmation;
  const request = grantRequestOf(form);
  if (
    shown === undefined ||
    request === null ||
    state.confirming === null ||
    describeCapability(form.capability).confirmation === undefined ||
    !samePending(state.confirming, shown.pending) ||
    !samePending(shown.pending, { agentId: form.agentId, request })
  ) {
    return null;
  }
  return {
    agentId: shown.pending.agentId,
    request: { ...shown.pending.request, confirmedHighestRisk: true },
  };
}

/**
 * How the person ended a confirmation: cancelled, or confirmed, with the
 * request sent or, for a grant that the form no longer showed, not sent.
 */
export type ConfirmationEnd = "cancelled" | "sent" | "not_sent";

/** Where the focus goes once a confirmation has closed. */
export type GrantFocusTarget = "submit" | "result";

/**
 * Where the focus goes once the confirmation that the person ended has
 * closed, so that it is not lost with the confirmation's buttons, or null
 * while there is no place for it.
 *
 * After "Cancel", or a confirmation that sent nothing, it goes back to the
 * form's "Grant after confirming", where the person was. After a
 * confirmation that sent the request, it goes to the sentence after the
 * action: while the request waits, "Grant" and every list of the form are
 * disabled and cannot take the focus, and the sentence is where the
 * outcome appears. The sentence is also the place whenever "Grant" cannot
 * be used: an action waits, or the form is not ready or has no agent.
 */
export function focusAfterConfirmation(
  end: ConfirmationEnd,
  view: GrantSectionView,
  actions: GrantActionsView,
): GrantFocusTarget | null {
  if (view.kind !== "form" || view.form?.confirmation !== undefined) {
    return null;
  }
  return end !== "sent" &&
    view.form !== null &&
    view.form.ready &&
    !actions.running
    ? "submit"
    : "result";
}

/** What the actions show: whether one waits, and the last sentence. */
export interface GrantActionsView {
  readonly running: boolean;
  readonly message: string | undefined;
}

export const IDLE_GRANT_ACTIONS: GrantActionsView = Object.freeze({
  running: false,
  message: undefined,
});

export interface GrantActions {
  /** Grants with the form's request; nothing while another action waits. */
  readonly grant: (agentId: string, request: GrantRequestView) => Promise<void>;
  /** Revokes a grant; nothing while another action waits. */
  readonly revoke: (agentId: string, grantId: string) => Promise<void>;
}

/**
 * The grant and revoke actions of the screen: one at a time, each sent
 * once and never again on its own. The result is a fixed sentence; the
 * list changes only with the state that the main process sends, or with a
 * new read of an agent that another device hosts, never from an answer.
 * `onRevoked` hears the agent of every revocation that ended, whatever its
 * outcome, so that the screen reads that agent's grants again (#345).
 */
export function createGrantActions(
  bridge: Pick<GrantBridge, "grant" | "revoke">,
  onView: (view: GrantActionsView) => void,
  onRevoked: (agentId: string) => void = () => {},
): GrantActions {
  let running = false;
  async function run<T>(
    call: () => Promise<T>,
    describe: (result: T) => string,
    notDone: string,
  ): Promise<void> {
    if (running) {
      return;
    }
    running = true;
    onView({ running, message: undefined });
    let message: string;
    try {
      // A bridge that throws at once counts as a call that failed too.
      message = describe(await call());
    } catch {
      message = `${notDone} ${GRANT_RESULT_MESSAGES.notSent}`;
    }
    running = false;
    onView({ running, message });
  }
  return Object.freeze({
    grant: (agentId: string, request: GrantRequestView) =>
      run(
        () => bridge.grant(agentId, request),
        describeGrantResult,
        GRANT_RESULT_MESSAGES.notGranted,
      ),
    revoke: async (agentId: string, grantId: string) => {
      if (running) {
        return;
      }
      await run(
        () => bridge.revoke(agentId, grantId),
        describeRevokeResult,
        GRANT_RESULT_MESSAGES.notRevoked,
      );
      onRevoked(agentId);
    },
  });
}
