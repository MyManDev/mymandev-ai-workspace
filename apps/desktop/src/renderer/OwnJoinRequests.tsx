import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import type {
  OwnJoinRequestActionsBridge,
  OwnJoinRequestsBridge,
} from "../shared/desktop-bridge.ts";
import type { AccountView } from "./account-view.ts";
import { focusesTitleAfterAction, formatDeviceTime } from "./device-view.ts";
import { focusesTitleAfterLeave } from "./join-invitation-view.ts";
import { focusOnButtonOrPage, syncModal } from "./JoinRequests.tsx";
import {
  createOwnJoinRequestActions,
  followOwnJoinRequests,
  IDLE_OWN_JOIN_REQUEST_ACTIONS,
  initialOwnJoinRequestsScreenView,
  JOIN_REQUEST_FORM_MESSAGES,
  OWN_JOIN_REQUEST_MESSAGES,
  OWN_JOIN_REQUEST_OUTCOME_LABELS,
  WITHDRAW_QUESTION,
  type OwnJoinRequestActionsView,
  type OwnJoinRequestRow,
  type OwnJoinRequestsModel,
  type OwnJoinRequestsScreenView,
  type WithdrawRequest,
} from "./own-join-requests-view.ts";
import {
  focusesTitleAfterClose,
  PEOPLE_ACTION_MESSAGES,
} from "./people-actions-view.ts";

/** The ID of the paragraph with the sentence of the last request to join. */
export const JOIN_REQUEST_MESSAGE_ID = "join-request-message";

/** The ID of the paragraph with the sentence of the last withdrawal or refresh. */
export const OWN_JOIN_REQUEST_ACTION_MESSAGE_ID =
  "own-join-request-action-message";

/** The ID of the heading of the account's own join requests. */
export const OWN_JOIN_REQUESTS_HEADING_ID = "own-join-requests-heading";

/** What the join screen does on the join requests; undefined without the bridges. */
export interface OwnJoinRequestHandlers {
  /** Changes the text of the workspace ID field. */
  readonly onWorkspaceId: (text: string) => void;
  /** Changes the text of the name field. */
  readonly onName: (text: string) => void;
  /** Asks to join with the two fields. */
  readonly onSubmit: () => void;
  /** Opens the question before a withdrawal; gets the button that was clicked. */
  readonly onWithdraw: (
    request: WithdrawRequest,
    button: Element | null,
  ) => void;
  /** Withdraws the request of the open question. */
  readonly onConfirmWithdraw: () => void;
  /** Closes the question without the withdrawal. */
  readonly onCancelWithdraw: () => void;
  /** Asks the main process to load the own join requests again. */
  readonly onRefresh: () => void;
}

/** A button of the part. While an action runs it stays focusable and does nothing (`aria-disabled`). */
function ActionButton({
  label,
  describedBy,
  inert,
  onClick,
  type = "button",
}: {
  readonly label: string;
  readonly describedBy: string | undefined;
  readonly inert: boolean;
  readonly onClick: ((button: Element | null) => void) | undefined;
  readonly type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      className="panel-action"
      aria-describedby={describedBy}
      aria-disabled={inert ? "true" : undefined}
      onClick={
        inert || onClick === undefined
          ? undefined
          : (event: { readonly currentTarget: Element | null }) =>
              onClick(event.currentTarget)
      }
    >
      {label}
    </button>
  );
}

/**
 * The form that asks to join a workspace by its ID: the ID field, the name
 * field, which starts with the account's display name, and "Ask to join".
 * Each field has its own alert, which says why a text was not sent; the
 * results go to the status paragraph below the form. The ID field takes no
 * spelling check, completion, capitalization, correction, or translation,
 * like the invitation code's field; the name takes its direction from its
 * content (`dir="auto"`) and has no `maxLength`, which HTML counts in
 * UTF-16 code units, so the controller's check in characters decides. While
 * an action runs, both fields are read-only and the button does nothing.
 * The form has no free-text note (ADR 0014).
 */
export function JoinRequestForm({
  view,
  handlers,
}: {
  readonly view: OwnJoinRequestActionsView;
  readonly handlers: OwnJoinRequestHandlers;
}) {
  const inert = view.running;
  return (
    <form
      className="account-form"
      aria-labelledby="join-request-title"
      onSubmit={(event) => {
        event.preventDefault();
        if (!inert) {
          handlers.onSubmit();
        }
      }}
    >
      <label className="account-label" htmlFor="join-request-workspace">
        {JOIN_REQUEST_FORM_MESSAGES.workspaceLabel}
      </label>
      <input
        id="join-request-workspace"
        className="account-input"
        type="text"
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        translate="no"
        readOnly={inert}
        value={view.workspaceId}
        aria-invalid={view.workspaceProblem === undefined ? undefined : "true"}
        aria-describedby="join-request-hint join-request-claim-hint join-request-workspace-problem"
        onChange={(event) => handlers.onWorkspaceId(event.currentTarget.value)}
      />
      <p
        className="panel-message"
        id="join-request-workspace-problem"
        role="alert"
      >
        {view.workspaceProblem ?? ""}
      </p>
      <label className="account-label" htmlFor="join-request-name">
        {JOIN_REQUEST_FORM_MESSAGES.nameLabel}
      </label>
      <input
        id="join-request-name"
        className="account-input"
        type="text"
        dir="auto"
        autoComplete="off"
        spellCheck={false}
        readOnly={inert}
        value={view.name}
        aria-invalid={view.nameProblem === undefined ? undefined : "true"}
        aria-describedby="join-request-name-problem"
        onChange={(event) => handlers.onName(event.currentTarget.value)}
      />
      <p className="panel-message" id="join-request-name-problem" role="alert">
        {view.nameProblem ?? ""}
      </p>
      <div className="account-actions">
        <ActionButton
          type="submit"
          label={JOIN_REQUEST_FORM_MESSAGES.submit}
          describedBy={undefined}
          inert={inert}
          onClick={undefined}
        />
      </div>
    </form>
  );
}

/** A time in `format`, in a `<time>` element. A timestamp that is not a date stays as it is. */
function timeOf(timestamp: string, format: Intl.DateTimeFormat) {
  return (
    <time dateTime={timestamp}>{formatDeviceTime(timestamp, format)}</time>
  );
}

/**
 * The account's own join requests: a heading, a status paragraph that is
 * always rendered, empty when there is nothing to say, the pending requests
 * with "Withdraw", the requests that ended with how and when, "Refresh your
 * join requests", and the paragraph with the sentence of the last
 * withdrawal or refresh. Each request shows its requested name as text with
 * `dir="auto"`, the workspace's ID in the monospace font, never translated,
 * and the workspace's name as text once the account's workspace list holds
 * it; times are in `timeFormat`. "Withdraw" is described by the requested
 * name and the workspace's ID, whose element IDs are the request's place in
 * its list, never its ID.
 */
export function OwnJoinRequestsPart({
  model,
  view,
  handlers,
  timeFormat,
}: {
  readonly model: OwnJoinRequestsModel;
  readonly view: OwnJoinRequestActionsView;
  readonly handlers: OwnJoinRequestHandlers;
  readonly timeFormat: Intl.DateTimeFormat;
}) {
  const inert = view.running;
  return (
    <section aria-labelledby={OWN_JOIN_REQUESTS_HEADING_ID}>
      <h3 className="people-heading" id={OWN_JOIN_REQUESTS_HEADING_ID}>
        {OWN_JOIN_REQUEST_MESSAGES.heading}
      </h3>
      <p className="people-status" role="status">
        {model.status}
      </p>
      {model.pending.length === 0 ? null : (
        <RequestList
          heading={OWN_JOIN_REQUEST_MESSAGES.pendingHeading}
          headingId="own-join-requests-pending"
          rows={model.pending}
          timeFormat={timeFormat}
          inert={inert}
          onWithdraw={handlers.onWithdraw}
        />
      )}
      {model.ended.length === 0 ? null : (
        <RequestList
          heading={OWN_JOIN_REQUEST_MESSAGES.endedHeading}
          headingId="own-join-requests-ended"
          rows={model.ended}
          timeFormat={timeFormat}
          inert={inert}
          onWithdraw={handlers.onWithdraw}
        />
      )}
      <div className="account-actions">
        <ActionButton
          label={OWN_JOIN_REQUEST_MESSAGES.refresh}
          describedBy={undefined}
          inert={inert}
          onClick={() => handlers.onRefresh()}
        />
      </div>
      <p
        className="people-status"
        id={OWN_JOIN_REQUEST_ACTION_MESSAGE_ID}
        role="status"
      >
        {view.listMessage ?? ""}
      </p>
    </section>
  );
}

function RequestList({
  heading,
  headingId,
  rows,
  timeFormat,
  inert,
  onWithdraw,
}: {
  readonly heading: string;
  readonly headingId: string;
  readonly rows: readonly OwnJoinRequestRow[];
  readonly timeFormat: Intl.DateTimeFormat;
  readonly inert: boolean;
  readonly onWithdraw: OwnJoinRequestHandlers["onWithdraw"];
}) {
  return (
    <>
      <h4 className="people-heading" id={headingId}>
        {heading}
      </h4>
      <ul className="people-list" aria-labelledby={headingId}>
        {rows.map((row, index) => (
          <RequestItem
            key={row.joinRequestId}
            row={row}
            idPrefix={`${headingId}-${String(index)}`}
            timeFormat={timeFormat}
            inert={inert}
            onWithdraw={onWithdraw}
          />
        ))}
      </ul>
    </>
  );
}

function RequestItem({
  row,
  idPrefix,
  timeFormat,
  inert,
  onWithdraw,
}: {
  readonly row: OwnJoinRequestRow;
  readonly idPrefix: string;
  readonly timeFormat: Intl.DateTimeFormat;
  readonly inert: boolean;
  readonly onWithdraw: OwnJoinRequestHandlers["onWithdraw"];
}) {
  const nameId = `${idPrefix}-name`;
  const workspaceId = `${idPrefix}-workspace`;
  const { withdraw } = row;
  return (
    <li className="person">
      <p className="person-name">
        <span dir="auto" id={nameId}>
          {row.requestedName}
        </span>
      </p>
      <p className="person-meta">
        {OWN_JOIN_REQUEST_MESSAGES.workspaceId}
        <span className="workspace-id" translate="no" id={workspaceId}>
          {row.workspaceId}
        </span>
      </p>
      {row.workspaceName === undefined ? null : (
        <p className="person-meta">
          {OWN_JOIN_REQUEST_MESSAGES.workspaceName}
          <span dir="auto">{row.workspaceName}</span>
        </p>
      )}
      <p className="person-meta">
        {OWN_JOIN_REQUEST_MESSAGES.sent}
        {timeOf(row.createdAt, timeFormat)}
      </p>
      {row.outcome === null || row.decidedAt === null ? (
        <p className="person-meta">
          {OWN_JOIN_REQUEST_MESSAGES.expires}
          {timeOf(row.expiresAt, timeFormat)}
        </p>
      ) : (
        <p className="person-meta">
          {OWN_JOIN_REQUEST_OUTCOME_LABELS[row.outcome]}
          {timeOf(row.decidedAt, timeFormat)}
        </p>
      )}
      {withdraw === null ? null : (
        <div className="account-actions">
          <ActionButton
            label={OWN_JOIN_REQUEST_MESSAGES.withdraw}
            describedBy={`${nameId} ${workspaceId}`}
            inert={inert}
            onClick={(button) => onWithdraw(withdraw, button)}
          />
        </div>
      )}
    </li>
  );
}

export interface WithdrawQuestionProps {
  /** The request of the open question, or undefined when none is open. */
  readonly request: WithdrawRequest | undefined;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

/**
 * The question before a withdrawal, as a modal dialog of the page
 * (`showModal`), like the other questions: the rest of the page is inert
 * until the person answers, and Escape cancels. Closing the dialog returns
 * the focus to "Withdraw".
 */
export function WithdrawQuestionBox(props: WithdrawQuestionProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const open = props.request !== undefined;
  useEffect(() => syncModal(dialogRef.current, open), [open]);
  return <WithdrawQuestionContent {...props} dialogRef={dialogRef} />;
}

/**
 * The dialog for the question, without state. The element stays in the
 * page while no question is open, empty and closed. The requested name is
 * text with `dir="auto"`, and the workspace's ID is in the monospace font;
 * both describe the dialog before the sentence. "Cancel" comes first.
 */
export function WithdrawQuestionContent({
  request,
  onConfirm,
  onCancel,
  dialogRef,
}: WithdrawQuestionProps & {
  readonly dialogRef?: RefObject<HTMLDialogElement | null>;
}) {
  if (request === undefined) {
    return <dialog ref={dialogRef} className="people-dialog" />;
  }
  return (
    <dialog
      ref={dialogRef}
      className="people-dialog"
      aria-labelledby="withdraw-dialog-title"
      aria-describedby="withdraw-dialog-name withdraw-dialog-workspace withdraw-dialog-text"
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
        <h2 id="withdraw-dialog-title">{WITHDRAW_QUESTION.title}</h2>
        <p className="people-dialog-name" id="withdraw-dialog-name">
          <span dir="auto">{request.requestedName}</span>
        </p>
        <p id="withdraw-dialog-workspace">
          {OWN_JOIN_REQUEST_MESSAGES.workspaceId}
          <span className="workspace-id" translate="no">
            {request.workspaceId}
          </span>
        </p>
        <p id="withdraw-dialog-text">{WITHDRAW_QUESTION.text}</p>
        <div className="people-dialog-actions">
          <button type="button" className="panel-action" onClick={onCancel}>
            {PEOPLE_ACTION_MESSAGES.cancel}
          </button>
          <button type="submit" className="panel-action">
            {WITHDRAW_QUESTION.confirm}
          </button>
        </div>
      </form>
    </dialog>
  );
}

/**
 * Whether the focus moves to the screen's title as a new list renders: no
 * question is open, the "Withdraw" button that the person used last
 * (`trigger`) has left the page, and the focus fell to the page. After a
 * refused or uncertain withdrawal, the main process loads the list again,
 * and a request that ended meanwhile leaves the pending requests with its
 * button.
 */
export function focusesTitleAfterRowLeft(
  questionOpen: boolean,
  trigger: { readonly isConnected: boolean } | null,
  focusOnPage: boolean,
): boolean {
  return (
    !questionOpen &&
    focusesTitleAfterLeave(
      trigger !== null,
      trigger?.isConnected === true,
      focusOnPage,
    )
  );
}

/** Follows the account's own join requests while the screen is shown, and asks for them once. */
export function useOwnJoinRequestsScreen(
  bridge: OwnJoinRequestsBridge | undefined,
): OwnJoinRequestsScreenView {
  const [view, setView] = useState(() =>
    initialOwnJoinRequestsScreenView(bridge !== undefined),
  );
  useEffect(
    () =>
      bridge === undefined ? undefined : followOwnJoinRequests(bridge, setView),
    [bridge],
  );
  return view;
}

/**
 * The join request actions of the screen (`createOwnJoinRequestActions`)
 * while it is shown, which follow every account status and every state of
 * the own join requests; undefined handlers unless both bridges that the
 * part uses are there: the own join requests, for the list and its
 * refresh, and their actions, for the create and the withdrawal. Leaving
 * the screen drops the controller with the fields' texts.
 *
 * The focus moves to the screen's title (`titleId`) when "Withdraw" leaves
 * the page: after a withdrawal that the API confirmed, while the focus is
 * still on that button, which the closed question gave it back to, or on
 * the page; when the question ends because its request ended, once that
 * button left the page; and when a later list no longer shows that button,
 * for example after a refused or uncertain withdrawal whose request ended,
 * while no question is open and the focus fell to the page
 * (`focusesTitleAfterRowLeft`).
 */
export function useOwnJoinRequestActions(
  bridges: {
    readonly ownJoinRequests: OwnJoinRequestsBridge | undefined;
    readonly ownJoinRequestActions: OwnJoinRequestActionsBridge | undefined;
  },
  list: OwnJoinRequestsScreenView,
  account: AccountView,
  titleId: string,
): {
  readonly view: OwnJoinRequestActionsView;
  readonly handlers: OwnJoinRequestHandlers | undefined;
} {
  const [view, setView] = useState(IDLE_OWN_JOIN_REQUEST_ACTIONS);
  const { ownJoinRequests, ownJoinRequestActions } = bridges;
  const controller = useMemo(
    () =>
      ownJoinRequests === undefined || ownJoinRequestActions === undefined
        ? undefined
        : createOwnJoinRequestActions(
            { ownJoinRequests, ownJoinRequestActions },
            setView,
          ),
    [ownJoinRequests, ownJoinRequestActions],
  );
  useEffect(() => controller?.accountChanged(account), [controller, account]);
  useEffect(() => controller?.listChanged(list), [controller, list]);
  const focusTitle = useCallback(() => {
    document.getElementById(titleId)?.focus();
  }, [titleId]);
  const trigger = useRef<Element | null>(null);
  const wasOpen = useRef(false);
  const open = view.withdrawal !== undefined;
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
  }, [open, focusTitle]);
  useEffect(() => {
    const button = trigger.current;
    if (open || button === null || button.isConnected) {
      // An open question gives the focus back to its button as it closes.
      return;
    }
    trigger.current = null;
    if (
      focusesTitleAfterRowLeft(
        open,
        button,
        focusOnButtonOrPage(document.activeElement, document.body, null),
      )
    ) {
      focusTitle();
    }
  }, [list, open, focusTitle]);
  const handlers = useMemo(
    (): OwnJoinRequestHandlers | undefined =>
      controller === undefined
        ? undefined
        : {
            onWorkspaceId: controller.editWorkspaceId,
            onName: controller.editName,
            onSubmit: () => {
              void controller.submit();
            },
            onWithdraw: (request: WithdrawRequest, button: Element | null) => {
              trigger.current = button;
              controller.startWithdraw(request);
            },
            onConfirmWithdraw: () => {
              void controller.confirmWithdraw().then((done) => {
                if (
                  focusesTitleAfterAction(
                    done,
                    focusOnButtonOrPage(
                      document.activeElement,
                      document.body,
                      trigger.current,
                    ),
                  )
                ) {
                  focusTitle();
                }
              });
            },
            onCancelWithdraw: controller.cancelWithdraw,
            onRefresh: () => {
              void controller.refresh();
            },
          },
    [controller, focusTitle],
  );
  return { view, handlers };
}
