import { useEffect, useMemo, useRef, useState, type Ref } from "react";
import type {
  AgentBridge,
  GrantBridge,
  ProjectRepositoriesBridge,
} from "../shared/desktop-bridge.ts";
import {
  agentTimeFormat,
  followAgentActivity,
  initialAgentPanelView,
} from "./agent-view.ts";
import {
  agentGrantsToRead,
  askConfirmation,
  changeGrantForm,
  confirmedGrantOf,
  createGrantActions,
  describeGrantSection,
  endConfirmation,
  endHiddenConfirmation,
  focusAfterConfirmation,
  followGrants,
  GRANT_MESSAGES,
  IDLE_GRANT_ACTIONS,
  INITIAL_GRANT_FORM,
  initialGrantsView,
  needsProviderConnections,
  NO_AGENT_GRANTS,
  submitGrant,
  type AgentChoice,
  type AgentGrantsPanelView,
  type ConfirmationEnd,
  type ConnectionsPanelView,
  type GrantActions,
  type GrantActionsView,
  type GrantConfirmationView,
  type GrantFormState,
  type GrantFormView,
  type GrantSectionView,
} from "./grant-view.ts";
import type { PermissionCapability } from "./permission-view.ts";
import {
  followProjectRepositories,
  initialProjectRepositoriesView,
} from "./project-repositories-view.ts";
import { StatementText } from "./StatementText.tsx";

// The grant form and the grant list of the permission screen (#342), with
// the presentation rules of ADR 0015 (#77), and the grants of the owner's
// agents that another device hosts, which can only be revoked here (#345).
// The components below `PermissionGrants` use no hooks, so the tests render
// the markup and also call the components as functions, walk the returned
// elements, and invoke their event handlers; `grantSectionHandlers` is the
// hook's wiring without the hook.

/** What the person can do in the grant section. */
export interface GrantSectionHandlers {
  readonly onAgent: (agentId: string) => void;
  readonly onCapability: (capability: PermissionCapability) => void;
  readonly onScope: (scopeId: string) => void;
  readonly onExpiry: (expiryId: string) => void;
  /** "Grant": sends, or asks for the confirmation of the shell. */
  readonly onGrant: (agentId: string, form: GrantFormView) => void;
  /** The person confirmed the grant that the confirmation shows. */
  readonly onConfirm: (form: GrantFormView) => void;
  /** The person cancelled the confirmation: nothing is sent. */
  readonly onCancel: () => void;
  readonly onRevoke: (agentId: string, grantId: string) => void;
}

/** The ID of the sentence after an action, which a screen reader announces. */
export const GRANT_RESULT_ID = "grant-result";

/**
 * Where the hook puts the focus once a confirmation has closed
 * (`focusAfterConfirmation`): the form's "Grant" and the sentence after an
 * action.
 */
export interface GrantSectionFocus {
  readonly submit: Ref<HTMLButtonElement>;
  readonly result: Ref<HTMLParagraphElement>;
}

/**
 * The handlers of the section for the form state `current`: every change
 * goes through `changeGrantForm`, which ends a confirmation that waits;
 * "Grant" sends only a capability without its own confirmation and asks
 * for the confirmation of one with it; only the confirmation of the grant
 * that the form shows sends it, with `confirmedHighestRisk`. `onEnded`
 * hears how the person ended a confirmation that waited, for the focus.
 */
export function grantSectionHandlers(
  current: GrantFormState,
  update: (change: (state: GrantFormState) => GrantFormState) => void,
  actions: Pick<GrantActions, "grant" | "revoke"> | undefined,
  onEnded: (end: ConfirmationEnd) => void = () => {},
): GrantSectionHandlers {
  return {
    onAgent: (agentId) =>
      update((state) => changeGrantForm(state, { agentId })),
    onCapability: (capability) =>
      update((state) => changeGrantForm(state, { capability })),
    onScope: (scopeId) =>
      update((state) => changeGrantForm(state, { scopeId })),
    onExpiry: (expiryId) =>
      update((state) => changeGrantForm(state, { expiryId })),
    onGrant: (_agentId, shown) => {
      const submission = submitGrant(shown);
      if (submission.kind === "confirm") {
        const { pending } = submission;
        update((state) => askConfirmation(state, pending));
      } else if (submission.kind === "send" && actions !== undefined) {
        void actions.grant(submission.agentId, submission.request);
      }
    },
    onConfirm: (shown) => {
      const confirmed = confirmedGrantOf(current, shown);
      update(endConfirmation);
      const sent = confirmed !== null && actions !== undefined;
      if (sent) {
        void actions.grant(confirmed.agentId, confirmed.request);
      }
      // Only a confirmation that waited ends, and moves the focus.
      if (current.confirming !== null) {
        onEnded(sent ? "sent" : "not_sent");
      }
    },
    onCancel: () => {
      update(endConfirmation);
      if (current.confirming !== null) {
        onEnded("cancelled");
      }
    },
    onRevoke: (agentId, grantId) => {
      if (actions !== undefined) {
        void actions.revoke(agentId, grantId);
      }
    },
  };
}

function GrantForm({
  form,
  running,
  handlers,
  submitRef,
}: {
  readonly form: GrantFormView;
  readonly running: boolean;
  readonly handlers: GrantSectionHandlers;
  readonly submitRef: Ref<HTMLButtonElement> | undefined;
}) {
  const scopeLabel =
    form.scopeKind === "repository"
      ? GRANT_MESSAGES.repositoryLabel
      : GRANT_MESSAGES.connectionLabel;
  const choose =
    form.scopeKind === "repository"
      ? GRANT_MESSAGES.chooseRepository
      : GRANT_MESSAGES.chooseConnection;
  return (
    <form
      className="grant-form"
      aria-labelledby="grant-title"
      onSubmit={(event) => {
        event.preventDefault();
        handlers.onGrant(form.agentId, form);
      }}
    >
      <label htmlFor="grant-capability">{GRANT_MESSAGES.capabilityLabel}</label>
      <select
        id="grant-capability"
        value={form.capability}
        disabled={running}
        aria-describedby="grant-capability-about"
        onChange={(event) =>
          handlers.onCapability(event.target.value as PermissionCapability)
        }
      >
        {form.capabilities.map((choice) => (
          <option key={choice.capability} value={choice.capability}>
            {`${choice.capability} (${choice.riskLabel})`}
          </option>
        ))}
      </select>
      <div
        id="grant-capability-about"
        className="grant-capability"
        data-risk={form.risk}
      >
        <p className="capability-risk">{form.riskLabel}</p>
        <p>{form.meaning}</p>
        {[...form.details, ...form.statements].map((statement, index) => (
          <p key={index}>
            <StatementText statement={statement} />
          </p>
        ))}
      </div>
      <label htmlFor="grant-scope">{scopeLabel}</label>
      <select
        id="grant-scope"
        value={form.scopeId ?? ""}
        disabled={running || form.scopes.length === 0}
        aria-describedby={
          form.scopeNote === undefined ? undefined : "grant-scope-note"
        }
        onChange={(event) => handlers.onScope(event.target.value)}
      >
        <option value="" disabled>
          {choose}
        </option>
        {form.scopes.map((scope) => (
          <option key={scope.id} value={scope.id}>
            {scope.label}
          </option>
        ))}
      </select>
      {form.scopeNote === undefined ? null : (
        <p id="grant-scope-note" className="grant-note">
          {form.scopeNote}
        </p>
      )}
      <label htmlFor="grant-expiry">{GRANT_MESSAGES.expiryLabel}</label>
      <select
        id="grant-expiry"
        value={form.expiryId}
        disabled={running}
        aria-describedby={
          form.expiryNote === undefined ? undefined : "grant-expiry-note"
        }
        onChange={(event) => handlers.onExpiry(event.target.value)}
      >
        {form.expiries.map((choice) => (
          <option key={choice.id} value={choice.id}>
            {choice.label}
          </option>
        ))}
      </select>
      {form.expiryNote === undefined ? null : (
        <p id="grant-expiry-note" className="grant-note">
          {form.expiryNote}
        </p>
      )}
      <button
        ref={submitRef}
        type="submit"
        disabled={running || !form.ready || form.confirmation !== undefined}
      >
        {form.needsConfirmation
          ? GRANT_MESSAGES.submitConfirmation
          : GRANT_MESSAGES.submit}
      </button>
    </form>
  );
}

/**
 * The account's own agents: those that this device may grant for, and
 * those that another device hosts, whose grants can only be revoked here.
 * It stands outside the form, so that an agent without a form can be
 * chosen as well.
 */
function AgentPicker({
  agents,
  agentId,
  running,
  onAgent,
}: {
  readonly agents: readonly AgentChoice[];
  readonly agentId: string;
  readonly running: boolean;
  readonly onAgent: (agentId: string) => void;
}) {
  return (
    <div className="grant-agent">
      <label htmlFor="grant-agent">{GRANT_MESSAGES.agentLabel}</label>
      <select
        id="grant-agent"
        value={agentId}
        disabled={running}
        onChange={(event) => onAgent(event.target.value)}
      >
        {agents.map((agent) => (
          <option key={agent.id} value={agent.id}>
            {agent.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** The ID of the confirmation's text. */
export const GRANT_CONFIRM_TEXT_ID = "grant-confirm-text";
/** The ID of the grant that the confirmation shows. */
export const GRANT_CONFIRM_GRANT_ID = "grant-confirm-grant";

/** The ID of the confirmation's warning at `index`. */
export function grantConfirmWarningId(index: number): string {
  return `grant-confirm-warning-${index}`;
}

/**
 * The separate step of a highest-risk capability: what the person is asked
 * to confirm, the grant as the form shows it, and "Cancel" first, which
 * takes the focus. The group is described by its text, the grant, and its
 * warnings, so that a screen reader reads them when the focus enters it,
 * not only the group's name and "Cancel".
 */
function GrantConfirmation({
  form,
  confirmation,
  running,
  handlers,
}: {
  readonly form: GrantFormView;
  readonly confirmation: GrantConfirmationView;
  readonly running: boolean;
  readonly handlers: GrantSectionHandlers;
}) {
  const scopeLabel =
    form.scopeKind === "repository"
      ? GRANT_MESSAGES.repositoryLabel
      : GRANT_MESSAGES.connectionLabel;
  const described = [
    GRANT_CONFIRM_TEXT_ID,
    GRANT_CONFIRM_GRANT_ID,
    ...confirmation.statements.map((_, index) => grantConfirmWarningId(index)),
  ].join(" ");
  return (
    <div
      className="grant-confirmation"
      role="group"
      aria-labelledby="grant-confirm-title"
      aria-describedby={described}
      data-risk={form.risk}
    >
      <h4 id="grant-confirm-title">{GRANT_MESSAGES.confirmTitle}</h4>
      <p id={GRANT_CONFIRM_TEXT_ID}>{confirmation.text}</p>
      <dl id={GRANT_CONFIRM_GRANT_ID} className="grant-confirmation-grant">
        <dt>{GRANT_MESSAGES.agentLabel}</dt>
        <dd>{confirmation.agent}</dd>
        <dt>{GRANT_MESSAGES.capabilityLabel}</dt>
        <dd>
          <code>{confirmation.pending.request.capability}</code>
        </dd>
        <dt>{scopeLabel}</dt>
        <dd>{confirmation.scope}</dd>
        <dt>{GRANT_MESSAGES.expiryLabel}</dt>
        <dd>{confirmation.expiry}</dd>
      </dl>
      {confirmation.statements.map((statement, index) => (
        <p
          key={index}
          id={grantConfirmWarningId(index)}
          className="grant-warning"
        >
          <StatementText statement={statement} />
        </p>
      ))}
      <button
        type="button"
        autoFocus
        disabled={running}
        onClick={() => handlers.onCancel()}
      >
        {GRANT_MESSAGES.cancel}
      </button>{" "}
      <button
        type="button"
        disabled={running}
        onClick={() => handlers.onConfirm(form)}
      >
        {GRANT_MESSAGES.confirm}
      </button>
    </div>
  );
}

/**
 * The grant section: the account's own agents, the form for an agent that
 * this device may grant for, the confirmation of a highest-risk capability
 * while it waits, the selected agent's grants with a revoke control each,
 * also for an agent that another device hosts, and the sentence after the
 * last action.
 */
export function GrantSectionContent({
  view,
  actions,
  handlers,
  focus,
}: {
  readonly view: GrantSectionView;
  readonly actions: GrantActionsView;
  readonly handlers: GrantSectionHandlers;
  /** Where the hook puts the focus after a confirmation; optional, the hook passes it. */
  readonly focus?: GrantSectionFocus;
}) {
  // A subsection without a name, so that it adds no landmark region.
  return (
    <section className="grant-section">
      <h3 id="grant-title">{GRANT_MESSAGES.title}</h3>
      {view.kind === "message" ? (
        <p className="placeholder-note">{view.text}</p>
      ) : (
        <>
          {view.agentId === null ? null : (
            <AgentPicker
              agents={view.agents}
              agentId={view.agentId}
              running={actions.running}
              onAgent={handlers.onAgent}
            />
          )}
          {view.form === null ? null : (
            <GrantForm
              form={view.form}
              running={actions.running}
              handlers={handlers}
              submitRef={focus?.submit}
            />
          )}
          {view.form?.confirmation === undefined ? null : (
            <GrantConfirmation
              form={view.form}
              confirmation={view.form.confirmation}
              running={actions.running}
              handlers={handlers}
            />
          )}
          {view.notes.map((note) => (
            <p key={note} className="grant-note">
              {note}
            </p>
          ))}
          <p
            id={GRANT_RESULT_ID}
            ref={focus?.result}
            role="status"
            tabIndex={-1}
          >
            {actions.running ? GRANT_MESSAGES.running : actions.message}
          </p>
          {view.agentId === null ? null : (
            <GrantList
              agentId={view.agentId}
              view={view}
              running={actions.running}
              onRevoke={handlers.onRevoke}
            />
          )}
        </>
      )}
    </section>
  );
}

function GrantList({
  agentId,
  view,
  running,
  onRevoke,
}: {
  readonly agentId: string;
  readonly view: Extract<GrantSectionView, { kind: "form" }>;
  readonly running: boolean;
  readonly onRevoke: (agentId: string, grantId: string) => void;
}) {
  return (
    <>
      <h4 id="grant-list-title">{GRANT_MESSAGES.grantsTitle}</h4>
      {view.grantsNote === undefined ? null : (
        <p className="grant-note">{view.grantsNote}</p>
      )}
      {view.grants.length === 0 ? null : (
        <ul className="grant-list" aria-labelledby="grant-list-title">
          {view.grants.map((grant) => (
            <li
              key={grant.grantId}
              className="grant-item"
              data-expired={grant.expired ? "true" : undefined}
            >
              <code>{grant.capability}</code> <span>{grant.scope}</span>{" "}
              <span className="grant-expiry">{grant.expiry}</span>{" "}
              <button
                type="button"
                disabled={running}
                aria-label={`${GRANT_MESSAGES.revoke} ${grant.capability} on ${grant.scope}`}
                onClick={() => onRevoke(agentId, grant.grantId)}
              >
                {GRANT_MESSAGES.revoke}
              </button>
              {grant.statements.map((statement, index) => (
                <p key={index} className="grant-warning">
                  <StatementText statement={statement} />
                </p>
              ))}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** Follows a bridge's subscription while the section is shown. */
function useFollow<V>(
  available: boolean,
  initial: (available: boolean) => V,
  follow: ((onView: (view: V) => void) => () => void) | undefined,
): V {
  const [view, setView] = useState(() => initial(available));
  useEffect(
    () => (follow === undefined ? undefined : follow(setView)),
    [follow],
  );
  return view;
}

/**
 * Reads this device's provider connections while the section is shown, only
 * while an agent is grantable here (`needed`), and again each time that
 * changes from none to some. An answer that comes after the section is
 * gone, or after no agent is grantable any more, is dropped.
 */
function useConnections(
  grants: GrantBridge | undefined,
  needed: boolean,
): ConnectionsPanelView {
  const [view, setView] = useState<ConnectionsPanelView>({ kind: "pending" });
  useEffect(() => {
    if (grants === undefined || !needed) {
      return undefined;
    }
    let live = true;
    grants.listProviderConnections().then(
      (result) => {
        if (live) {
          setView({ kind: "known", result });
        }
      },
      () => {
        if (live) {
          setView({
            kind: "known",
            result: { outcome: "refused", reason: "failed" },
          });
        }
      },
    );
    return () => {
      live = false;
    };
  }, [grants, needed]);
  return view;
}

/**
 * Reads the grants of `agentId`, an agent that another device hosts, while
 * the section shows it (`agentGrantsToRead`), and again for each new
 * `refresh`, after a revocation (#345). Nothing is read while no such agent
 * is selected. A new agent waits for its own answer; a read again keeps the
 * list until its answer comes. An answer that comes after the section is
 * gone, or after another agent was selected, is dropped.
 */
function useAgentGrants(
  grants: GrantBridge | undefined,
  agentId: string | null,
  refresh: number,
): AgentGrantsPanelView {
  const [view, setView] = useState<AgentGrantsPanelView>(NO_AGENT_GRANTS);
  useEffect(() => {
    if (grants === undefined || agentId === null) {
      return undefined;
    }
    let live = true;
    setView((current) =>
      current.kind === "known" && current.agentId === agentId
        ? current
        : { kind: "pending", agentId },
    );
    grants.listAgentGrants(agentId).then(
      (result) => {
        if (live) {
          setView({ kind: "known", agentId, result });
        }
      },
      () => {
        if (live) {
          setView({
            kind: "known",
            agentId,
            result: { outcome: "refused", reason: "failed" },
          });
        }
      },
    );
    return () => {
      live = false;
    };
  }, [grants, agentId, refresh]);
  return view;
}

/**
 * The grant section of the permission screen, with the open project's
 * agents, its registered repositories, the grants of its agents, the
 * grants of the account's agents that another device hosts, and this
 * device's provider connections. Without the bridges, outside Electron, it
 * says that granting is not available.
 */
export function PermissionGrants({
  agents,
  projectRepositories,
  grants,
}: {
  readonly agents: AgentBridge | undefined;
  readonly projectRepositories: ProjectRepositoriesBridge | undefined;
  readonly grants: GrantBridge | undefined;
}) {
  const available = agents !== undefined && grants !== undefined;
  const agentView = useFollow(
    available,
    initialAgentPanelView,
    useMemo(
      () =>
        agents === undefined || grants === undefined
          ? undefined
          : (onView: Parameters<typeof followAgentActivity>[1]) =>
              followAgentActivity(agents, onView),
      [agents, grants],
    ),
  );
  const repositoryView = useFollow(
    projectRepositories !== undefined,
    initialProjectRepositoriesView,
    useMemo(
      () =>
        projectRepositories === undefined
          ? undefined
          : (onView: Parameters<typeof followProjectRepositories>[1]) =>
              followProjectRepositories(projectRepositories, onView),
      [projectRepositories],
    ),
  );
  const grantView = useFollow(
    grants !== undefined,
    initialGrantsView,
    useMemo(
      () =>
        grants === undefined
          ? undefined
          : (onView: Parameters<typeof followGrants>[1]) =>
              followGrants(grants, onView),
      [grants],
    ),
  );
  const connections = useConnections(
    grants,
    needsProviderConnections(agentView),
  );
  const [form, setForm] = useState<GrantFormState>(INITIAL_GRANT_FORM);
  const [actionsView, setActionsView] =
    useState<GrantActionsView>(IDLE_GRANT_ACTIONS);
  // Each revocation reads the agent's grants again when another device
  // hosts it; the grant state follows the main process on its own.
  const [revocations, setRevocations] = useState(0);
  const actions = useMemo(
    () =>
      grants === undefined
        ? undefined
        : createGrantActions(grants, setActionsView, () =>
            setRevocations((count) => count + 1),
          ),
    [grants],
  );
  const agentGrants = useAgentGrants(
    grants,
    agentGrantsToRead(agentView, form),
    revocations,
  );
  const view = describeGrantSection({
    agents: agentView,
    repositories: repositoryView,
    grants: grantView,
    agentGrants,
    connections,
    form,
    now: Date.now(),
    timeFormat: agentTimeFormat(),
  });
  // Once the person ends a confirmation, the focus goes where
  // `focusAfterConfirmation` says, rather than being lost with its buttons.
  const ended = useRef<ConfirmationEnd | null>(null);
  const submitRef = useRef<HTMLButtonElement>(null);
  const resultRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    const end = ended.current;
    if (end === null) {
      return;
    }
    ended.current = null;
    const target = focusAfterConfirmation(end, view, actionsView);
    if (target === "submit") {
      submitRef.current?.focus();
    } else if (target === "result") {
      resultRef.current?.focus();
    }
  });
  // A confirmation that the section no longer shows ends, so that it does
  // not come back and take the focus once the form shows its grant again.
  const hidden =
    endHiddenConfirmation(form, view) === form ? null : form.confirming;
  useEffect(() => {
    if (hidden !== null) {
      setForm((state) =>
        state.confirming === hidden ? endConfirmation(state) : state,
      );
    }
  }, [hidden]);
  return (
    <GrantSectionContent
      view={view}
      actions={actionsView}
      handlers={grantSectionHandlers(form, setForm, actions, (end) => {
        ended.current = end;
      })}
      focus={{ submit: submitRef, result: resultRef }}
    />
  );
}
