import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { ProviderConnectionsBridge } from "../shared/desktop-bridge.ts";
import { deviceTimeFormat, formatDeviceTime } from "./device-view.ts";
import { syncModal } from "./JoinRequests.tsx";
import {
  createProviderConnectionActions,
  describeProviderConnections,
  followProviderConnections,
  IDLE_PROVIDER_CONNECTION_ACTIONS,
  initialProviderConnectionSectionView,
  PROVIDER_CONNECTION_MESSAGES,
  PROVIDER_KIND_NAMES,
  PROVIDER_KINDS_OFFERED,
  type ProviderConnectionActions,
  type ProviderConnectionActionsView,
  type ProviderConnectionQuestion,
  type ProviderConnectionRow,
  type ProviderConnectionsModel,
} from "./provider-connection-view.ts";

/** The ID of the section's title, which takes the focus without a tab stop. */
export const PROVIDER_CONNECTIONS_TITLE_ID = "provider-connections-title";

/** The ID of the status paragraph of the section's actions. */
export const PROVIDER_CONNECTION_MESSAGE_ID = "provider-connection-message";

/** The element ID of a connection's label, by its place in the list, never its ID. */
export function providerConnectionLabelId(index: number): string {
  return `provider-connection-label-${String(index)}`;
}

/** What the section needs to offer its actions. */
export interface ProviderConnectionHandlers {
  readonly onKind: (kind: string) => void;
  readonly onLabel: (text: string) => void;
  readonly onRegister: () => void;
  readonly onRemove: (row: ProviderConnectionRow) => void;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

export interface ProviderConnectionsContentProps {
  readonly model: ProviderConnectionsModel;
  readonly actions: ProviderConnectionActionsView;
  /** Undefined without the bridge: then nothing is offered. */
  readonly handlers: ProviderConnectionHandlers | undefined;
  /**
   * The format of the times, for tests. By default, a new `deviceTimeFormat`
   * for each render, in the person's locale and the system's time zone.
   */
  readonly timeFormat?: Intl.DateTimeFormat | undefined;
}

/**
 * This device's AI provider connections on the Account screen (#32),
 * without state: the title, which takes the focus without a tab stop, a
 * hint that no secret is asked for, one status paragraph that is always
 * rendered, so that a screen reader announces a new text, and with the
 * bridge a second one for the sentence of the last action. Each connection
 * shows its provider, its label, as text that a person entered with
 * `dir="auto"` and never translated, when it was added, and its status with
 * its sentence; its "Remove" button is described by the label. While a
 * device is signed in, a form adds a connection by its provider and label;
 * it has no field for a key or a token. While an action runs, every button
 * stays focusable and does nothing (`aria-disabled`), and the fields are
 * read-only.
 */
export function ProviderConnectionsContent({
  model,
  actions,
  handlers,
  timeFormat,
}: ProviderConnectionsContentProps) {
  const format = timeFormat ?? deviceTimeFormat();
  const { rows } = model;
  return (
    <section
      className="account-panel"
      aria-labelledby={PROVIDER_CONNECTIONS_TITLE_ID}
    >
      <h3 id={PROVIDER_CONNECTIONS_TITLE_ID} tabIndex={-1}>
        {PROVIDER_CONNECTION_MESSAGES.title}
      </h3>
      <p className="account-message">{PROVIDER_CONNECTION_MESSAGES.hint}</p>
      <p className="account-message" role="status">
        {model.status}
      </p>
      {handlers === undefined ? null : (
        <p
          className="account-message"
          id={PROVIDER_CONNECTION_MESSAGE_ID}
          role="status"
        >
          {actions.message ?? ""}
        </p>
      )}
      {rows === null ? null : (
        <ul
          className="device-list"
          aria-labelledby={PROVIDER_CONNECTIONS_TITLE_ID}
        >
          {rows.map((row, index) => (
            <ConnectionItem
              key={row.id}
              row={row}
              index={index}
              format={format}
              running={actions.running}
              handlers={handlers}
            />
          ))}
        </ul>
      )}
      {handlers === undefined || !model.signedIn ? null : (
        <RegisterForm actions={actions} handlers={handlers} />
      )}
    </section>
  );
}

function ConnectionItem({
  row,
  index,
  format,
  running,
  handlers,
}: {
  readonly row: ProviderConnectionRow;
  readonly index: number;
  readonly format: Intl.DateTimeFormat;
  readonly running: boolean;
  readonly handlers: ProviderConnectionHandlers | undefined;
}) {
  const labelId = providerConnectionLabelId(index);
  return (
    <li>
      <p className="device-name">
        <span className="device-label" id={labelId} dir="auto" translate="no">
          {row.label}
        </span>{" "}
        <span className="device-mark">{row.kindName}</span>
      </p>
      <dl className="account-facts">
        <dt>{PROVIDER_CONNECTION_MESSAGES.added}</dt>
        <dd>
          <time dateTime={row.createdAt}>
            {formatDeviceTime(row.createdAt, format)}
          </time>
        </dd>
        <dt>{PROVIDER_CONNECTION_MESSAGES.status}</dt>
        <dd>
          {row.statusName}. {row.statusText}
        </dd>
      </dl>
      {handlers === undefined ? null : (
        <div className="account-actions">
          <button
            type="button"
            className="panel-action"
            aria-describedby={labelId}
            aria-disabled={running ? "true" : undefined}
            onClick={running ? undefined : () => handlers.onRemove(row)}
          >
            {PROVIDER_CONNECTION_MESSAGES.remove}
          </button>
        </div>
      )}
    </li>
  );
}

/**
 * The form that adds a connection by its provider and label, with the
 * label's hint and an alert for a label that is not sent. The field has no
 * `maxLength`, which HTML counts in UTF-16 code units:
 * `providerConnectionLabelPrompt` counts the characters. There is no field
 * for a credential.
 */
function RegisterForm({
  actions,
  handlers,
}: {
  readonly actions: ProviderConnectionActionsView;
  readonly handlers: ProviderConnectionHandlers;
}) {
  const { running } = actions;
  return (
    <form
      className="account-form"
      aria-labelledby="provider-connection-register-title"
      onSubmit={(event) => {
        event.preventDefault();
        if (!running) {
          handlers.onRegister();
        }
      }}
    >
      <h4 id="provider-connection-register-title">
        {PROVIDER_CONNECTION_MESSAGES.registerTitle}
      </h4>
      <label className="account-label" htmlFor="provider-connection-kind">
        {PROVIDER_CONNECTION_MESSAGES.kindLabel}
      </label>
      <select
        id="provider-connection-kind"
        className="account-input"
        value={actions.draftKind}
        disabled={running}
        onChange={(event) => handlers.onKind(event.currentTarget.value)}
      >
        {PROVIDER_KINDS_OFFERED.map((kind) => (
          <option key={kind} value={kind}>
            {PROVIDER_KIND_NAMES[kind]}
          </option>
        ))}
      </select>
      <label className="account-label" htmlFor="provider-connection-label">
        {PROVIDER_CONNECTION_MESSAGES.label}
      </label>
      <input
        id="provider-connection-label"
        className="account-input"
        type="text"
        dir="auto"
        autoComplete="off"
        spellCheck={false}
        value={actions.draftLabel}
        readOnly={running}
        aria-invalid={actions.labelProblem === undefined ? undefined : "true"}
        aria-describedby="provider-connection-label-hint provider-connection-label-problem"
        onChange={(event) => handlers.onLabel(event.currentTarget.value)}
      />
      <p className="account-message" id="provider-connection-label-hint">
        {PROVIDER_CONNECTION_MESSAGES.labelHint}
      </p>
      <p
        className="panel-message"
        id="provider-connection-label-problem"
        role="alert"
      >
        {actions.labelProblem ?? ""}
      </p>
      <div className="account-actions">
        <button
          type="submit"
          className="panel-action"
          aria-disabled={running ? "true" : undefined}
        >
          {PROVIDER_CONNECTION_MESSAGES.register}
        </button>
      </div>
    </form>
  );
}

/** The fixed texts of the question before a removal. */
export const REMOVE_QUESTION_MESSAGES = Object.freeze({
  title: "Remove this AI provider connection?",
  text: "The server forgets it, and every permission that lets an agent use it is revoked. Nothing on the provider's side changes.",
  confirm: "Remove the connection",
});

export interface ProviderConnectionQuestionProps {
  readonly question: ProviderConnectionQuestion | undefined;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

/**
 * The question before a removal, as a modal dialog of the page
 * (`showModal`), like the people actions' question: the rest of the page is
 * inert until the person answers, and Escape cancels. Closing the dialog
 * returns the focus to the "Remove" button.
 */
export function ProviderConnectionQuestionBox(
  props: ProviderConnectionQuestionProps,
) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const open = props.question !== undefined;
  useEffect(() => syncModal(dialogRef.current, open), [open]);
  return <ProviderConnectionQuestionContent {...props} dialogRef={dialogRef} />;
}

/**
 * The dialog of the question, without state. It stays in the page, empty
 * and closed, while no question is open, so that closing it can return the
 * focus. The connection's label is text with `dir="auto"`, never
 * translated, and describes the dialog before the sentence. "Cancel" comes
 * first, so that it takes the focus.
 */
export function ProviderConnectionQuestionContent({
  question,
  onConfirm,
  onCancel,
  dialogRef,
}: ProviderConnectionQuestionProps & {
  readonly dialogRef?: RefObject<HTMLDialogElement | null>;
}) {
  if (question === undefined) {
    return <dialog ref={dialogRef} className="people-dialog" />;
  }
  return (
    <dialog
      ref={dialogRef}
      className="people-dialog"
      aria-labelledby="provider-connection-dialog-title"
      aria-describedby="provider-connection-dialog-name provider-connection-dialog-text"
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
        <h2 id="provider-connection-dialog-title">
          {REMOVE_QUESTION_MESSAGES.title}
        </h2>
        <p className="people-dialog-name" id="provider-connection-dialog-name">
          <span dir="auto" translate="no">
            {question.label}
          </span>{" "}
          ({question.kindName})
        </p>
        <p id="provider-connection-dialog-text">
          {REMOVE_QUESTION_MESSAGES.text}
        </p>
        <div className="people-dialog-actions">
          <button type="button" className="panel-action" onClick={onCancel}>
            {PROVIDER_CONNECTION_MESSAGES.cancel}
          </button>
          <button type="submit" className="panel-action">
            {REMOVE_QUESTION_MESSAGES.confirm}
          </button>
        </div>
      </form>
    </dialog>
  );
}

/** Moves the focus to the section's title in `root`, the page's document. */
export function focusProviderConnectionsTitle(
  root: Pick<Document, "getElementById">,
): void {
  root.getElementById(PROVIDER_CONNECTIONS_TITLE_ID)?.focus();
}

/**
 * The section's handlers on `controller`: each passes the person's input
 * on. A confirmed removal moves the focus to the section's title once the
 * main process removed the connection, because its "Remove" button leaves
 * the page with it.
 */
export function providerConnectionHandlers(
  controller: ProviderConnectionActions,
  focusTitle: () => void,
): ProviderConnectionHandlers {
  return {
    onKind: controller.editKind,
    onLabel: controller.editLabel,
    onRegister: () => {
      void controller.register();
    },
    onRemove: controller.askRemove,
    onConfirm: () => {
      void controller.confirm().then((removed) => {
        if (removed) {
          focusTitle();
        }
      });
    },
    onCancel: controller.cancel,
  };
}

/**
 * The section as the Account screen shows it: it follows the connections
 * while it is shown, runs its actions (`createProviderConnectionActions`),
 * which follow every model, and shows the question before a removal.
 * Without the bridge, it says that the connections are not available and
 * offers nothing.
 */
export function ProviderConnectionsSection({
  providerConnections,
}: {
  /** The provider connection functions from the preload script; undefined outside Electron. */
  readonly providerConnections: ProviderConnectionsBridge | undefined;
}) {
  const [view, setView] = useState(() =>
    initialProviderConnectionSectionView(providerConnections !== undefined),
  );
  useEffect(
    () =>
      providerConnections === undefined
        ? undefined
        : followProviderConnections(providerConnections, setView),
    [providerConnections],
  );
  const model = useMemo(() => describeProviderConnections(view), [view]);
  const [actions, setActions] = useState(IDLE_PROVIDER_CONNECTION_ACTIONS);
  const controller = useMemo(
    () =>
      providerConnections === undefined
        ? undefined
        : createProviderConnectionActions(providerConnections, setActions),
    [providerConnections],
  );
  useEffect(() => controller?.follow(model), [controller, model]);
  const handlers = useMemo(
    () =>
      controller === undefined
        ? undefined
        : providerConnectionHandlers(controller, () =>
            focusProviderConnectionsTitle(document),
          ),
    [controller],
  );
  return (
    <>
      <ProviderConnectionsContent
        model={model}
        actions={actions}
        handlers={handlers}
      />
      {handlers === undefined ? null : (
        <ProviderConnectionQuestionBox
          question={actions.question}
          onConfirm={handlers.onConfirm}
          onCancel={handlers.onCancel}
        />
      )}
    </>
  );
}
