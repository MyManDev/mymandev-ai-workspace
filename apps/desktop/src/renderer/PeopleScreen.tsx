import { useEffect, useState } from "react";
import type {
  PeopleActionsBridge,
  PeopleBridge,
} from "../shared/desktop-bridge.ts";
import {
  DefinePersonForm,
  LeaveWorkspace,
  OwnershipOffer,
  PEOPLE_ACTION_MESSAGE_ID,
  PEOPLE_TITLE_ID,
  PeopleActionDialogBox,
  PersonActionButtons,
  usePeopleActions,
  usePeopleClock,
  type PeopleActionHandlers,
} from "./PeopleActions.tsx";
import {
  describePeopleActions,
  IDLE_PEOPLE_ACTIONS,
  isOffered,
  offerTimeFormat,
  type PeopleActionRequest,
  type PeopleActionsView,
} from "./people-actions-view.ts";
import {
  describeMorePeople,
  describePeopleScreen,
  followPeople,
  formatPeopleDate,
  initialPeopleScreenView,
  PEOPLE_MESSAGES,
  peopleDateFormat,
  type PeopleScreenView,
  type PersonRow,
} from "./people-view.ts";

/**
 * The people of the selected workspace (#95, decision D3): the active
 * people with their roles and GitHub logins, the account's own person
 * marked, and the former members apart. The main process keeps them
 * current with the membership events. The screen offers the people
 * actions that the account's role allows (#95, D1); the list changes only
 * with the people that the main process sends.
 */
export function PeopleScreen({
  people,
  peopleActions,
}: {
  /** The people functions from the preload script; undefined outside Electron. */
  readonly people: PeopleBridge | undefined;
  /** The people actions from the preload script; undefined outside Electron. */
  readonly peopleActions: PeopleActionsBridge | undefined;
}) {
  const view = usePeopleScreen(people);
  const now = usePeopleClock(view);
  const { actions, handlers } = usePeopleActions(peopleActions, view);
  return (
    <PeopleScreenContent
      view={view}
      now={now}
      actions={actions}
      handlers={handlers}
    />
  );
}

export interface PeopleScreenContentProps {
  readonly view: PeopleScreenView;
  /**
   * The format of the dates, for tests. By default, a new
   * `peopleDateFormat` for each render, in the person's locale and the
   * system's time zone.
   */
  readonly dateFormat?: Intl.DateTimeFormat | undefined;
  /**
   * The format of the offer's end, for tests. By default, a new
   * `offerTimeFormat` for each render.
   */
  readonly timeFormat?: Intl.DateTimeFormat | undefined;
  /** The renderer's clock in milliseconds, for the end of the offer. */
  readonly now?: number | undefined;
  /** What the screen shows of its people actions; idle by default. */
  readonly actions?: PeopleActionsView | undefined;
  /** The people actions' handlers; undefined without the bridge, with no action shown. */
  readonly handlers?: PeopleActionHandlers | undefined;
}

/**
 * The screen for a view, without state. The status paragraph is always
 * rendered, empty when there is nothing to say, so that a screen reader
 * announces a new text. Display names are text that people entered, so
 * each one takes its direction from its own content (`dir="auto"`); a
 * GitHub login is shown in a monospace font, so that a display name cannot
 * pass for it (ADR 0014, "People and roles"). The heading stays "People",
 * a fixed landmark, and the selected workspace's name follows it as text;
 * it takes the focus without a tab stop (`tabIndex={-1}`) after an action
 * whose control leaves the page.
 *
 * With the handlers, the screen offers the actions that the account's role
 * allows (`describePeopleActions`), and the sentence of the last action
 * sits in its own status paragraph, always rendered, empty when there is
 * nothing to say. While an action runs, every action's control stays
 * focusable and does nothing (`aria-disabled`). No ID is shown: each
 * person's buttons are described by the name, whose element ID is its
 * place in the list.
 */
export function PeopleScreenContent({
  view,
  dateFormat,
  timeFormat,
  now = Date.now(),
  actions = IDLE_PEOPLE_ACTIONS,
  handlers,
}: PeopleScreenContentProps) {
  const { status, workspaceName, lists, adminHint } =
    describePeopleScreen(view);
  const format = dateFormat ?? peopleDateFormat();
  const model =
    handlers === undefined ? undefined : describePeopleActions(view, now);
  const offer = model?.offer ?? null;
  const defineIn = model?.defineIn ?? null;
  const leave = model?.leave ?? null;
  const inert = actions.running;
  const rowActions =
    model === undefined || handlers === undefined
      ? undefined
      : { requests: model.personActions, inert, onStart: handlers.onStart };
  // A question whose action the screen no longer offers closes.
  const dialog =
    actions.dialog !== undefined &&
    model !== undefined &&
    isOffered(model, actions.dialog.request)
      ? actions.dialog
      : undefined;
  return (
    <section aria-labelledby={PEOPLE_TITLE_ID}>
      <h2 id={PEOPLE_TITLE_ID} tabIndex={-1}>
        People
      </h2>
      {workspaceName === null ? null : (
        <p className="people-workspace">
          {"Workspace: "}
          <span dir="auto">{workspaceName}</span>
        </p>
      )}
      <p className="people-status" role="status">
        {status}
      </p>
      {handlers === undefined ? null : (
        <p
          className="people-status"
          id={PEOPLE_ACTION_MESSAGE_ID}
          role="status"
        >
          {actions.message ?? ""}
        </p>
      )}
      {adminHint ? (
        <p className="people-hint">{PEOPLE_MESSAGES.adminHint}</p>
      ) : null}
      {offer === null || handlers === undefined ? null : (
        <OwnershipOffer
          offer={offer}
          format={timeFormat ?? offerTimeFormat()}
          inert={inert}
          onStart={handlers.onStart}
        />
      )}
      {lists === null ? null : (
        <>
          <PersonList
            people={lists.active}
            labelledBy={PEOPLE_TITLE_ID}
            format={format}
            actions={rowActions}
          />
          {defineIn === null || handlers === undefined ? null : (
            <DefinePersonForm
              workspaceId={defineIn}
              draft={actions.defineDraft}
              inert={inert}
              onDraft={handlers.onDefineDraft}
              onDefine={handlers.onDefine}
            />
          )}
          {lists.former.length === 0 ? null : (
            <>
              <h3 className="people-heading" id="former-people-heading">
                Former members
              </h3>
              <PersonList
                people={lists.former}
                labelledBy="former-people-heading"
                format={format}
                actions={undefined}
              />
            </>
          )}
          {lists.morePeople === 0 ? null : (
            <p className="people-note">
              {describeMorePeople(lists.morePeople)}
            </p>
          )}
        </>
      )}
      {leave === null || handlers === undefined ? null : (
        <LeaveWorkspace
          request={leave}
          inert={inert}
          onStart={handlers.onStart}
        />
      )}
      <p className="placeholder-note">{PEOPLE_MESSAGES.actionsLater}</p>
      {handlers === undefined ? null : (
        <PeopleActionDialogBox
          dialog={dialog}
          onConfirm={handlers.onConfirm}
          onCancel={handlers.onCancel}
          onDraft={handlers.onDialogDraft}
        />
      )}
    </section>
  );
}

/** The actions on the people of a list, by member ID. */
interface RowActions {
  readonly requests: ReadonlyMap<string, readonly PeopleActionRequest[]>;
  readonly inert: boolean;
  readonly onStart: PeopleActionHandlers["onStart"];
}

function PersonList({
  people,
  labelledBy,
  format,
  actions,
}: {
  readonly people: readonly PersonRow[];
  readonly labelledBy: string;
  readonly format: Intl.DateTimeFormat;
  /** Undefined for the former members, and without the bridge. */
  readonly actions: RowActions | undefined;
}) {
  if (people.length === 0) {
    return null;
  }
  return (
    <ul className="people-list" aria-labelledby={labelledBy}>
      {people.map((person, index) => (
        <PersonItem
          key={person.memberId}
          person={person}
          format={format}
          nameId={`${labelledBy}-person-${String(index)}`}
          actions={actions}
        />
      ))}
    </ul>
  );
}

function PersonItem({
  person,
  format,
  nameId,
  actions,
}: {
  readonly person: PersonRow;
  readonly format: Intl.DateTimeFormat;
  /** The ID of the name, by the person's place in the list, for its buttons. */
  readonly nameId: string;
  readonly actions: RowActions | undefined;
}) {
  const { github } = person;
  const requests = actions?.requests.get(person.memberId);
  const acts = actions !== undefined && requests !== undefined;
  return (
    <li className="person">
      <p className="person-name">
        <span dir="auto" id={acts ? nameId : undefined}>
          {person.displayName}
        </span>
        {person.you ? (
          <span className="person-you">{` ${PEOPLE_MESSAGES.you}`}</span>
        ) : null}
      </p>
      {person.role === null ? null : (
        <p className="person-meta">{person.role}</p>
      )}
      {github === null ? (
        <p className="person-meta">{person.note}</p>
      ) : (
        <p className="person-meta">
          {"GitHub "}
          <span className="person-login" translate="no">
            {github.login}
          </span>
          {", last verified "}
          <time dateTime={github.verifiedAt}>
            {formatPeopleDate(github.verifiedAt, format)}
          </time>
        </p>
      )}
      {!acts ? null : (
        <PersonActionButtons
          requests={requests}
          describedBy={nameId}
          inert={actions.inert}
          onStart={actions.onStart}
        />
      )}
    </li>
  );
}

/** Follows the people while the screen is shown. */
function usePeopleScreen(bridge: PeopleBridge | undefined): PeopleScreenView {
  const [view, setView] = useState(() =>
    initialPeopleScreenView(bridge !== undefined),
  );
  useEffect(
    () => (bridge === undefined ? undefined : followPeople(bridge, setView)),
    [bridge],
  );
  return view;
}
