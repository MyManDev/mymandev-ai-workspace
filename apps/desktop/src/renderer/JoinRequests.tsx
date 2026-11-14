import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type {
  InvitationActionsBridge,
  JoinRequestActionsBridge,
  JoinRequestsBridge,
} from "../shared/desktop-bridge.ts";
import { focusesTitleAfterAction } from "./device-view.ts";
import { focusesTitleAfterLeave } from "./join-invitation-view.ts";
import {
  createJoinRequestActions,
  describeJoinRequestQuestion,
  followJoinRequests,
  IDLE_JOIN_REQUEST_ACTIONS,
  initialJoinRequestsScreenView,
  JOIN_REQUEST_ACTION_LABELS,
  JOIN_REQUEST_MESSAGES,
  JOIN_REQUEST_QUESTION_MESSAGES,
  joinRequestDialogsOpen,
  type BlockedRequestRow,
  type InviteOption,
  type JoinRequestActionRequest,
  type JoinRequestActionsView,
  type JoinRequestDialog,
  type JoinRequestsModel,
  type JoinRequestsScreenView,
  type PendingRequestRow,
} from "./join-requests-view.ts";
import { PEOPLE_TITLE_ID } from "./PeopleActions.tsx";
import {
  focusesTitleAfterClose,
  PEOPLE_ACTION_MESSAGES,
} from "./people-actions-view.ts";
import { formatPeopleDate, type PeopleScreenView } from "./people-view.ts";

/** The ID of the paragraph with the sentence of the last join request action. */
export const JOIN_REQUEST_ACTION_MESSAGE_ID = "join-request-action-message";

/** The ID of the heading of the join requests. */
export const JOIN_REQUESTS_HEADING_ID = "join-requests-heading";

/** The ID of the heading of the blocked accounts. */
export const BLOCKED_HEADING_ID = "blocked-accounts-heading";

/** What the people screen does on its join request actions; undefined without the bridges. */
export interface JoinRequestActionHandlers {
  /** Starts an action that the screen offers; gets the button that was clicked. */
  readonly onStart: (
    request: JoinRequestActionRequest,
    button: Element | null,
  ) => void;
  /** Runs the action of the open question. */
  readonly onConfirm: () => void;
  /** Closes the open question without the action. */
  readonly onCancel: () => void;
  /** Changes the name in the field of an open approval. */
  readonly onDraft: (text: string) => void;
  /** Chooses the unclaimed person, by member ID, whom an open "Deny and invite instead" invites. */
  readonly onChoose: (memberId: string) => void;
  /** Closes the code's dialog, which drops the code. */
  readonly onCloseCode: () => void;
  /** Asks the main process to load the join requests again. */
  readonly onRefresh: () => void;
}

/**
 * A button of a join request action. While an action runs it stays
 * focusable and does nothing (`aria-disabled`), like the people actions'
 * buttons.
 */
function ActionButton({
  label,
  describedBy,
  inert,
  onClick,
}: {
  readonly label: string;
  readonly describedBy: string | undefined;
  readonly inert: boolean;
  readonly onClick: (button: Element | null) => void;
}) {
  return (
    <button
      type="button"
      className="panel-action"
      aria-describedby={describedBy}
      aria-disabled={inert ? "true" : undefined}
      onClick={
        inert
          ? undefined
          : (event: { readonly currentTarget: Element | null }) =>
              onClick(event.currentTarget)
      }
    >
      {label}
    </button>
  );
}

/** A time of the join requests in `format`. A timestamp that is not a date stays as it is. */
function formatTime(timestamp: string, format: Intl.DateTimeFormat): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? timestamp : format.format(date);
}

/** A login in the monospace font, never translated, so that a name cannot pass for it. */
function Login({ login }: { readonly login: string }) {
  return (
    <span className="person-login" translate="no">
      {login}
    </span>
  );
}

/**
 * The requester's GitHub login with the date it was last verified, and the
 * creation date of that GitHub account, as #257's view gives them; "No
 * GitHub login" for a blocked account whose data was erased.
 */
function Requester({
  login,
  verifiedAt,
  accountCreatedAt,
  dateFormat,
}: {
  readonly login: string | null;
  readonly verifiedAt: string | null;
  readonly accountCreatedAt: string | null;
  readonly dateFormat: Intl.DateTimeFormat;
}) {
  return (
    <>
      {login === null ? (
        <p className="person-meta">{JOIN_REQUEST_MESSAGES.noLogin}</p>
      ) : (
        <p className="person-meta">
          {JOIN_REQUEST_MESSAGES.github}
          <Login login={login} />
          {verifiedAt === null ? null : (
            <>
              {JOIN_REQUEST_MESSAGES.verified}
              <time dateTime={verifiedAt}>
                {formatPeopleDate(verifiedAt, dateFormat)}
              </time>
            </>
          )}
        </p>
      )}
      {accountCreatedAt === null ? null : (
        <p className="person-meta">
          {JOIN_REQUEST_MESSAGES.accountCreated}
          <time dateTime={accountCreatedAt}>
            {formatPeopleDate(accountCreatedAt, dateFormat)}
          </time>
        </p>
      )}
    </>
  );
}

/**
 * The join requests, for the owner and the admins: a heading, a status
 * paragraph that is always rendered, empty when there is nothing to say,
 * the line about new requests with "Pause new requests" or "Accept new
 * requests again", the pending requests with their actions and "Deny all",
 * the blocked accounts with "Unblock", and "Refresh the join requests".
 * Each request shows its requested name as text with `dir="auto"`, the
 * requester's GitHub login in the monospace font with the date it was last
 * verified, the creation date of that GitHub account, and its end or its
 * block time; dates are in `dateFormat`, times in `timeFormat`, the people
 * screen's shared formats. Each request's buttons are described by the
 * name, whose element ID is the request's place in its list, never its ID.
 */
export function JoinRequestsPart({
  model,
  dateFormat,
  timeFormat,
  inert,
  onStart,
  onRefresh,
}: {
  readonly model: JoinRequestsModel;
  readonly dateFormat: Intl.DateTimeFormat;
  readonly timeFormat: Intl.DateTimeFormat;
  readonly inert: boolean;
  readonly onStart: JoinRequestActionHandlers["onStart"];
  readonly onRefresh: () => void;
}) {
  const { pause } = model;
  return (
    <section
      className="join-requests"
      aria-labelledby={JOIN_REQUESTS_HEADING_ID}
    >
      <h3 className="people-heading" id={JOIN_REQUESTS_HEADING_ID}>
        {JOIN_REQUEST_MESSAGES.heading}
      </h3>
      <p className="people-status" role="status">
        {model.status}
      </p>
      {pause === null ? null : (
        <div className="people-offer">
          <p id="join-requests-pause-line">
            {pause.pausedAt === null ? (
              JOIN_REQUEST_MESSAGES.accepting
            ) : (
              <>
                {JOIN_REQUEST_MESSAGES.pausedSince}
                <time dateTime={pause.pausedAt}>
                  {formatTime(pause.pausedAt, timeFormat)}
                </time>
                {JOIN_REQUEST_MESSAGES.pausedAfter}
              </>
            )}
          </p>
          <div className="account-actions">
            <ActionButton
              label={JOIN_REQUEST_ACTION_LABELS[pause.request.kind]}
              describedBy="join-requests-pause-line"
              inert={inert}
              onClick={(button) => onStart(pause.request, button)}
            />
          </div>
        </div>
      )}
      {model.pending.length === 0 ? null : (
        <ul className="people-list" aria-labelledby={JOIN_REQUESTS_HEADING_ID}>
          {model.pending.map((row, index) => (
            <PendingItem
              key={row.joinRequestId}
              row={row}
              nameId={`${JOIN_REQUESTS_HEADING_ID}-request-${String(index)}`}
              dateFormat={dateFormat}
              timeFormat={timeFormat}
              inert={inert}
              onStart={onStart}
            />
          ))}
        </ul>
      )}
      <div className="account-actions">
        {model.denyAll === null ? null : (
          <ActionButton
            label={JOIN_REQUEST_ACTION_LABELS.denyAll}
            describedBy={undefined}
            inert={inert}
            onClick={(button) => {
              if (model.denyAll !== null) {
                onStart(model.denyAll, button);
              }
            }}
          />
        )}
        <ActionButton
          label={JOIN_REQUEST_MESSAGES.refresh}
          describedBy={undefined}
          inert={inert}
          onClick={() => onRefresh()}
        />
      </div>
      {model.blocked.length === 0 ? null : (
        <>
          <h4 className="people-heading" id={BLOCKED_HEADING_ID}>
            {JOIN_REQUEST_MESSAGES.blockedHeading}
          </h4>
          <ul className="people-list" aria-labelledby={BLOCKED_HEADING_ID}>
            {model.blocked.map((row, index) => (
              <BlockedItem
                key={row.joinRequestId}
                row={row}
                nameId={`${BLOCKED_HEADING_ID}-request-${String(index)}`}
                dateFormat={dateFormat}
                timeFormat={timeFormat}
                inert={inert}
                onStart={onStart}
              />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function PendingItem({
  row,
  nameId,
  dateFormat,
  timeFormat,
  inert,
  onStart,
}: {
  readonly row: PendingRequestRow;
  readonly nameId: string;
  readonly dateFormat: Intl.DateTimeFormat;
  readonly timeFormat: Intl.DateTimeFormat;
  readonly inert: boolean;
  readonly onStart: JoinRequestActionHandlers["onStart"];
}) {
  return (
    <li className="person">
      <p className="person-name">
        <span dir="auto" id={nameId}>
          {row.requestedName}
        </span>
      </p>
      <Requester
        login={row.login}
        verifiedAt={row.verifiedAt}
        accountCreatedAt={row.accountCreatedAt}
        dateFormat={dateFormat}
      />
      <p className="person-meta">
        {JOIN_REQUEST_MESSAGES.expires}
        <time dateTime={row.expiresAt}>
          {formatTime(row.expiresAt, timeFormat)}
        </time>
      </p>
      <div className="account-actions">
        {row.actions.map((request) => (
          <ActionButton
            key={request.kind}
            label={JOIN_REQUEST_ACTION_LABELS[request.kind]}
            describedBy={nameId}
            inert={inert}
            onClick={(button) => onStart(request, button)}
          />
        ))}
      </div>
    </li>
  );
}

function BlockedItem({
  row,
  nameId,
  dateFormat,
  timeFormat,
  inert,
  onStart,
}: {
  readonly row: BlockedRequestRow;
  readonly nameId: string;
  readonly dateFormat: Intl.DateTimeFormat;
  readonly timeFormat: Intl.DateTimeFormat;
  readonly inert: boolean;
  readonly onStart: JoinRequestActionHandlers["onStart"];
}) {
  return (
    <li className="person">
      <p className="person-name">
        <span dir="auto" id={nameId}>
          {row.requestedName}
        </span>
      </p>
      <Requester
        login={row.login}
        verifiedAt={row.verifiedAt}
        accountCreatedAt={row.accountCreatedAt}
        dateFormat={dateFormat}
      />
      <p className="person-meta">
        {JOIN_REQUEST_MESSAGES.blockedAt}
        <time dateTime={row.blockedAt}>
          {formatTime(row.blockedAt, timeFormat)}
        </time>
      </p>
      <div className="account-actions">
        <ActionButton
          label={JOIN_REQUEST_ACTION_LABELS.unblock}
          describedBy={nameId}
          inert={inert}
          onClick={(button) => onStart(row.unblock, button)}
        />
      </div>
    </li>
  );
}

export interface JoinRequestQuestionProps {
  /** The open question, or undefined when none is open. */
  readonly dialog: JoinRequestDialog | undefined;
  /** The active unclaimed people whom "Deny and invite instead" may invite. */
  readonly options: readonly InviteOption[];
  /** The format of the creation date of the requester's GitHub account. */
  readonly dateFormat: Intl.DateTimeFormat;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly onDraft: (text: string) => void;
  readonly onChoose: (memberId: string) => void;
}

/** What `syncModal` uses of a dialog element. */
export interface ModalElement {
  readonly open: boolean;
  readonly showModal: () => void;
  readonly close: () => void;
}

/**
 * Opens `dialog` as a modal dialog of the page (`showModal`, never the
 * non-modal `show`, so that the rest of the page is inert) while `open`
 * holds, and closes it afterwards.
 */
export function syncModal(dialog: ModalElement | null, open: boolean): void {
  if (dialog === null) {
    return;
  }
  if (open && !dialog.open) {
    dialog.showModal();
  } else if (!open && dialog.open) {
    dialog.close();
  }
}

/**
 * The question before a join request action that asks first, as a modal
 * dialog of the page (`showModal`), like the people actions' question: the
 * rest of the page is inert until the person answers, and Escape cancels.
 * Closing the dialog returns the focus to the action's button.
 */
export function JoinRequestQuestionBox(props: JoinRequestQuestionProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const open = props.dialog !== undefined;
  useEffect(() => syncModal(dialogRef.current, open), [open]);
  return <JoinRequestQuestionContent {...props} dialogRef={dialogRef} />;
}

/**
 * The dialog for a question, without state. The element stays in the page
 * while no question is open, empty and closed. The requested name is text
 * with `dir="auto"`, followed by the requester's GitHub login in the
 * monospace font, and describes the dialog before the sentence; the
 * questions of an approval and of "Deny and invite instead" also show the
 * creation date of that GitHub account, which they ask to check. An
 * approval has a name field that starts with the requested name; "Deny and
 * invite instead" has a group of choices, one for each active unclaimed
 * person by name. Each has an alert for its problem inside the dialog,
 * because the page behind it is inert; like the people actions' name
 * fields, the name field has no `maxLength`. "Cancel" comes first.
 */
export function JoinRequestQuestionContent({
  dialog,
  options,
  dateFormat,
  onConfirm,
  onCancel,
  onDraft,
  onChoose,
  dialogRef,
}: JoinRequestQuestionProps & {
  readonly dialogRef?: RefObject<HTMLDialogElement | null>;
}) {
  const question =
    dialog === undefined
      ? undefined
      : describeJoinRequestQuestion(dialog.request);
  if (dialog === undefined || question === undefined) {
    return <dialog ref={dialogRef} className="people-dialog" />;
  }
  const { request } = dialog;
  const named = "name" in request;
  const accountCreatedAt =
    request.kind === "approve" || request.kind === "invite"
      ? request.accountCreatedAt
      : undefined;
  const describedBy = [
    named ? "join-request-dialog-name" : undefined,
    accountCreatedAt === undefined ? undefined : "join-request-dialog-account",
    "join-request-dialog-text",
  ].filter((id) => id !== undefined);
  return (
    <dialog
      ref={dialogRef}
      className="people-dialog"
      aria-labelledby="join-request-dialog-title"
      aria-describedby={describedBy.join(" ")}
      onCancel={(event) => {
        // Escape cancels; the dialog closes with the question.
        event.preventDefault();
        onCancel();
      }}
      // A dialog that the browser closed by itself cancels too.
      onClose={onCancel}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onConfirm();
        }}
      >
        <h2 id="join-request-dialog-title">{question.title}</h2>
        {named ? (
          <p className="people-dialog-name" id="join-request-dialog-name">
            <span dir="auto">{request.name}</span>
            {request.login === null ? null : (
              <>
                {" "}
                <Login login={request.login} />
              </>
            )}
          </p>
        ) : null}
        {accountCreatedAt === undefined ? null : (
          <p className="person-meta" id="join-request-dialog-account">
            {JOIN_REQUEST_MESSAGES.accountCreated}
            <time dateTime={accountCreatedAt}>
              {formatPeopleDate(accountCreatedAt, dateFormat)}
            </time>
          </p>
        )}
        <p id="join-request-dialog-text">{question.text}</p>
        {request.kind === "approve" ? (
          <>
            <label
              className="account-label"
              htmlFor="join-request-dialog-field"
            >
              {JOIN_REQUEST_QUESTION_MESSAGES.nameLabel}
            </label>
            <input
              id="join-request-dialog-field"
              className="account-input"
              type="text"
              dir="auto"
              autoComplete="off"
              spellCheck={false}
              value={dialog.draft}
              aria-invalid={dialog.problem === undefined ? undefined : "true"}
              aria-describedby="join-request-dialog-problem"
              onChange={(event) => onDraft(event.currentTarget.value)}
            />
            <p
              className="panel-message"
              id="join-request-dialog-problem"
              role="alert"
            >
              {dialog.problem ?? ""}
            </p>
          </>
        ) : null}
        {request.kind === "invite" ? (
          <>
            <fieldset
              className="join-request-choice"
              aria-describedby="join-request-dialog-problem"
            >
              <legend>{JOIN_REQUEST_QUESTION_MESSAGES.inviteLegend}</legend>
              {options.map((option) => (
                <Choice
                  key={option.memberId}
                  checked={dialog.invitee === option.memberId}
                  onChoose={() => onChoose(option.memberId)}
                >
                  <span dir="auto">{option.name}</span>
                </Choice>
              ))}
            </fieldset>
            <p
              className="panel-message"
              id="join-request-dialog-problem"
              role="alert"
            >
              {dialog.problem ?? ""}
            </p>
          </>
        ) : null}
        <div className="people-dialog-actions">
          <button type="button" className="panel-action" onClick={onCancel}>
            {PEOPLE_ACTION_MESSAGES.cancel}
          </button>
          <button type="submit" className="panel-action">
            {question.confirm}
          </button>
        </div>
      </form>
    </dialog>
  );
}

/** One choice of "Deny and invite instead": a radio button with its label. */
function Choice({
  checked,
  onChoose,
  children,
}: {
  readonly checked: boolean;
  readonly onChoose: () => void;
  readonly children: ReactNode;
}) {
  return (
    <label className="join-request-option">
      <input
        type="radio"
        name="join-request-invite"
        checked={checked}
        onChange={onChoose}
      />
      <span>{children}</span>
    </label>
  );
}

/** Follows the join requests while the screen is shown, and asks for them once. */
export function useJoinRequestsScreen(
  bridge: JoinRequestsBridge | undefined,
): JoinRequestsScreenView {
  const [view, setView] = useState(() =>
    initialJoinRequestsScreenView(bridge !== undefined),
  );
  useEffect(
    () =>
      bridge === undefined ? undefined : followJoinRequests(bridge, setView),
    [bridge],
  );
  return view;
}

/** Moves the focus to the people screen's title, which takes it without a tab stop. */
function focusTitle(): void {
  document.getElementById(PEOPLE_TITLE_ID)?.focus();
}

/**
 * Whether the focus is still on the action's control or on the page: on
 * `button`, on `body`, or nowhere. After a question, `button` is the one
 * that opened it, which the closed dialog gave the focus back to.
 */
export function focusOnButtonOrPage(
  active: Element | null,
  body: Element | null,
  button: Element | null,
): boolean {
  return active === null || active === body || active === button;
}

/**
 * Moves the focus to the screen's title once the action's control leaves
 * the page with the next list (a confirmed decision or unblock), while the
 * focus is still on that control or on the page. A pause and a resume
 * keep the focus on their button, which stays.
 */
function focusAfterAction(done: boolean, button: Element | null): void {
  if (
    focusesTitleAfterAction(
      done,
      focusOnButtonOrPage(document.activeElement, document.body, button),
    )
  ) {
    focusTitle();
  }
}

/**
 * The button that started the last action that ran, until the first state
 * after that action decided (`decideFocusAfterState`); null otherwise.
 */
export interface ActionButtonRef {
  current: { readonly isConnected: boolean } | null;
}

/**
 * Remembers `button`, the one that the person used last, as the button of
 * the action that runs. Only an action that runs counts: a question that
 * the person cancelled sent nothing, so it never remembers its button.
 */
export function rememberRunningButton(
  acted: ActionButtonRef,
  running: boolean,
  button: { readonly isConnected: boolean } | null,
): void {
  if (running) {
    acted.current = button;
  }
}

/**
 * Lets a new state of the people or of the part's list decide, once,
 * whether the focus moves to the screen's title (#274): the button of the
 * last action that ran has left the page, and the focus is on the page
 * (`active` is `body` or nothing), never on another control. After a
 * refused or uncertain action, the main process loads the list again or an
 * event changes the people, and a row that ended meanwhile leaves the page
 * with its button, as after a confirmed action.
 *
 * While a dialog of the part is open, which gives the focus back as it
 * closes, and while an action runs, whose answer comes first, the state
 * decides nothing and the button stays remembered. Otherwise this state
 * decides and the button is forgotten, so that the rule is never left
 * armed for a later state.
 */
export function decideFocusAfterState(
  acted: ActionButtonRef,
  dialogOpen: boolean,
  running: boolean,
  active: Element | null,
  body: Element | null,
): boolean {
  if (dialogOpen || running) {
    return false;
  }
  const button = acted.current;
  acted.current = null;
  return focusesTitleAfterLeave(
    button !== null,
    button?.isConnected === true,
    focusOnButtonOrPage(active, body, null),
  );
}

/**
 * Keeps the focus after an action of a part of the people screen whose
 * button leaves the page with a later state (#274), as the confirmed
 * actions do at once: `trigger` holds the button that the person used last,
 * `dialogOpen` and `running` are the part's, and `people` and `list` are
 * the views that take a button away. The button of an action that runs is
 * remembered (`rememberRunningButton`), and the first state after it
 * decides (`decideFocusAfterState`).
 */
export function useTitleFocusAfterAction(
  trigger: RefObject<Element | null>,
  dialogOpen: boolean,
  running: boolean,
  people: PeopleScreenView,
  list: unknown,
): void {
  const acted = useRef<Element | null>(null);
  useEffect(
    () => rememberRunningButton(acted, running, trigger.current),
    [running, trigger],
  );
  // Only a new state decides; the dialogs and the running state are those
  // of the render that shows it.
  useEffect(() => {
    if (
      decideFocusAfterState(
        acted,
        dialogOpen,
        running,
        document.activeElement,
        document.body,
      )
    ) {
      focusTitle();
    }
  }, [people, list]);
}

/**
 * The join request actions of the screen (`createJoinRequestActions`) while
 * it is shown, which follow every view of the people and the join requests;
 * undefined handlers unless the three bridges that they use are there (the
 * Project Manager's decision of 2026-11-13): the join requests, their
 * actions, and the invitation actions, which create the invitation of "Deny
 * and invite instead". A question remembers the button that opened it,
 * which the dialogs give the focus back to; when the question or the code's
 * dialog closes after that button left the page (`joinRequestDialogsOpen`),
 * the focus moves to the screen's title. After an action that ran, also a
 * refused or uncertain one, the first state of the people or of the join
 * requests moves the focus there too when its button left the page and the
 * focus fell to the page (`useTitleFocusAfterAction`, #274).
 */
export function useJoinRequestActions(
  bridges: {
    readonly joinRequestActions: JoinRequestActionsBridge | undefined;
    readonly joinRequests: JoinRequestsBridge | undefined;
    readonly invitationActions: InvitationActionsBridge | undefined;
  },
  people: PeopleScreenView,
  joinRequests: JoinRequestsScreenView,
): {
  readonly actions: JoinRequestActionsView;
  readonly handlers: JoinRequestActionHandlers | undefined;
} {
  const [actions, setActions] = useState(IDLE_JOIN_REQUEST_ACTIONS);
  const { joinRequestActions, joinRequests: list, invitationActions } = bridges;
  const controller = useMemo(
    () =>
      joinRequestActions === undefined ||
      list === undefined ||
      invitationActions === undefined
        ? undefined
        : createJoinRequestActions(
            { joinRequestActions, joinRequests: list, invitationActions },
            setActions,
          ),
    [joinRequestActions, list, invitationActions],
  );
  useEffect(
    () => controller?.listChanged(people, joinRequests),
    [controller, people, joinRequests],
  );
  const trigger = useRef<Element | null>(null);
  const wasOpen = useRef(false);
  const open = joinRequestDialogsOpen(actions);
  useEffect(() => {
    const button = trigger.current;
    if (
      focusesTitleAfterClose(
        wasOpen.current,
        open,
        button !== null && !button.isConnected,
      )
    ) {
      focusTitle();
    }
    wasOpen.current = open;
  }, [open]);
  useTitleFocusAfterAction(
    trigger,
    open,
    actions.running,
    people,
    joinRequests,
  );
  const onStart = useCallback(
    (request: JoinRequestActionRequest, button: Element | null) => {
      trigger.current = button;
      void controller
        ?.start(request)
        .then((done) => focusAfterAction(done, button));
    },
    [controller],
  );
  const handlers = useMemo(
    (): JoinRequestActionHandlers | undefined =>
      controller === undefined
        ? undefined
        : {
            onStart,
            onConfirm: () => {
              void controller
                .confirm()
                .then((done) => focusAfterAction(done, trigger.current));
            },
            onCancel: controller.cancel,
            onDraft: controller.editDraft,
            onChoose: controller.choose,
            onCloseCode: controller.closeCode,
            onRefresh: () => {
              void controller.refresh();
            },
          },
    [controller, onStart],
  );
  return { actions, handlers };
}
