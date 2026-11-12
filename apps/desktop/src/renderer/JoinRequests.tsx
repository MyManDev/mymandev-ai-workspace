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
  PeopleActionsBridge,
} from "../shared/desktop-bridge.ts";
import { focusesTitleAfterAction } from "./device-view.ts";
import {
  createJoinRequestActions,
  describeJoinRequestQuestion,
  followJoinRequests,
  IDLE_JOIN_REQUEST_ACTIONS,
  initialJoinRequestsScreenView,
  JOIN_REQUEST_ACTION_LABELS,
  JOIN_REQUEST_MESSAGES,
  JOIN_REQUEST_QUESTION_MESSAGES,
  type BlockedRequestRow,
  type InviteChoice,
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
  /** Chooses whom an open "Deny and invite instead" invites. */
  readonly onChoose: (choice: InviteChoice) => void;
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
  /** The people that "Deny and invite instead" may invite. */
  readonly options: readonly InviteOption[];
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly onDraft: (text: string) => void;
  readonly onChoose: (choice: InviteChoice) => void;
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
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) {
      return;
    }
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);
  return <JoinRequestQuestionContent {...props} dialogRef={dialogRef} />;
}

/**
 * The dialog for a question, without state. The element stays in the page
 * while no question is open, empty and closed. The requested name is text
 * with `dir="auto"`, followed by the requester's GitHub login in the
 * monospace font, and describes the dialog before the sentence. An approval
 * has a name field that starts with the requested name, with an alert for
 * its problem inside the dialog, because the page behind it is inert; like
 * the people actions' name fields, it has no `maxLength`. "Deny and invite
 * instead" has a group of choices: a new person with the requested name
 * first, then each active unclaimed person by name. "Cancel" comes first.
 */
export function JoinRequestQuestionContent({
  dialog,
  options,
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
  return (
    <dialog
      ref={dialogRef}
      className="people-dialog"
      aria-labelledby="join-request-dialog-title"
      aria-describedby={
        named
          ? "join-request-dialog-name join-request-dialog-text"
          : "join-request-dialog-text"
      }
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
          <fieldset className="join-request-choice">
            <legend>{JOIN_REQUEST_QUESTION_MESSAGES.inviteLegend}</legend>
            <Choice
              checked={dialog.choice.kind === "new"}
              onChoose={() => onChoose({ kind: "new" })}
            >
              {JOIN_REQUEST_QUESTION_MESSAGES.newPerson}
              <span dir="auto">{request.name}</span>
            </Choice>
            {options.map((option) => (
              <Choice
                key={option.memberId}
                checked={
                  dialog.choice.kind === "existing" &&
                  dialog.choice.memberId === option.memberId
                }
                onChoose={() =>
                  onChoose({ kind: "existing", memberId: option.memberId })
                }
              >
                <span dir="auto">{option.name}</span>
              </Choice>
            ))}
          </fieldset>
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
 * Moves the focus to the screen's title once the action's control leaves
 * the page with the next list (a confirmed decision, unblock, pause, or
 * resume), while the focus is still on that control or on the page.
 */
function focusAfterAction(done: boolean, button: Element | null): void {
  const active = document.activeElement;
  if (
    focusesTitleAfterAction(
      done,
      active === null || active === document.body || active === button,
    )
  ) {
    focusTitle();
  }
}

/**
 * The join request actions of the screen (`createJoinRequestActions`) while
 * it is shown, which follow every view of the people and the join requests;
 * undefined handlers without the bridges. A question remembers the button
 * that opened it, which the dialogs give the focus back to; when a dialog
 * closes after that button left the page, the focus moves to the screen's
 * title.
 */
export function useJoinRequestActions(
  bridges: {
    readonly joinRequestActions: JoinRequestActionsBridge | undefined;
    readonly joinRequests: JoinRequestsBridge | undefined;
    readonly peopleActions: PeopleActionsBridge | undefined;
    readonly invitationActions: InvitationActionsBridge | undefined;
  },
  people: PeopleScreenView,
  joinRequests: JoinRequestsScreenView,
): {
  readonly actions: JoinRequestActionsView;
  readonly handlers: JoinRequestActionHandlers | undefined;
} {
  const [actions, setActions] = useState(IDLE_JOIN_REQUEST_ACTIONS);
  const { joinRequestActions, joinRequests: list } = bridges;
  const { peopleActions, invitationActions } = bridges;
  const controller = useMemo(
    () =>
      joinRequestActions === undefined ||
      list === undefined ||
      peopleActions === undefined ||
      invitationActions === undefined
        ? undefined
        : createJoinRequestActions(
            {
              joinRequestActions,
              joinRequests: list,
              peopleActions,
              invitationActions,
            },
            setActions,
          ),
    [joinRequestActions, list, peopleActions, invitationActions],
  );
  useEffect(
    () => controller?.listChanged(people, joinRequests),
    [controller, people, joinRequests],
  );
  const trigger = useRef<Element | null>(null);
  const wasOpen = useRef(false);
  const open = actions.dialog !== undefined || actions.code !== undefined;
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
