import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { InvitationActionsBridge } from "../shared/desktop-bridge.ts";
import {
  deviceTimeFormat,
  focusesTitleAfterAction,
  formatDeviceTime,
} from "./device-view.ts";
import {
  createJoinInvitation,
  describeJoined,
  focusesTitleAfterLeave,
  IDLE_JOIN_INVITATION,
  JOIN_MESSAGES,
  JOIN_QUESTION,
  joinAvailability,
  type InvitationPreview,
  type JoinInvitationView,
  type JoinedWorkspace,
} from "./join-invitation-view.ts";
import { formatPeopleDate, peopleDateFormat } from "./people-view.ts";
import type { WorkspacePanelView } from "./workspace-view.ts";

/** The ID of the join screen's title, which takes the focus after an action. */
export const JOIN_TITLE_ID = "join-title";

/** The ID of the paragraph with the sentence of the last preview or accept. */
export const JOIN_MESSAGE_ID = "join-message";

/** What the join screen does on its invitation code; undefined without the bridge. */
export interface JoinInvitationHandlers {
  /** Changes the text of the code field. */
  readonly onCode: (text: string) => void;
  /** Previews the code of the field. */
  readonly onPreview: () => void;
  /** Opens the question before an accept. */
  readonly onAsk: () => void;
  /** Accepts the code after the question. */
  readonly onConfirm: () => void;
  /** Closes the question and keeps the code. */
  readonly onBack: () => void;
  /** Drops the code; gets the button that was clicked. */
  readonly onCancel: (button: Element | null) => void;
  /** Selects the joined workspace, like the sidebar. */
  readonly onOpen: (workspaceId: string) => void;
}

/**
 * Joining a workspace (#95). A person whom a workspace already added
 * claims that person with an invitation code: the screen previews the
 * pasted code and then accepts it after a question (decision D2). The
 * request to join by a workspace ID and the account's own join requests
 * come later; a note says so.
 */
export function JoinScreen({
  invitationActions,
  workspaces,
  onOpenWorkspace,
}: {
  /** The invitation actions from the preload script; undefined outside Electron. */
  readonly invitationActions: InvitationActionsBridge | undefined;
  /** The workspace state that the shell follows, for a switch and a sign-out. */
  readonly workspaces: WorkspacePanelView;
  /** Selects a workspace, as the sidebar does. */
  readonly onOpenWorkspace: (workspaceId: string) => void;
}) {
  const { view, handlers } = useJoinInvitation(
    invitationActions,
    workspaces,
    onOpenWorkspace,
  );
  return (
    <JoinScreenContent
      workspaces={workspaces}
      view={view}
      handlers={handlers}
    />
  );
}

export interface JoinScreenContentProps {
  readonly workspaces: WorkspacePanelView;
  /** What the screen shows of its invitation code; idle by default. */
  readonly view?: JoinInvitationView | undefined;
  /** The handlers; undefined without the bridge, with no form shown. */
  readonly handlers?: JoinInvitationHandlers | undefined;
  /**
   * The format of the inviter's verification date, for tests. By default, a
   * new `peopleDateFormat` for each render.
   */
  readonly dateFormat?: Intl.DateTimeFormat | undefined;
  /**
   * The format of the invitation's expiry, for tests. By default, a new
   * `deviceTimeFormat` for each render.
   */
  readonly timeFormat?: Intl.DateTimeFormat | undefined;
}

/**
 * The screen for a view, without state. The status paragraph is always
 * rendered with the handlers, empty when there is nothing to say, so that
 * a screen reader announces a new sentence; it never holds the code. Names
 * are text that people entered, so each one takes its direction from its
 * own content (`dir="auto"`), and the inviter's GitHub login is shown in a
 * monospace font, so that a name cannot pass for it. The title takes the
 * focus without a tab stop (`tabIndex={-1}`) after an action whose control
 * leaves the page.
 */
export function JoinScreenContent({
  workspaces,
  view = IDLE_JOIN_INVITATION,
  handlers,
  dateFormat,
  timeFormat,
}: JoinScreenContentProps) {
  const availability = joinAvailability(handlers !== undefined, workspaces);
  return (
    <section aria-labelledby={JOIN_TITLE_ID}>
      <h2 id={JOIN_TITLE_ID} tabIndex={-1}>
        Join a workspace
      </h2>
      <section aria-labelledby="join-code-title">
        <h3 className="people-heading" id="join-code-title">
          {JOIN_MESSAGES.title}
        </h3>
        {availability === "unavailable" || handlers === undefined ? (
          <p>{JOIN_MESSAGES.unavailable}</p>
        ) : (
          <>
            <p id="join-code-hint">{JOIN_MESSAGES.hint}</p>
            {availability === "signed_out" ? (
              <p>{JOIN_MESSAGES.signedOut}</p>
            ) : (
              <JoinCodeForm view={view} handlers={handlers} />
            )}
            <p className="people-status" id={JOIN_MESSAGE_ID} role="status">
              {view.message ?? ""}
            </p>
            {view.preview === undefined ? null : (
              <InvitationPreviewFacts
                preview={view.preview}
                inert={view.running}
                onAsk={handlers.onAsk}
                dateFormat={dateFormat ?? peopleDateFormat()}
                timeFormat={timeFormat ?? deviceTimeFormat()}
              />
            )}
            {view.joined === undefined ? null : (
              <JoinedWorkspaceLine
                joined={view.joined}
                offer={describeJoined(view.joined, workspaces)}
                onOpen={handlers.onOpen}
              />
            )}
          </>
        )}
      </section>
      <p className="placeholder-note">{JOIN_MESSAGES.later}</p>
      {handlers === undefined ? null : (
        <JoinQuestionBox
          preview={view.asking ? view.preview : undefined}
          onConfirm={handlers.onConfirm}
          onBack={handlers.onBack}
        />
      )}
    </section>
  );
}

/**
 * The code field with "Preview", and "Cancel" while there is something to
 * drop. The field is described by the hint and its own alert, which says
 * why a text was not sent; the results go to the status paragraph. It
 * takes no spelling check, no completion, and no translation, because the
 * code is a credential. While a request runs, it is read-only and the
 * buttons do nothing.
 */
export function JoinCodeForm({
  view,
  handlers,
}: {
  readonly view: JoinInvitationView;
  readonly handlers: JoinInvitationHandlers;
}) {
  const inert = view.running;
  const cancellable =
    view.code !== "" ||
    view.problem !== undefined ||
    view.preview !== undefined;
  return (
    <form
      className="account-form"
      aria-labelledby="join-code-title"
      onSubmit={(event) => {
        event.preventDefault();
        if (!inert) {
          handlers.onPreview();
        }
      }}
    >
      <label className="account-label" htmlFor="join-code">
        {JOIN_MESSAGES.codeLabel}
      </label>
      <input
        id="join-code"
        className="account-input"
        type="text"
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        translate="no"
        readOnly={inert}
        value={view.code}
        aria-invalid={view.problem === undefined ? undefined : "true"}
        aria-describedby="join-code-hint join-code-problem"
        onChange={(event) => handlers.onCode(event.currentTarget.value)}
      />
      <p className="panel-message" id="join-code-problem" role="alert">
        {view.problem ?? ""}
      </p>
      <div className="account-actions">
        <button
          type="submit"
          className="panel-action"
          aria-disabled={inert ? "true" : undefined}
        >
          {JOIN_MESSAGES.preview}
        </button>
        {cancellable ? (
          <button
            type="button"
            className="panel-action"
            aria-disabled={inert ? "true" : undefined}
            onClick={
              inert
                ? undefined
                : (event: { readonly currentTarget: Element | null }) =>
                    handlers.onCancel(event.currentTarget)
            }
          >
            {JOIN_MESSAGES.cancel}
          </button>
        ) : null}
      </div>
    </form>
  );
}

/** A time in `format`. A timestamp that is not a date stays as it is. */
function timeOf(timestamp: string, format: Intl.DateTimeFormat) {
  return (
    <time dateTime={timestamp}>{formatDeviceTime(timestamp, format)}</time>
  );
}

/**
 * What a preview shows: the workspace's name, the person whom the account
 * will be, the inviter's name and GitHub login with the date it was last
 * verified, and the expiry, with "Join the workspace", which the facts
 * describe.
 */
export function InvitationPreviewFacts({
  preview,
  inert,
  onAsk,
  dateFormat,
  timeFormat,
}: {
  readonly preview: InvitationPreview;
  readonly inert: boolean;
  readonly onAsk: JoinInvitationHandlers["onAsk"];
  readonly dateFormat: Intl.DateTimeFormat;
  readonly timeFormat: Intl.DateTimeFormat;
}) {
  return (
    <div className="people-offer">
      <dl className="account-facts" id="join-preview">
        <dt>{JOIN_MESSAGES.workspace}</dt>
        <dd>
          <span dir="auto">{preview.workspaceName}</span>
        </dd>
        <dt>{JOIN_MESSAGES.person}</dt>
        <dd>
          <span dir="auto">{preview.displayName}</span>
        </dd>
        <dt>{JOIN_MESSAGES.inviter}</dt>
        <dd>
          <span dir="auto">{preview.inviterName}</span>
          {JOIN_MESSAGES.inviterLogin}
          <span className="person-login" dir="auto" translate="no">
            {preview.inviterLogin}
          </span>
          {JOIN_MESSAGES.inviterVerified}
          <time dateTime={preview.inviterVerifiedAt}>
            {formatPeopleDate(preview.inviterVerifiedAt, dateFormat)}
          </time>
        </dd>
        <dt>{JOIN_MESSAGES.expires}</dt>
        <dd>{timeOf(preview.expiresAt, timeFormat)}</dd>
      </dl>
      <p>{JOIN_MESSAGES.loginCheck}</p>
      <div className="account-actions">
        <button
          type="button"
          className="panel-action"
          aria-describedby="join-preview"
          aria-disabled={inert ? "true" : undefined}
          onClick={inert ? undefined : onAsk}
        >
          {JOIN_MESSAGES.join}
        </button>
      </div>
    </div>
  );
}

/**
 * The workspace that the last accept joined, by its name as text, with
 * "Open this workspace" while the list holds it and it is not selected, or
 * a sentence while it is selected or not listed yet.
 */
export function JoinedWorkspaceLine({
  joined,
  offer,
  onOpen,
}: {
  readonly joined: JoinedWorkspace;
  readonly offer: "selected" | "open" | "not_listed";
  readonly onOpen: JoinInvitationHandlers["onOpen"];
}) {
  return (
    <div className="people-offer">
      <p id="join-joined">
        {JOIN_MESSAGES.joinedWorkspace}
        <span dir="auto">{joined.workspaceName}</span>
      </p>
      {offer === "open" ? (
        <div className="account-actions">
          <button
            type="button"
            className="panel-action"
            aria-describedby="join-joined"
            onClick={() => onOpen(joined.workspaceId)}
          >
            {JOIN_MESSAGES.open}
          </button>
        </div>
      ) : (
        <p>
          {offer === "selected"
            ? JOIN_MESSAGES.joinedSelected
            : JOIN_MESSAGES.joinedNotListed}
        </p>
      )}
    </div>
  );
}

export interface JoinQuestionProps {
  /** The preview that the open question is about, or undefined when none is open. */
  readonly preview: InvitationPreview | undefined;
  readonly onConfirm: () => void;
  readonly onBack: () => void;
}

/**
 * The question before an accept, as a modal dialog of the page
 * (`showModal`), like the question before a people action: the rest of the
 * page is inert until the person answers, and Escape goes back. Closing
 * the dialog returns the focus to "Join the workspace".
 */
export function JoinQuestionBox(props: JoinQuestionProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const open = props.preview !== undefined;
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
  return <JoinQuestionContent {...props} dialogRef={dialogRef} />;
}

/**
 * The dialog for the question, without state. The element stays in the
 * page while no question is open, empty and closed, so that closing it can
 * return the focus. The workspace's and the person's names are text with
 * `dir="auto"` and describe the dialog before the sentence. "Back" comes
 * first, so that joining is not the default focus.
 */
export function JoinQuestionContent({
  preview,
  onConfirm,
  onBack,
  dialogRef,
}: JoinQuestionProps & {
  readonly dialogRef?: RefObject<HTMLDialogElement | null>;
}) {
  if (preview === undefined) {
    return <dialog ref={dialogRef} className="people-dialog" />;
  }
  return (
    <dialog
      ref={dialogRef}
      className="people-dialog"
      aria-labelledby="join-dialog-title"
      aria-describedby="join-dialog-workspace join-dialog-person join-dialog-text"
      onCancel={(event) => {
        // Escape goes back; the dialog closes with the question.
        event.preventDefault();
        onBack();
      }}
      // A dialog that the browser closed by itself goes back too.
      onClose={onBack}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onConfirm();
        }}
      >
        <h2 id="join-dialog-title">{JOIN_QUESTION.title}</h2>
        <p className="people-dialog-name" id="join-dialog-workspace">
          <span dir="auto">{preview.workspaceName}</span>
        </p>
        <p id="join-dialog-person">
          {JOIN_QUESTION.person}
          <span dir="auto">{preview.displayName}</span>
        </p>
        <p id="join-dialog-text">{JOIN_QUESTION.text}</p>
        <div className="people-dialog-actions">
          <button type="button" className="panel-action" onClick={onBack}>
            {JOIN_QUESTION.back}
          </button>
          <button type="submit" className="panel-action">
            {JOIN_QUESTION.confirm}
          </button>
        </div>
      </form>
    </dialog>
  );
}

/** Moves the focus to the screen's title, which takes it without a tab stop. */
function focusTitle(): void {
  document.getElementById(JOIN_TITLE_ID)?.focus();
}

/** Whether the focus is on `button` or fell to the page. */
function focusOnButtonOrPage(button: Element | null): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || active === button;
}

/**
 * The invitation code of the screen (`createJoinInvitation`) while it is
 * shown, which follows every workspace state; undefined handlers without
 * the bridge. Leaving the screen drops the controller with the code.
 *
 * The focus moves to the screen's title when the control that had it
 * leaves the page: "Cancel" after a click, while the focus is still on it
 * or on the page; "Join the workspace" when the preview ends with an
 * accept's answer, a switch, or a sign-out, and "Open this workspace" once
 * the joined workspace is selected, both while the focus fell to the page.
 * The question's dialog returns the focus to "Join the workspace" first.
 */
export function useJoinInvitation(
  bridge: InvitationActionsBridge | undefined,
  workspaces: WorkspacePanelView,
  onOpenWorkspace: (workspaceId: string) => void,
): {
  readonly view: JoinInvitationView;
  readonly handlers: JoinInvitationHandlers | undefined;
} {
  const [view, setView] = useState(IDLE_JOIN_INVITATION);
  const controller = useMemo(
    () =>
      bridge === undefined ? undefined : createJoinInvitation(bridge, setView),
    [bridge],
  );
  useEffect(
    () => controller?.workspacesChanged(workspaces),
    [controller, workspaces],
  );
  const previewShown = view.preview !== undefined;
  const wasShown = useRef(previewShown);
  useEffect(() => {
    if (
      focusesTitleAfterLeave(
        wasShown.current,
        previewShown,
        focusOnButtonOrPage(null),
      )
    ) {
      focusTitle();
    }
    wasShown.current = previewShown;
  }, [previewShown]);
  const offersOpen =
    view.joined !== undefined &&
    describeJoined(view.joined, workspaces) === "open";
  const wasOffered = useRef(offersOpen);
  useEffect(() => {
    if (
      focusesTitleAfterLeave(
        wasOffered.current,
        offersOpen,
        focusOnButtonOrPage(null),
      )
    ) {
      focusTitle();
    }
    wasOffered.current = offersOpen;
  }, [offersOpen]);
  const handlers = useMemo(
    (): JoinInvitationHandlers | undefined =>
      controller === undefined
        ? undefined
        : {
            onCode: controller.editCode,
            onPreview: () => {
              void controller.preview();
            },
            onAsk: controller.ask,
            onConfirm: () => {
              void controller.confirm();
            },
            onBack: controller.back,
            onCancel: (button: Element | null) => {
              if (
                focusesTitleAfterAction(
                  controller.cancel(),
                  focusOnButtonOrPage(button),
                )
              ) {
                focusTitle();
              }
            },
            onOpen: onOpenWorkspace,
          },
    [controller, onOpenWorkspace],
  );
  return { view, handlers };
}
