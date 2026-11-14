import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import type {
  InvitationActionsBridge,
  InvitationsBridge,
} from "../shared/desktop-bridge.ts";
import { focusesTitleAfterAction } from "./device-view.ts";
import {
  createInvitationActions,
  describeInvitationQuestion,
  followInvitations,
  IDLE_INVITATION_ACTIONS,
  initialInvitationsScreenView,
  INVITATION_ACTION_LABELS,
  INVITATION_MESSAGES,
  nextInvitationsChange,
  type InvitationActionRequest,
  type InvitationActionsView,
  type InvitationCodeView,
  type InvitationRow,
  type InvitationsModel,
  type InvitationsScreenView,
} from "./invitations-view.ts";
import { PEOPLE_TITLE_ID } from "./PeopleActions.tsx";
import {
  clockDelay,
  focusesTitleAfterClose,
  PEOPLE_ACTION_MESSAGES,
  watchClockReads,
} from "./people-actions-view.ts";
import type { PeopleScreenView } from "./people-view.ts";

/** The ID of the paragraph with the sentence of the last invitation action. */
export const INVITATION_ACTION_MESSAGE_ID = "invitation-action-message";

/** The ID of the heading of the open invitations. */
export const INVITATIONS_HEADING_ID = "invitations-heading";

/** The fixed texts of the dialog that shows a new invitation's code (D2). */
export const INVITATION_CODE_MESSAGES = Object.freeze({
  title: "Invitation code",
  /** Says that the code is shown only now and must be passed on privately. */
  shownOnce:
    "This code is shown only now. Once you close this, it cannot be shown again. Pass it on privately, only to this person, for example in a direct message: anyone who has the code can claim this person.",
  label: "Code",
  /** Before the end of the invitation. */
  until: "It can be used once, until ",
  select: "Select the code",
  close: "Close",
  /**
   * Instead of the code, once the account was demoted to a member (#266):
   * the server revoked the invitation with the demotion.
   */
  revoked:
    "You are no longer an admin of this workspace, so this code no longer works. It is not shown.",
});

/** What the people screen does on its invitation actions; undefined without the bridges. */
export interface InvitationActionHandlers {
  /** Opens the question of an action that the screen offers; gets the button that was clicked. */
  readonly onStart: (
    request: InvitationActionRequest,
    button: Element | null,
  ) => void;
  /** Runs the action of the open question. */
  readonly onConfirm: () => void;
  /** Closes the open question without the action. */
  readonly onCancel: () => void;
  /** Closes the code's dialog, which drops the code. */
  readonly onCloseCode: () => void;
  /** Asks the main process to load the invitations again. */
  readonly onRefresh: () => void;
}

/**
 * A button of an invitation action. While an action runs it stays
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

/** "Invite" on an active unclaimed person, described by the person's name. */
export function InviteButton({
  request,
  describedBy,
  inert,
  onStart,
}: {
  readonly request: InvitationActionRequest;
  /** The ID of the person's name. */
  readonly describedBy: string;
  readonly inert: boolean;
  readonly onStart: InvitationActionHandlers["onStart"];
}) {
  return (
    <ActionButton
      label={INVITATION_ACTION_LABELS[request.kind]}
      describedBy={describedBy}
      inert={inert}
      onClick={(button) => onStart(request, button)}
    />
  );
}

/** A time of an invitation in `format`. A timestamp that is not a date stays as it is. */
function formatTime(timestamp: string, format: Intl.DateTimeFormat): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? timestamp : format.format(date);
}

/**
 * The open invitations, for the owner and the admins: a heading, a status
 * paragraph that is always rendered, empty when there is nothing to say,
 * the live invitations, and "Refresh the invitations". Each invitation
 * shows the invited person's name and its creator's name as text with
 * `dir="auto"`, and its end in a `<time>` element in `format`; its
 * "Revoke" is described by the name, whose element ID is the invitation's
 * place in the list, never its ID.
 */
export function InvitationsPart({
  model,
  format,
  inert,
  onStart,
  onRefresh,
}: {
  readonly model: InvitationsModel;
  readonly format: Intl.DateTimeFormat;
  readonly inert: boolean;
  readonly onStart: InvitationActionHandlers["onStart"];
  readonly onRefresh: () => void;
}) {
  return (
    <section className="invitations" aria-labelledby={INVITATIONS_HEADING_ID}>
      <h3 className="people-heading" id={INVITATIONS_HEADING_ID}>
        {INVITATION_MESSAGES.heading}
      </h3>
      <p className="people-status" role="status">
        {model.status}
      </p>
      {model.rows.length === 0 ? null : (
        <ul className="people-list" aria-labelledby={INVITATIONS_HEADING_ID}>
          {model.rows.map((row, index) => (
            <InvitationItem
              key={row.invitationId}
              row={row}
              nameId={`${INVITATIONS_HEADING_ID}-invitation-${String(index)}`}
              format={format}
              inert={inert}
              onStart={onStart}
            />
          ))}
        </ul>
      )}
      <div className="account-actions">
        <ActionButton
          label={INVITATION_MESSAGES.refresh}
          describedBy={undefined}
          inert={inert}
          onClick={() => onRefresh()}
        />
      </div>
    </section>
  );
}

function InvitationItem({
  row,
  nameId,
  format,
  inert,
  onStart,
}: {
  readonly row: InvitationRow;
  readonly nameId: string;
  readonly format: Intl.DateTimeFormat;
  readonly inert: boolean;
  readonly onStart: InvitationActionHandlers["onStart"];
}) {
  return (
    <li className="person">
      <p className="person-name">
        {row.personName === null ? (
          <span id={nameId}>{INVITATION_MESSAGES.unlisted}</span>
        ) : (
          <span dir="auto" id={nameId}>
            {row.personName}
          </span>
        )}
      </p>
      <p className="person-meta">
        {INVITATION_MESSAGES.createdBy}
        <span dir="auto">{row.creatorName}</span>
      </p>
      <p className="person-meta">
        {INVITATION_MESSAGES.expires}
        <time dateTime={row.expiresAt}>
          {formatTime(row.expiresAt, format)}
        </time>
      </p>
      <div className="account-actions">
        <ActionButton
          label={INVITATION_ACTION_LABELS.revoke}
          describedBy={nameId}
          inert={inert}
          onClick={(button) => onStart(row.revoke, button)}
        />
      </div>
    </li>
  );
}

/** Opens a modal dialog while `open` holds and closes it afterwards. */
function useModal(
  dialogRef: RefObject<HTMLDialogElement | null>,
  open: boolean,
): void {
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
  }, [dialogRef, open]);
}

export interface InvitationQuestionProps {
  /** The open question, or undefined when none is open. */
  readonly question: InvitationActionRequest | undefined;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

/**
 * The question before an invitation action, as a modal dialog of the page
 * (`showModal`), like the people actions' question: the rest of the page
 * is inert until the person answers, the focus moves to "Cancel", and
 * Escape cancels. Closing the dialog returns the focus to the button.
 */
export function InvitationQuestionBox(props: InvitationQuestionProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useModal(dialogRef, props.question !== undefined);
  return <InvitationQuestionContent {...props} dialogRef={dialogRef} />;
}

/**
 * The dialog for a question, without state. The element stays in the page
 * while no question is open, empty and closed. The person's name is text
 * with `dir="auto"` and describes the dialog before the sentence. "Cancel"
 * comes first.
 */
export function InvitationQuestionContent({
  question,
  onConfirm,
  onCancel,
  dialogRef,
}: InvitationQuestionProps & {
  readonly dialogRef?: RefObject<HTMLDialogElement | null>;
}) {
  if (question === undefined) {
    return <dialog ref={dialogRef} className="people-dialog" />;
  }
  const texts = describeInvitationQuestion(question);
  return (
    <dialog
      ref={dialogRef}
      className="people-dialog"
      aria-labelledby="invitation-dialog-title"
      aria-describedby="invitation-dialog-name invitation-dialog-text"
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
        <h2 id="invitation-dialog-title">{texts.title}</h2>
        <p className="people-dialog-name" id="invitation-dialog-name">
          <span dir="auto">{texts.name}</span>
        </p>
        <p id="invitation-dialog-text">{texts.text}</p>
        <div className="people-dialog-actions">
          <button type="button" className="panel-action" onClick={onCancel}>
            {PEOPLE_ACTION_MESSAGES.cancel}
          </button>
          <button type="submit" className="panel-action">
            {texts.confirm}
          </button>
        </div>
      </form>
    </dialog>
  );
}

/**
 * Selects the whole text of the code's field, so that the person can copy
 * it with the system's own command. It never touches the clipboard (D2).
 */
export function selectCode(
  field: Pick<HTMLInputElement, "focus" | "select"> | null,
): void {
  field?.focus();
  field?.select();
}

export interface InvitationCodeProps {
  /**
   * The code of the invitation just created, or undefined when no dialog is
   * open; without the code itself once the account was demoted (#266).
   */
  readonly code: InvitationCodeView | undefined;
  readonly format: Intl.DateTimeFormat;
  readonly onClose: () => void;
}

/**
 * Puts `code` into the field as its `value` property, never as an
 * attribute, and returns the function that empties the field again; does
 * nothing without a field or a code. The code's dialog calls it in a layout
 * effect when it opens, so the code is in the field before the dialog
 * shows, and its cleanup runs when the dialog closes or the code changes.
 */
export function showCodeInField(
  field: { value: string } | null,
  code: string | undefined,
): () => void {
  if (field === null || code === undefined) {
    return () => undefined;
  }
  field.value = code;
  return () => {
    field.value = "";
  };
}

/**
 * Keeps the focus inside the code's dialog once its code went with the
 * account's demotion (#266): the field and "Select the code" leave the
 * open dialog, and when the focus was on one of them, so that it is no
 * longer inside the dialog (`active`), it moves to "Close". A focus that is
 * still inside stays where it is. A dialog that is not open yet takes the
 * focus by itself as it opens.
 */
export function keepFocusInDialog(
  dialog: {
    readonly open: boolean;
    readonly contains: (node: Element | null) => boolean;
  } | null,
  close: { readonly focus: () => void } | null,
  active: Element | null,
): void {
  if (dialog === null || !dialog.open || dialog.contains(active)) {
    return;
  }
  close?.focus();
}

/**
 * The code of a new invitation, once (D2), as a modal dialog of the page.
 * The code reaches the read-only field only as its `value` property, set
 * through a reference (`showCodeInField`): a controlled `value` would also
 * write it into the element's `value` attribute. "Select the code" selects
 * the field's text and nothing else. Closing, also with Escape, drops the
 * code: the field is emptied, the dialog is then empty, and nothing in the
 * page holds the code.
 *
 * Once the account was demoted to a member, the view holds no code (#266):
 * the field is emptied and leaves the dialog with "Select the code", the
 * dialog says that the code no longer works, and the focus stays inside
 * (`keepFocusInDialog`). The dialog stays open until the person closes it.
 */
export function InvitationCodeBox(props: InvitationCodeProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const fieldRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const shown = props.code?.code ?? undefined;
  // The field's reference is set before this effect runs, and the cleanup
  // empties the same element even after React has detached the reference.
  useLayoutEffect(() => showCodeInField(fieldRef.current, shown), [shown]);
  const revoked = props.code?.code === null;
  // After the commit that took the field away, before the browser paints.
  useLayoutEffect(() => {
    if (revoked) {
      keepFocusInDialog(
        dialogRef.current,
        closeRef.current,
        document.activeElement,
      );
    }
  }, [revoked]);
  useModal(dialogRef, props.code !== undefined);
  return (
    <InvitationCodeContent
      {...props}
      onSelect={() => selectCode(fieldRef.current)}
      dialogRef={dialogRef}
      fieldRef={fieldRef}
      closeRef={closeRef}
    />
  );
}

/**
 * The code's dialog, without state. The element stays in the page while no
 * code is shown, empty and closed. The code goes into a read-only field in
 * a monospace font, without a name, so that no form sends it; this markup
 * never holds the code itself, which `InvitationCodeBox` sets as the
 * field's `value` property. It appears nowhere else: not in a status
 * paragraph, a label, or an attribute. The person's name is text with
 * `dir="auto"`. The buttons are not in a form, so that Enter in the field
 * closes nothing.
 *
 * A view without the code, after the account's demotion (#266), shows no
 * field, no end, and no "Select the code": the title, the person's name,
 * the sentence that the code no longer works, which then describes the
 * dialog, and "Close". The sentence sits in an alert that is always
 * rendered, empty while the code shows, so that a screen reader announces
 * it when it appears in the open dialog; the page behind is inert.
 */
export function InvitationCodeContent({
  code,
  format,
  onClose,
  onSelect,
  dialogRef,
  fieldRef,
  closeRef,
}: InvitationCodeProps & {
  readonly onSelect: () => void;
  readonly dialogRef?: RefObject<HTMLDialogElement | null>;
  readonly fieldRef?: RefObject<HTMLInputElement | null>;
  readonly closeRef?: RefObject<HTMLButtonElement | null>;
}) {
  if (code === undefined) {
    return <dialog ref={dialogRef} className="people-dialog" />;
  }
  const revoked = code.code === null;
  return (
    <dialog
      ref={dialogRef}
      className="people-dialog"
      aria-labelledby="invitation-code-title"
      aria-describedby={
        revoked
          ? "invitation-code-name invitation-code-revoked"
          : "invitation-code-name invitation-code-text"
      }
      onCancel={(event) => {
        // Escape closes; the dialog closes with the code.
        event.preventDefault();
        onClose();
      }}
      // A dialog that the browser closed by itself drops the code too.
      onClose={onClose}
    >
      <div className="invitation-code-content">
        <h2 id="invitation-code-title">{INVITATION_CODE_MESSAGES.title}</h2>
        <p className="people-dialog-name" id="invitation-code-name">
          <span dir="auto">{code.name}</span>
        </p>
        {revoked ? null : (
          <>
            <p id="invitation-code-text">
              {INVITATION_CODE_MESSAGES.shownOnce}
            </p>
            <label className="account-label" htmlFor="invitation-code-field">
              {INVITATION_CODE_MESSAGES.label}
            </label>
            <input
              ref={fieldRef}
              id="invitation-code-field"
              className="account-input invitation-code"
              type="text"
              dir="ltr"
              translate="no"
              readOnly
              autoComplete="off"
              spellCheck={false}
              aria-describedby="invitation-code-expiry"
            />
            <p id="invitation-code-expiry">
              {INVITATION_CODE_MESSAGES.until}
              <time dateTime={code.expiresAt}>
                {formatTime(code.expiresAt, format)}
              </time>
              .
            </p>
          </>
        )}
        <p className="panel-message" id="invitation-code-revoked" role="alert">
          {revoked ? INVITATION_CODE_MESSAGES.revoked : ""}
        </p>
        <div className="people-dialog-actions">
          {revoked ? null : (
            <button type="button" className="panel-action" onClick={onSelect}>
              {INVITATION_CODE_MESSAGES.select}
            </button>
          )}
          <button
            ref={closeRef}
            type="button"
            className="panel-action"
            onClick={onClose}
          >
            {INVITATION_CODE_MESSAGES.close}
          </button>
        </div>
      </div>
    </dialog>
  );
}

/** Follows the live invitations while the screen is shown, and asks for them once. */
export function useInvitationsScreen(
  bridge: InvitationsBridge | undefined,
): InvitationsScreenView {
  const [view, setView] = useState(() =>
    initialInvitationsScreenView(bridge !== undefined),
  );
  useEffect(
    () =>
      bridge === undefined ? undefined : followInvitations(bridge, setView),
    [bridge],
  );
  return view;
}

/**
 * The renderer's clock for the invitations: read again for every new view,
 * when the soonest live invitation ends (`nextInvitationsChange`), and when
 * the window gets the focus or becomes visible again, because a timer can
 * fire late after the computer slept.
 */
export function useInvitationsClock(view: InvitationsScreenView): number {
  const [reading, setReading] = useState(() => ({ view, now: Date.now() }));
  let held = reading;
  if (held.view !== view) {
    held = { view, now: Date.now() };
    setReading(held);
  }
  const { now } = held;
  const at = nextInvitationsChange(view, now);
  useEffect(() => {
    if (at === undefined) {
      return undefined;
    }
    const timer = setTimeout(
      () => setReading((last) => ({ view: last.view, now: Date.now() })),
      clockDelay(at, Date.now()),
    );
    return () => clearTimeout(timer);
  }, [at, now]);
  useEffect(
    () =>
      watchClockReads(window, document, () =>
        setReading((last) => ({ view: last.view, now: Date.now() })),
      ),
    [],
  );
  return now;
}

/** Moves the focus to the people screen's title, which takes it without a tab stop. */
function focusTitle(): void {
  document.getElementById(PEOPLE_TITLE_ID)?.focus();
}

/**
 * Moves the focus to the screen's title once the action's control leaves
 * the page with the next invitations (a confirmed revocation), while the
 * focus is still on that control or on the page.
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
 * The invitation actions of the screen (`createInvitationActions`) while it
 * is shown, which follow every view of the people and the invitations and
 * every reading of the clock `now`; undefined handlers without both
 * bridges. A question remembers the button that opened it, which the
 * dialogs give the focus back to; when a dialog closes after that button
 * left the page, the focus moves to the screen's title.
 */
export function useInvitationActions(
  bridge: InvitationActionsBridge | undefined,
  list: InvitationsBridge | undefined,
  people: PeopleScreenView,
  invitations: InvitationsScreenView,
  now: number,
): {
  readonly actions: InvitationActionsView;
  readonly handlers: InvitationActionHandlers | undefined;
} {
  const [actions, setActions] = useState(IDLE_INVITATION_ACTIONS);
  const controller = useMemo(
    () =>
      bridge === undefined || list === undefined
        ? undefined
        : createInvitationActions(bridge, list, setActions),
    [bridge, list],
  );
  useEffect(
    () => controller?.listChanged(people, invitations, now),
    [controller, people, invitations, now],
  );
  const trigger = useRef<Element | null>(null);
  const wasOpen = useRef(false);
  const open = actions.question !== undefined || actions.code !== undefined;
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
    (request: InvitationActionRequest, button: Element | null) => {
      trigger.current = button;
      controller?.start(request);
    },
    [controller],
  );
  const handlers = useMemo(
    (): InvitationActionHandlers | undefined =>
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
            onCloseCode: controller.closeCode,
            onRefresh: () => {
              void controller.refresh();
            },
          },
    [controller, onStart],
  );
  return { actions, handlers };
}
