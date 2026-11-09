import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { PeopleActionsBridge } from "../shared/desktop-bridge.ts";
import { focusesTitleAfterAction, MAX_CLOCK_WAIT_MS } from "./device-view.ts";
import {
  createPeopleActions,
  describePeopleActionQuestion,
  IDLE_PEOPLE_ACTIONS,
  MAX_PERSON_NAME_LENGTH,
  nextPeopleActionsChange,
  PEOPLE_ACTION_LABELS,
  PEOPLE_ACTION_MESSAGES,
  type OwnershipOfferRow,
  type PeopleActionDialog,
  type PeopleActionRequest,
  type PeopleActionsView,
} from "./people-actions-view.ts";
import type { PeopleScreenView } from "./people-view.ts";

/** The ID of the people screen's title, which takes the focus after an action. */
export const PEOPLE_TITLE_ID = "people-title";

/** The ID of the paragraph with the sentence of the last people action. */
export const PEOPLE_ACTION_MESSAGE_ID = "people-action-message";

/** What the people screen does on its people actions; undefined without the bridge. */
export interface PeopleActionHandlers {
  /** Starts an action that the screen offers; gets the button that was clicked. */
  readonly onStart: (
    request: PeopleActionRequest,
    button: Element | null,
  ) => void;
  /** Runs the action of the open question. */
  readonly onConfirm: () => void;
  /** Closes the open question without the action. */
  readonly onCancel: () => void;
  /** Changes the name in the field of an open rename. */
  readonly onDialogDraft: (text: string) => void;
  /** Changes the name in the field of a definition. */
  readonly onDefineDraft: (text: string) => void;
  /** Defines a person with the name of the field in the workspace. */
  readonly onDefine: (workspaceId: string) => void;
}

/**
 * A button of a people action. While an action runs it stays focusable and
 * does nothing (`aria-disabled`), like the device actions' buttons, so that
 * the focus stays on it.
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

/** The actions on one person, each described by the person's name. */
export function PersonActionButtons({
  requests,
  describedBy,
  inert,
  onStart,
}: {
  readonly requests: readonly PeopleActionRequest[];
  /** The ID of the person's name. */
  readonly describedBy: string;
  readonly inert: boolean;
  readonly onStart: PeopleActionHandlers["onStart"];
}) {
  return (
    <div className="account-actions">
      {requests.map((request) => (
        <ActionButton
          key={request.kind}
          label={PEOPLE_ACTION_LABELS[request.kind]}
          describedBy={describedBy}
          inert={inert}
          onClick={(button) => onStart(request, button)}
        />
      ))}
    </div>
  );
}

/**
 * The live ownership offer: to the owner, its target's name as text and
 * when it ends, with "Withdraw the offer"; to its target, when it ends,
 * with "Accept the ownership". The button is described by the line.
 */
export function OwnershipOffer({
  offer,
  format,
  inert,
  onStart,
}: {
  readonly offer: OwnershipOfferRow;
  readonly format: Intl.DateTimeFormat;
  readonly inert: boolean;
  readonly onStart: PeopleActionHandlers["onStart"];
}) {
  const lineId = "ownership-offer-line";
  const until = (
    <>
      {PEOPLE_ACTION_MESSAGES.offerUntil}
      <time dateTime={offer.expiresAt}>
        {formatTime(offer.expiresAt, format)}
      </time>
      .
    </>
  );
  const request = offer.kind === "made" ? offer.withdraw : offer.accept;
  return (
    <div className="people-offer">
      <p id={lineId}>
        {offer.kind === "received" ? (
          PEOPLE_ACTION_MESSAGES.offerReceived
        ) : offer.targetName === null ? (
          PEOPLE_ACTION_MESSAGES.offerMadeUnlisted
        ) : (
          <>
            {PEOPLE_ACTION_MESSAGES.offerMade}
            <span dir="auto">{offer.targetName}</span>
          </>
        )}
        {until}
      </p>
      <div className="account-actions">
        <ActionButton
          label={PEOPLE_ACTION_LABELS[request.kind]}
          describedBy={lineId}
          inert={inert}
          onClick={(button) => onStart(request, button)}
        />
      </div>
    </div>
  );
}

/** A time of the offer in `format`. A timestamp that is not a date stays as it is. */
function formatTime(timestamp: string, format: Intl.DateTimeFormat): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? timestamp : format.format(date);
}

/**
 * The definition of a person, for the owner and the admins: a name field
 * and "Add person". While an action runs, the field keeps its text and the
 * button does nothing.
 */
export function DefinePersonForm({
  workspaceId,
  draft,
  inert,
  onDraft,
  onDefine,
}: {
  readonly workspaceId: string;
  readonly draft: string;
  readonly inert: boolean;
  readonly onDraft: (text: string) => void;
  readonly onDefine: (workspaceId: string) => void;
}) {
  return (
    <form
      className="people-form"
      aria-labelledby="define-person-title"
      onSubmit={(event) => {
        event.preventDefault();
        if (!inert) {
          onDefine(workspaceId);
        }
      }}
    >
      <h3 className="people-heading" id="define-person-title">
        {PEOPLE_ACTION_MESSAGES.defineTitle}
      </h3>
      <p className="person-meta" id="define-person-hint">
        {PEOPLE_ACTION_MESSAGES.defineHint}
      </p>
      <label className="account-label" htmlFor="define-person-name">
        {PEOPLE_ACTION_MESSAGES.nameLabel}
      </label>
      <input
        id="define-person-name"
        className="account-input"
        type="text"
        dir="auto"
        autoComplete="off"
        spellCheck={false}
        maxLength={MAX_PERSON_NAME_LENGTH}
        value={draft}
        aria-describedby={`define-person-hint ${PEOPLE_ACTION_MESSAGE_ID}`}
        onChange={(event) => onDraft(event.currentTarget.value)}
      />
      <div className="account-actions">
        <button
          type="submit"
          className="panel-action"
          aria-disabled={inert ? "true" : undefined}
        >
          {PEOPLE_ACTION_LABELS.define}
        </button>
      </div>
    </form>
  );
}

/** "Leave this workspace", for the admins and the members. */
export function LeaveWorkspace({
  request,
  inert,
  onStart,
}: {
  readonly request: PeopleActionRequest;
  readonly inert: boolean;
  readonly onStart: PeopleActionHandlers["onStart"];
}) {
  return (
    <div className="account-actions people-leave">
      <ActionButton
        label={PEOPLE_ACTION_LABELS.leave}
        describedBy={undefined}
        inert={inert}
        onClick={(button) => onStart(request, button)}
      />
    </div>
  );
}

export interface PeopleActionDialogProps {
  /** The open question, or undefined when none is open. */
  readonly dialog: PeopleActionDialog | undefined;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly onDraft: (text: string) => void;
}

/**
 * The question before an action that asks first, as a modal dialog of the
 * page (`showModal`), like the question before a switch: the rest of the
 * page is inert until the person answers, the focus moves to the name
 * field of a rename or to "Cancel", and Escape cancels. Closing the dialog
 * returns the focus to the action's button.
 */
export function PeopleActionDialogBox(props: PeopleActionDialogProps) {
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
  return <PeopleActionDialogContent {...props} dialogRef={dialogRef} />;
}

/**
 * The dialog for a question, without state. The element stays in the page
 * while no question is open, empty and closed, so that closing it can
 * return the focus. The person's or the workspace's name is text with
 * `dir="auto"`. "Cancel" comes first, so that a destructive action is not
 * the default focus. A rename's problem shows in an alert inside the
 * dialog, because the page behind it is inert.
 */
export function PeopleActionDialogContent({
  dialog,
  onConfirm,
  onCancel,
  onDraft,
  dialogRef,
}: PeopleActionDialogProps & {
  readonly dialogRef?: RefObject<HTMLDialogElement | null>;
}) {
  const question =
    dialog === undefined
      ? undefined
      : describePeopleActionQuestion(dialog.request);
  if (dialog === undefined || question === undefined) {
    return <dialog ref={dialogRef} className="people-dialog" />;
  }
  return (
    <dialog
      ref={dialogRef}
      className="people-dialog"
      aria-labelledby="people-dialog-title"
      aria-describedby="people-dialog-text"
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
        <h2 id="people-dialog-title">{question.title}</h2>
        {question.name === null ? null : (
          <p className="people-dialog-name">
            <span dir="auto">{question.name}</span>
          </p>
        )}
        <p id="people-dialog-text">{question.text}</p>
        {dialog.request.kind === "rename" ? (
          <>
            <label className="account-label" htmlFor="people-dialog-field">
              {PEOPLE_ACTION_MESSAGES.nameLabel}
            </label>
            <input
              id="people-dialog-field"
              className="account-input"
              type="text"
              dir="auto"
              autoComplete="off"
              spellCheck={false}
              maxLength={MAX_PERSON_NAME_LENGTH}
              value={dialog.draft}
              aria-invalid={dialog.problem === undefined ? undefined : "true"}
              aria-describedby="people-dialog-problem"
              onChange={(event) => onDraft(event.currentTarget.value)}
            />
            <p
              className="panel-message"
              id="people-dialog-problem"
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

/** Moves the focus to the screen's title, which takes it without a tab stop. */
function focusTitle(): void {
  document.getElementById(PEOPLE_TITLE_ID)?.focus();
}

/**
 * Moves the focus to the screen's title once the action's control leaves
 * the page with the next people (`focusesTitleAfterAction`), while the
 * focus is still on that control or on the page, as the devices section
 * does. The action's sentence is read from its status paragraph, which
 * never takes the focus.
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
 * The people actions of the screen (`createPeopleActions`) while it is
 * shown, which follow every view of the people; undefined handlers without
 * the bridge. A question remembers the button that opened it, which the
 * dialog gives the focus back to.
 */
export function usePeopleActions(
  bridge: PeopleActionsBridge | undefined,
  view: PeopleScreenView,
): {
  readonly actions: PeopleActionsView;
  readonly handlers: PeopleActionHandlers | undefined;
} {
  const [actions, setActions] = useState(IDLE_PEOPLE_ACTIONS);
  const controller = useMemo(
    () =>
      bridge === undefined
        ? undefined
        : createPeopleActions(bridge, setActions),
    [bridge],
  );
  useEffect(() => controller?.listChanged(view), [controller, view]);
  const trigger = useRef<Element | null>(null);
  const onStart = useCallback(
    (request: PeopleActionRequest, button: Element | null) => {
      trigger.current = button;
      void controller
        ?.start(request)
        .then((done) => focusAfterAction(done, button));
    },
    [controller],
  );
  const handlers = useMemo(
    (): PeopleActionHandlers | undefined =>
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
            onDialogDraft: controller.editDialogDraft,
            onDefineDraft: controller.editDefineDraft,
            onDefine: (workspaceId: string) => {
              void controller.define(workspaceId);
            },
          },
    [controller, onStart],
  );
  return { actions, handlers };
}

/**
 * The renderer's clock for the people actions: read again for every new
 * view, when the live offer ends (`nextPeopleActionsChange`), and when the
 * window gets the focus or becomes visible again, because a timer can fire
 * late after the computer slept.
 */
export function usePeopleClock(view: PeopleScreenView): number {
  const [reading, setReading] = useState(() => ({ view, now: Date.now() }));
  let held = reading;
  if (held.view !== view) {
    held = { view, now: Date.now() };
    setReading(held);
  }
  const { now } = held;
  const at = nextPeopleActionsChange(view, now);
  useEffect(() => {
    if (at === undefined) {
      return undefined;
    }
    const timer = setTimeout(
      () => setReading((last) => ({ view: last.view, now: Date.now() })),
      Math.min(Math.max(at - Date.now(), 0), MAX_CLOCK_WAIT_MS),
    );
    return () => clearTimeout(timer);
  }, [at, now]);
  useEffect(() => {
    const readAgain = () =>
      setReading((last) => ({ view: last.view, now: Date.now() }));
    window.addEventListener("focus", readAgain);
    document.addEventListener("visibilitychange", readAgain);
    return () => {
      window.removeEventListener("focus", readAgain);
      document.removeEventListener("visibilitychange", readAgain);
    };
  }, []);
  return now;
}
