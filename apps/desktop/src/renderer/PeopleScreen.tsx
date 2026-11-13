import { useEffect, useState } from "react";
import type {
  ClaimsBridge,
  InvitationActionsBridge,
  InvitationsBridge,
  JoinRequestActionsBridge,
  JoinRequestsBridge,
  PeopleActionsBridge,
  PeopleBridge,
} from "../shared/desktop-bridge.ts";
import {
  claimsCovered,
  IDLE_RECENT_CLAIMS,
  describeRecentClaims,
  type ClaimsScreenView,
  type RecentClaimsView,
} from "./claims-view.ts";
import {
  INVITATION_ACTION_MESSAGE_ID,
  InvitationCodeBox,
  InvitationQuestionBox,
  InvitationsPart,
  InviteButton,
  useInvitationActions,
  useInvitationsClock,
  useInvitationsScreen,
  type InvitationActionHandlers,
} from "./InvitationActions.tsx";
import {
  describeInvitations,
  IDLE_INVITATION_ACTIONS,
  isInvitationOffered,
  type InvitationActionRequest,
  type InvitationActionsView,
  type InvitationsScreenView,
} from "./invitations-view.ts";
import {
  JOIN_REQUEST_ACTION_MESSAGE_ID,
  JoinRequestQuestionBox,
  JoinRequestsPart,
  useJoinRequestActions,
  useJoinRequestsScreen,
  type JoinRequestActionHandlers,
} from "./JoinRequests.tsx";
import {
  describeJoinRequests,
  IDLE_JOIN_REQUEST_ACTIONS,
  isJoinRequestOffered,
  type JoinRequestActionsView,
  type JoinRequestsScreenView,
} from "./join-requests-view.ts";
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
import {
  CLAIM_ACTION_MESSAGE_ID,
  RecentClaimsPart,
  useClaimsScreen,
  useRecentClaims,
  type RecentClaimHandlers,
} from "./RecentClaims.tsx";

/**
 * The people of the selected workspace (#95, decision D3): the active
 * people with their roles and GitHub logins, the account's own person
 * marked, and the former members apart. The main process keeps them
 * current with the membership events. The screen offers the people
 * actions that the account's role allows (#95, D1); the list changes only
 * with the people that the main process sends. The owner and the admins
 * also see the open invitations, invite each unclaimed person, and revoke
 * invitations (#95, D2 and D3), and they see the pending join requests and
 * the blocked accounts and decide on them (#95, D1 and D3), and the recent
 * claims, with "Remove" through the people actions' question (#95, D8 and
 * D9).
 */
export function PeopleScreen({
  people,
  peopleActions,
  invitations,
  invitationActions,
  joinRequests,
  joinRequestActions,
  claims,
  shellDialogOpen = false,
}: {
  /** The people functions from the preload script; undefined outside Electron. */
  readonly people: PeopleBridge | undefined;
  /** The people actions from the preload script; undefined outside Electron. */
  readonly peopleActions: PeopleActionsBridge | undefined;
  /** The live invitations from the preload script; undefined outside Electron. */
  readonly invitations?: InvitationsBridge | undefined;
  /** The invitation actions from the preload script; undefined outside Electron. */
  readonly invitationActions?: InvitationActionsBridge | undefined;
  /** The join requests from the preload script; undefined outside Electron. */
  readonly joinRequests?: JoinRequestsBridge | undefined;
  /** The join request actions from the preload script; undefined outside Electron. */
  readonly joinRequestActions?: JoinRequestActionsBridge | undefined;
  /** The recent claims from the preload script; undefined outside Electron. */
  readonly claims?: ClaimsBridge | undefined;
  /**
   * Whether a modal dialog of the shell is open, the question before a
   * switch or the dialog of a create: the screen behind it is inert, so it
   * reports no claim as shown meanwhile.
   */
  readonly shellDialogOpen?: boolean | undefined;
}) {
  const view = usePeopleScreen(people);
  const invitationsView = useInvitationsScreen(invitations);
  const joinRequestsView = useJoinRequestsScreen(joinRequests);
  const claimsView = useClaimsScreen(claims);
  const peopleNow = usePeopleClock(view);
  const invitationsNow = useInvitationsClock(invitationsView);
  // The later of the two readings, so that both the offer and the
  // invitations end on time.
  const now = Math.max(peopleNow, invitationsNow);
  const { actions, handlers } = usePeopleActions(peopleActions, view, now);
  const invitationParts = useInvitationActions(
    invitationActions,
    invitations,
    view,
    invitationsView,
    now,
  );
  const joinRequestParts = useJoinRequestActions(
    { joinRequestActions, joinRequests, invitationActions },
    view,
    joinRequestsView,
  );
  const covered = claimsCovered({
    shell: shellDialogOpen === true,
    people: actions,
    invitations: invitationParts.actions,
    joinRequests: joinRequestParts.actions,
  });
  const claimParts = useRecentClaims(claims, view, claimsView, covered);
  return (
    <PeopleScreenContent
      view={view}
      now={now}
      actions={actions}
      handlers={handlers}
      invitations={invitationsView}
      invitationActions={invitationParts.actions}
      invitationHandlers={invitationParts.handlers}
      joinRequests={joinRequestsView}
      joinRequestActions={joinRequestParts.actions}
      joinRequestHandlers={joinRequestParts.handlers}
      claims={claimsView}
      claimActions={claimParts.view}
      claimHandlers={claimParts.handlers}
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
  /** The live invitations; unavailable by default. */
  readonly invitations?: InvitationsScreenView | undefined;
  /** What the screen shows of its invitation actions; idle by default. */
  readonly invitationActions?: InvitationActionsView | undefined;
  /**
   * The invitation actions' handlers; undefined without the bridges, with
   * no invitations part, no "Invite", and no code's dialog.
   */
  readonly invitationHandlers?: InvitationActionHandlers | undefined;
  /** The join requests; unavailable by default. */
  readonly joinRequests?: JoinRequestsScreenView | undefined;
  /** What the screen shows of its join request actions; idle by default. */
  readonly joinRequestActions?: JoinRequestActionsView | undefined;
  /**
   * The join request actions' handlers; undefined without the bridges, with
   * no join requests part, no question, and no code's dialog of its own.
   */
  readonly joinRequestHandlers?: JoinRequestActionHandlers | undefined;
  /** The recent claims; unavailable by default. */
  readonly claims?: ClaimsScreenView | undefined;
  /** What the screen shows of its recent claims beyond their state; idle by default. */
  readonly claimActions?: RecentClaimsView | undefined;
  /**
   * The recent claims' handlers; undefined without the bridge, with no
   * recent claims section and no paragraph for the refresh's sentence.
   */
  readonly claimHandlers?: RecentClaimHandlers | undefined;
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
 *
 * With the invitation handlers, the owner and the admins also get "Invite"
 * on each active unclaimed person and the open invitations below the
 * people (`describeInvitations`); the sentence of the last invitation
 * action sits in its own status paragraph next to the people actions' one.
 * One action of either kind runs at a time: while one runs, every action's
 * control of both kinds stays focusable and does nothing.
 *
 * With the join request handlers, the owner and the admins also see the
 * join requests below the open invitations (`describeJoinRequests`), while
 * the join requests do not say `not_allowed`; the sentence of the last join
 * request action sits in its own status paragraph after the invitation
 * actions' one. One action of any of the three kinds runs at a time, and
 * "Deny and invite instead" shows its invitation's code in a code dialog of
 * its own (D2).
 *
 * With the claim handlers, the owner and the admins also see the recent
 * claims (`describeRecentClaims`; #95, D8) first, below the hint and the
 * offer and above the people, so that the section is in view when the
 * screen opens, while the claims do not say `not_allowed`; the sentence of
 * the last refresh sits in its own status paragraph after the join request
 * actions' one. "Remove" on a claim is the people list's own removal of the
 * person, with the same question and the same focus afterwards (D9).
 */
export function PeopleScreenContent({
  view,
  dateFormat,
  timeFormat,
  now = Date.now(),
  actions = IDLE_PEOPLE_ACTIONS,
  handlers,
  invitations = { kind: "unavailable" },
  invitationActions = IDLE_INVITATION_ACTIONS,
  invitationHandlers,
  joinRequests = { kind: "unavailable" },
  joinRequestActions = IDLE_JOIN_REQUEST_ACTIONS,
  joinRequestHandlers,
  claims = { kind: "unavailable" },
  claimActions = IDLE_RECENT_CLAIMS,
  claimHandlers,
}: PeopleScreenContentProps) {
  const { status, workspaceName, lists, adminHint } =
    describePeopleScreen(view);
  const format = dateFormat ?? peopleDateFormat();
  const times = timeFormat ?? offerTimeFormat();
  const model =
    handlers === undefined ? undefined : describePeopleActions(view, now);
  const offer = model?.offer ?? null;
  const defineIn = model?.defineIn ?? null;
  const leave = model?.leave ?? null;
  const inert =
    actions.running || invitationActions.running || joinRequestActions.running;
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
  const invitationModel =
    invitationHandlers === undefined
      ? null
      : describeInvitations(view, invitations, now);
  const invites =
    invitationModel === null || invitationHandlers === undefined
      ? undefined
      : {
          requests: invitationModel.invites,
          inert,
          onStart: invitationHandlers.onStart,
        };
  const invitationQuestion =
    invitationActions.question !== undefined &&
    isInvitationOffered(invitationModel, invitationActions.question)
      ? invitationActions.question
      : undefined;
  const joinRequestModel =
    joinRequestHandlers === undefined
      ? null
      : describeJoinRequests(view, joinRequests);
  // A question whose action the screen no longer offers closes.
  const joinRequestDialog =
    joinRequestActions.dialog !== undefined &&
    isJoinRequestOffered(joinRequestModel, joinRequestActions.dialog.request)
      ? joinRequestActions.dialog
      : undefined;
  const claimModel =
    claimHandlers === undefined
      ? null
      : describeRecentClaims(
          view,
          claims,
          claimActions.marked,
          model?.personActions,
        );
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
      {invitationHandlers === undefined ? null : (
        <p
          className="people-status"
          id={INVITATION_ACTION_MESSAGE_ID}
          role="status"
        >
          {invitationActions.message ?? ""}
        </p>
      )}
      {joinRequestHandlers === undefined ? null : (
        <p
          className="people-status"
          id={JOIN_REQUEST_ACTION_MESSAGE_ID}
          role="status"
        >
          {joinRequestActions.message ?? ""}
        </p>
      )}
      {claimHandlers === undefined ? null : (
        <p className="people-status" id={CLAIM_ACTION_MESSAGE_ID} role="status">
          {claimActions.message ?? ""}
        </p>
      )}
      {adminHint ? (
        <p className="people-hint">{PEOPLE_MESSAGES.adminHint}</p>
      ) : null}
      {offer === null || handlers === undefined ? null : (
        <OwnershipOffer
          offer={offer}
          format={times}
          inert={inert}
          onStart={handlers.onStart}
        />
      )}
      {claimModel === null || claimHandlers === undefined ? null : (
        <RecentClaimsPart
          model={claimModel}
          dateFormat={format}
          timeFormat={times}
          inert={inert}
          onStart={handlers?.onStart}
          onRefresh={claimHandlers.onRefresh}
        />
      )}
      {lists === null ? null : (
        <>
          <PersonList
            people={lists.active}
            labelledBy={PEOPLE_TITLE_ID}
            format={format}
            actions={rowActions}
            invites={invites}
          />
          {defineIn === null || handlers === undefined ? null : (
            <DefinePersonForm
              workspaceId={defineIn}
              draft={actions.defineDraft}
              problem={actions.defineProblem}
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
      {invitationModel === null || invitationHandlers === undefined ? null : (
        <InvitationsPart
          model={invitationModel}
          format={times}
          inert={inert}
          onStart={invitationHandlers.onStart}
          onRefresh={invitationHandlers.onRefresh}
        />
      )}
      {joinRequestModel === null || joinRequestHandlers === undefined ? null : (
        <JoinRequestsPart
          model={joinRequestModel}
          dateFormat={format}
          timeFormat={times}
          inert={inert}
          onStart={joinRequestHandlers.onStart}
          onRefresh={joinRequestHandlers.onRefresh}
        />
      )}
      {leave === null || handlers === undefined ? null : (
        <LeaveWorkspace
          request={leave}
          inert={inert}
          onStart={handlers.onStart}
        />
      )}
      {handlers === undefined ? null : (
        <PeopleActionDialogBox
          dialog={dialog}
          onConfirm={handlers.onConfirm}
          onCancel={handlers.onCancel}
          onDraft={handlers.onDialogDraft}
        />
      )}
      {invitationHandlers === undefined ? null : (
        <>
          <InvitationQuestionBox
            question={invitationQuestion}
            onConfirm={invitationHandlers.onConfirm}
            onCancel={invitationHandlers.onCancel}
          />
          <InvitationCodeBox
            code={invitationActions.code}
            format={times}
            onClose={invitationHandlers.onCloseCode}
          />
        </>
      )}
      {joinRequestHandlers === undefined ? null : (
        <>
          <JoinRequestQuestionBox
            dialog={joinRequestDialog}
            options={joinRequestModel?.unclaimed ?? []}
            dateFormat={format}
            onConfirm={joinRequestHandlers.onConfirm}
            onCancel={joinRequestHandlers.onCancel}
            onDraft={joinRequestHandlers.onDraft}
            onChoose={joinRequestHandlers.onChoose}
          />
          <InvitationCodeBox
            code={joinRequestActions.code}
            format={times}
            onClose={joinRequestHandlers.onCloseCode}
          />
        </>
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

/** "Invite" on the active unclaimed people of a list, by member ID. */
interface RowInvites {
  readonly requests: ReadonlyMap<string, InvitationActionRequest>;
  readonly inert: boolean;
  readonly onStart: InvitationActionHandlers["onStart"];
}

function PersonList({
  people,
  labelledBy,
  format,
  actions,
  invites,
}: {
  readonly people: readonly PersonRow[];
  readonly labelledBy: string;
  readonly format: Intl.DateTimeFormat;
  /** Undefined for the former members, and without the bridge. */
  readonly actions: RowActions | undefined;
  /** Undefined for the former members, and without the invitation bridges. */
  readonly invites?: RowInvites | undefined;
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
          invites={invites}
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
  invites,
}: {
  readonly person: PersonRow;
  readonly format: Intl.DateTimeFormat;
  /** The ID of the name, by the person's place in the list, for its buttons. */
  readonly nameId: string;
  readonly actions: RowActions | undefined;
  readonly invites: RowInvites | undefined;
}) {
  const { github } = person;
  const requests = actions?.requests.get(person.memberId);
  const acts = actions !== undefined && requests !== undefined;
  const invite = invites?.requests.get(person.memberId);
  // "Invite" comes first, in the same row as the people actions.
  const inviteButton =
    invites === undefined || invite === undefined ? null : (
      <InviteButton
        request={invite}
        describedBy={nameId}
        inert={invites.inert}
        onStart={invites.onStart}
      />
    );
  return (
    <li className="person">
      <p className="person-name">
        <span
          dir="auto"
          id={acts || inviteButton !== null ? nameId : undefined}
        >
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
      {acts ? (
        <PersonActionButtons
          requests={requests}
          describedBy={nameId}
          inert={actions.inert}
          onStart={actions.onStart}
          leading={inviteButton}
        />
      ) : inviteButton === null ? null : (
        <div className="account-actions">{inviteButton}</div>
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
