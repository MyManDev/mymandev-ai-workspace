import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { ProviderConnectionsBridge } from "../shared/desktop-bridge.ts";
import { deviceTimeFormat, formatDeviceTime } from "./device-view.ts";
import { syncModal } from "./JoinRequests.tsx";
import {
  CLAUDE_MODELS_OFFERED,
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
  type ProviderConnectionTarget,
} from "./provider-connection-view.ts";

/** The ID of the section's title, which takes the focus without a tab stop. */
export const PROVIDER_CONNECTIONS_TITLE_ID = "provider-connections-title";

/** The ID of the status paragraph of the section's actions. */
export const PROVIDER_CONNECTION_MESSAGE_ID = "provider-connection-message";

/** The element ID of a connection's label, by its place in the list, never its ID. */
export function providerConnectionLabelId(index: number): string {
  return `provider-connection-label-${String(index)}`;
}

/** The ID of the key field of the open key form. */
export const PROVIDER_KEY_INPUT_ID = "provider-key-input";

/** The ID of the model select of the open key form or model form. */
export const PROVIDER_MODEL_INPUT_ID = "provider-model-input";

/** What the section needs to offer its actions. */
export interface ProviderConnectionHandlers {
  readonly onKind: (kind: string) => void;
  readonly onLabel: (text: string) => void;
  readonly onRegister: () => void;
  readonly onRemove: (row: ProviderConnectionRow) => void;
  readonly onAskKey: (row: ProviderConnectionRow) => void;
  readonly onKey: (text: string) => void;
  readonly onModel: (model: string) => void;
  readonly onSaveKey: () => void;
  readonly onCancelKey: () => void;
  readonly onAskModel: (row: ProviderConnectionRow) => void;
  readonly onSaveModel: () => void;
  readonly onCancelModel: () => void;
  readonly onRemoveKey: (row: ProviderConnectionRow) => void;
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
 * its sentence; its buttons are described by the label: "Enter an API
 * key" (or "Replace the API key" once one is stored), "Remove the API key"
 * while one may be stored, and "Remove". The key form opens under its
 * connection with one password field that is never prefilled (#33), and for
 * a Claude connection a required model select (#30). A Claude connection
 * also shows its model, and once its key is stored offers "Change the
 * model" (or "Choose the model" without one), a form with the select only.
 * While
 * a device is signed in, a form adds a connection by its provider and
 * label; it has no field for a key or a token. While an action runs, every
 * button stays focusable and does nothing (`aria-disabled`), and the
 * fields are read-only.
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
              actions={actions}
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
  actions,
  handlers,
}: {
  readonly row: ProviderConnectionRow;
  readonly index: number;
  readonly format: Intl.DateTimeFormat;
  readonly actions: ProviderConnectionActionsView;
  readonly handlers: ProviderConnectionHandlers | undefined;
}) {
  const { running } = actions;
  const labelId = providerConnectionLabelId(index);
  const keyOpen = actions.keyFor?.id === row.id;
  const modelOpen = actions.modelFor?.id === row.id;
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
        {row.modelName === null ? null : (
          <>
            <dt>{PROVIDER_CONNECTION_MESSAGES.model}</dt>
            <dd translate="no">{row.modelName}</dd>
          </>
        )}
      </dl>
      {handlers === undefined ? null : (
        <div className="account-actions">
          {keyOpen ? null : (
            <button
              type="button"
              className="panel-action"
              aria-describedby={labelId}
              aria-disabled={running ? "true" : undefined}
              onClick={running ? undefined : () => handlers.onAskKey(row)}
            >
              {row.keyAction === "replace"
                ? PROVIDER_CONNECTION_MESSAGES.replaceKey
                : PROVIDER_CONNECTION_MESSAGES.enterKey}
            </button>
          )}
          {row.modelAction === null || modelOpen ? null : (
            <button
              type="button"
              className="panel-action"
              aria-describedby={labelId}
              aria-disabled={running ? "true" : undefined}
              onClick={running ? undefined : () => handlers.onAskModel(row)}
            >
              {row.modelAction === "choose"
                ? PROVIDER_CONNECTION_MESSAGES.chooseModel
                : PROVIDER_CONNECTION_MESSAGES.changeModel}
            </button>
          )}
          {row.keyMayExist ? (
            <button
              type="button"
              className="panel-action"
              aria-describedby={labelId}
              aria-disabled={running ? "true" : undefined}
              onClick={running ? undefined : () => handlers.onRemoveKey(row)}
            >
              {PROVIDER_CONNECTION_MESSAGES.removeKey}
            </button>
          ) : null}
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
      {handlers === undefined ||
      !keyOpen ||
      actions.keyFor === undefined ? null : (
        <KeyForm
          target={actions.keyFor}
          actions={actions}
          handlers={handlers}
        />
      )}
      {handlers === undefined ||
      !modelOpen ||
      actions.modelFor === undefined ? null : (
        <ModelForm
          target={actions.modelFor}
          actions={actions}
          handlers={handlers}
        />
      )}
    </li>
  );
}

/**
 * The required model select of a Claude connection (#30): labelled
 * "Model", with a first option "Choose a model" that is no model, so that
 * nothing is chosen for the person, then the models of
 * `CLAUDE_MODELS_OFFERED` by their names. A native `select`, so it is
 * reached with the keyboard and announced with its label, its hint, and
 * its problem.
 */
function ModelSelect({
  actions,
  handlers,
}: {
  readonly actions: ProviderConnectionActionsView;
  readonly handlers: ProviderConnectionHandlers;
}) {
  return (
    <>
      <label className="account-label" htmlFor={PROVIDER_MODEL_INPUT_ID}>
        {PROVIDER_CONNECTION_MESSAGES.model}
      </label>
      <select
        id={PROVIDER_MODEL_INPUT_ID}
        className="account-input"
        required
        aria-required="true"
        value={actions.draftModel}
        disabled={actions.running}
        aria-invalid={actions.modelProblem === undefined ? undefined : "true"}
        aria-describedby="provider-model-hint provider-model-problem"
        onChange={(event) => handlers.onModel(event.currentTarget.value)}
      >
        <option value="">{PROVIDER_CONNECTION_MESSAGES.modelChoose}</option>
        {CLAUDE_MODELS_OFFERED.map((model) => (
          <option key={model.id} value={model.id}>
            {model.name}
          </option>
        ))}
      </select>
      <p className="account-message" id="provider-model-hint">
        {PROVIDER_CONNECTION_MESSAGES.modelHint}
      </p>
      <p className="panel-message" id="provider-model-problem" role="alert">
        {actions.modelProblem ?? ""}
      </p>
    </>
  );
}

/**
 * The form that changes the model of a Claude connection whose key is
 * stored, without the key (#30): the model select, "Store the model", and
 * "Cancel".
 */
function ModelForm({
  target,
  actions,
  handlers,
}: {
  readonly target: ProviderConnectionTarget;
  readonly actions: ProviderConnectionActionsView;
  readonly handlers: ProviderConnectionHandlers;
}) {
  const { running } = actions;
  return (
    <form
      className="account-form"
      aria-labelledby="provider-model-title"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (!running) {
          handlers.onSaveModel();
        }
      }}
    >
      <h4 id="provider-model-title">
        {PROVIDER_CONNECTION_MESSAGES.model}:{" "}
        <span dir="auto" translate="no">
          {target.label}
        </span>{" "}
        ({target.kindName})
      </h4>
      <ModelSelect actions={actions} handlers={handlers} />
      <div className="account-actions">
        <button
          type="submit"
          className="panel-action"
          aria-disabled={running ? "true" : undefined}
        >
          {PROVIDER_CONNECTION_MESSAGES.saveModel}
        </button>
        <button
          type="button"
          className="panel-action"
          aria-disabled={running ? "true" : undefined}
          onClick={running ? undefined : handlers.onCancelModel}
        >
          {PROVIDER_CONNECTION_MESSAGES.cancel}
        </button>
      </div>
    </form>
  );
}

/**
 * The form that stores a connection's API key: for a Claude connection the
 * required model select first (#30), then one password field, never
 * prefilled, that the actions empty as the key is sent; its hint says that
 * the key stays on this device and is never shown again; an alert for a
 * key that is not sent; "Store the key" and "Cancel". The field has no
 * `maxLength` and no autocomplete, and spelling is not checked, so that no
 * spelling service sees it.
 */
function KeyForm({
  target,
  actions,
  handlers,
}: {
  readonly target: ProviderConnectionTarget;
  readonly actions: ProviderConnectionActionsView;
  readonly handlers: ProviderConnectionHandlers;
}) {
  const { running } = actions;
  return (
    <form
      className="account-form"
      aria-labelledby="provider-key-title"
      // The actions check the model and say what is missing in the alert.
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (!running) {
          handlers.onSaveKey();
        }
      }}
    >
      <h4 id="provider-key-title">
        {PROVIDER_CONNECTION_MESSAGES.keyLabel}:{" "}
        <span dir="auto" translate="no">
          {target.label}
        </span>{" "}
        ({target.kindName})
      </h4>
      {target.needsModel ? (
        <ModelSelect actions={actions} handlers={handlers} />
      ) : null}
      <label className="account-label" htmlFor={PROVIDER_KEY_INPUT_ID}>
        {PROVIDER_CONNECTION_MESSAGES.keyLabel}
      </label>
      <input
        id={PROVIDER_KEY_INPUT_ID}
        className="account-input"
        type="password"
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        value={actions.draftKey}
        readOnly={running}
        aria-invalid={actions.keyProblem === undefined ? undefined : "true"}
        aria-describedby="provider-key-hint provider-key-problem"
        onChange={(event) => handlers.onKey(event.currentTarget.value)}
      />
      <p className="account-message" id="provider-key-hint">
        {PROVIDER_CONNECTION_MESSAGES.keyHint}
      </p>
      <p className="panel-message" id="provider-key-problem" role="alert">
        {actions.keyProblem ?? ""}
      </p>
      <div className="account-actions">
        <button
          type="submit"
          className="panel-action"
          aria-disabled={running ? "true" : undefined}
        >
          {PROVIDER_CONNECTION_MESSAGES.saveKey}
        </button>
        <button
          type="button"
          className="panel-action"
          aria-disabled={running ? "true" : undefined}
          onClick={running ? undefined : handlers.onCancelKey}
        >
          {PROVIDER_CONNECTION_MESSAGES.cancel}
        </button>
      </div>
    </form>
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
  text: "The server forgets it, every permission that lets an agent use it is revoked, and its API key is deleted from this device. Nothing on the provider's side changes.",
  confirm: "Remove the connection",
});

/** The fixed texts of the question before removing an API key. */
export const REMOVE_KEY_QUESTION_MESSAGES = Object.freeze({
  title: "Remove this connection's API key?",
  text: "The key is deleted from this device, and agents cannot use the connection here until you enter a key again. The connection stays, and nothing on the provider's side changes.",
  confirm: "Remove the API key",
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
  const texts =
    question.action === "removeKey"
      ? REMOVE_KEY_QUESTION_MESSAGES
      : REMOVE_QUESTION_MESSAGES;
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
        <h2 id="provider-connection-dialog-title">{texts.title}</h2>
        <p className="people-dialog-name" id="provider-connection-dialog-name">
          <span dir="auto" translate="no">
            {question.label}
          </span>{" "}
          ({question.kindName})
        </p>
        <p id="provider-connection-dialog-text">{texts.text}</p>
        <div className="people-dialog-actions">
          <button type="button" className="panel-action" onClick={onCancel}>
            {PROVIDER_CONNECTION_MESSAGES.cancel}
          </button>
          <button type="submit" className="panel-action">
            {texts.confirm}
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
    onAskKey: controller.askKey,
    onKey: controller.editKey,
    onModel: controller.editModel,
    onSaveKey: () => {
      void controller.saveKey();
    },
    onCancelKey: controller.cancelKey,
    onAskModel: controller.askModel,
    onSaveModel: () => {
      void controller.saveModel();
    },
    onCancelModel: controller.cancelModel,
    onRemoveKey: controller.askRemoveKey,
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
