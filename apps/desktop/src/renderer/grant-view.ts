import {
  CAPABILITY_RISK,
  CAPABILITY_SCOPE,
} from "@mymandev/permissions/capabilities";
import type { GrantBridge } from "../shared/desktop-bridge.ts";
import type {
  GrantCapabilityRefusal,
  GrantCapabilityResult,
  GrantRequestView,
  GrantsView,
  ProviderConnectionReadProblem,
  ProviderConnectionsResult,
  ProviderConnectionView,
  RevokeGrantRefusal,
  RevokeGrantResult,
} from "../shared/ipc-contract.ts";
import type { AgentPanelView } from "./agent-view.ts";
import { formatAgentTime } from "./agent-view.ts";
import type { PermissionCapability } from "./permission-view.ts";
import type { ProjectRepositoriesPanelView } from "./project-repositories-view.ts";
import { describeWait } from "./wait-text.ts";

// The grant form and the grant list of the permission screen (#342): which
// agents this device may grant for, one capability on one scope with an
// optional expiry, and the selected agent's grants with a revoke control.
// The presentation rules of ADR 0015 (a separate confirmation, a proposed
// expiry for the shell, the conditional warnings) are #77; until then a
// highest-risk capability, `terminal.execute`, is not offered. The main
// process checks every value again, and the server decides each grant.

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

/** What the screen knows about this device's provider connections. */
export type ConnectionsPanelView =
  | { readonly kind: "pending" }
  | { readonly kind: "known"; readonly result: ProviderConnectionsResult };

/**
 * The capabilities that the form offers: every capability whose risk is
 * not `highest`. A highest-risk capability needs the separate confirmation
 * and the proposed expiry of ADR 0015, which #77 adds; until then the form
 * does not offer it, and the main process refuses it as well.
 */
export const OFFERED_CAPABILITIES: readonly PermissionCapability[] =
  Object.freeze(
    (Object.keys(CAPABILITY_RISK) as PermissionCapability[]).filter(
      (capability) =>
        Object.hasOwn(CAPABILITY_RISK, capability) &&
        CAPABILITY_RISK[capability] !== "highest",
    ),
  );

/** The capability that the form starts with. */
export const INITIAL_CAPABILITY: PermissionCapability = "repo.read";

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
 * without one. The form does not offer it until #77.
 */
export function expiryChoices(
  capability: PermissionCapability,
): readonly ExpiryChoice[] {
  return capability === "terminal.execute"
    ? EXPIRY_CHOICES.filter((choice) => choice.seconds !== null)
    : EXPIRY_CHOICES;
}

/** What the person chose in the form. */
export interface GrantFormState {
  readonly agentId: string | null;
  readonly capability: PermissionCapability;
  readonly scopeId: string | null;
  readonly expiryId: string;
}

export const INITIAL_GRANT_FORM: GrantFormState = Object.freeze({
  agentId: null,
  capability: INITIAL_CAPABILITY,
  scopeId: null,
  expiryId: "none",
});

/** The fixed texts of the grant section. */
export const GRANT_MESSAGES = Object.freeze({
  title: "Grant a permission",
  unavailable: "Granting permissions is not available here.",
  pending: "Checking the agents and their permissions.",
  noProject:
    "Permissions can be granted once this device is signed in and the project is open.",
  noGrantableAgent:
    "No agent of yours in this project is hosted on this device. Only an agent's owner grants it permissions, and only from the device that hosts the agent.",
  shellLater:
    "The highest-risk permission, terminal.execute, cannot be granted here yet.",
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
  submit: "Grant",
  grantsTitle: "Permissions of this agent",
  grantsUnavailable:
    "The permissions of this agent cannot be shown now. They appear once this device has read its grants from the server.",
  noGrants: "This agent has no permissions yet.",
  revoke: "Revoke",
  neverExpires: "Does not expire",
  unknownRepository: "A repository that is no longer listed",
  unknownConnection: "An AI provider connection that is no longer listed",
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

/** One grant of the selected agent, as the list shows it. */
export interface GrantItemView {
  readonly grantId: string;
  readonly capability: PermissionCapability;
  /** The repository's name or the connection's label. */
  readonly scope: string;
  /** When it expires or expired, or that it does not. */
  readonly expiry: string;
  readonly expired: boolean;
}

/** The grant form, for an agent that this device may grant for. */
export interface GrantFormView {
  readonly agents: readonly Choice[];
  readonly agentId: string;
  readonly capabilities: readonly PermissionCapability[];
  readonly capability: PermissionCapability;
  /** `repository` or `provider_connection`: the label of the scope list. */
  readonly scopeKind: "repository" | "provider_connection";
  readonly scopes: readonly Choice[];
  readonly scopeId: string | null;
  /** Why no scope can be chosen, if none can. */
  readonly scopeNote: string | undefined;
  readonly expiries: readonly ExpiryChoice[];
  readonly expiryId: string;
  /** Whether the form can be sent: a scope is chosen. */
  readonly ready: boolean;
}

/** The grant section of the permission screen. */
export type GrantSectionView =
  | { readonly kind: "message"; readonly text: string }
  | {
      readonly kind: "form";
      /** Null while this device may grant for no agent of the project. */
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
 * The grant section: a message while the agents are not known, else the
 * form for the agents that this device may grant for (`grantableHere`),
 * and the selected agent's grants. The selection falls back to the first
 * such agent, and a scope or an expiry that is no longer offered is no
 * longer chosen.
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
  const grantable = state.agents.filter((agent) => agent.grantableHere);
  if (grantable.length === 0) {
    return {
      kind: "form",
      form: null,
      notes: [GRANT_MESSAGES.noGrantableAgent],
      grants: [],
      grantsNote: undefined,
    };
  }
  const agent =
    grantable.find((item) => item.id === input.form.agentId) ?? grantable[0]!;
  const capability = OFFERED_CAPABILITIES.includes(input.form.capability)
    ? input.form.capability
    : INITIAL_CAPABILITY;
  const scopeKind = CAPABILITY_SCOPE[capability];
  const { scopes, scopeNote, names } = scopeChoices(input, scopeKind);
  const scopeId = scopes.some((scope) => scope.id === input.form.scopeId)
    ? input.form.scopeId
    : null;
  const expiries = expiryChoices(capability);
  const expiryId = expiries.some((choice) => choice.id === input.form.expiryId)
    ? input.form.expiryId
    : expiries[0]!.id;
  const form: GrantFormView = {
    agents: grantable.map((item) => ({ id: item.id, label: item.name })),
    agentId: agent.id,
    capabilities: OFFERED_CAPABILITIES,
    capability,
    scopeKind,
    scopes,
    scopeId,
    scopeNote,
    expiries,
    expiryId,
    ready: scopeId !== null,
  };
  const listed = grantList(input, agent.id, names);
  return {
    kind: "form",
    form,
    notes: [GRANT_MESSAGES.shellLater],
    ...listed,
  };
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

/** The selected agent's grants, or why they cannot be shown. */
function grantList(
  input: GrantSectionInput,
  agentId: string,
  names: ReadonlyMap<string, string>,
): {
  readonly grants: readonly GrantItemView[];
  readonly grantsNote: string | undefined;
} {
  const { grants } = input;
  if (
    grants.kind !== "known" ||
    !grants.state.usable ||
    grants.state.projectId === null
  ) {
    return { grants: [], grantsNote: GRANT_MESSAGES.grantsUnavailable };
  }
  const items = grants.state.grants
    .filter((grant) => grant.agentId === agentId)
    .map((grant): GrantItemView => {
      const scopeId = grant.repositoryId ?? grant.providerConnectionId ?? "";
      const scope =
        names.get(scopeId) ??
        (grant.repositoryId === null
          ? GRANT_MESSAGES.unknownConnection
          : GRANT_MESSAGES.unknownRepository);
      const expired =
        grant.expired ||
        (grant.expiresAt !== null && input.now >= Date.parse(grant.expiresAt));
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
      };
    });
  return {
    grants: items,
    grantsNote: items.length === 0 ? GRANT_MESSAGES.noGrants : undefined,
  };
}

/** The request that the form sends, or null while it is not ready. */
export function grantRequestOf(form: GrantFormView): GrantRequestView | null {
  if (!form.ready || form.scopeId === null) {
    return null;
  }
  const expiry = form.expiries.find((choice) => choice.id === form.expiryId);
  if (expiry === undefined) {
    return null;
  }
  return {
    capability: form.capability,
    scopeId: form.scopeId,
    lifetimeSeconds: expiry.seconds,
  };
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
 * list changes only with the state that the main process sends, never from
 * an answer.
 */
export function createGrantActions(
  bridge: Pick<GrantBridge, "grant" | "revoke">,
  onView: (view: GrantActionsView) => void,
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
    revoke: (agentId: string, grantId: string) =>
      run(
        () => bridge.revoke(agentId, grantId),
        describeRevokeResult,
        GRANT_RESULT_MESSAGES.notRevoked,
      ),
  });
}
