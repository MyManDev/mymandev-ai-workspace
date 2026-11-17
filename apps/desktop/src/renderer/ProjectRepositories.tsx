import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { ProjectRepositoriesBridge } from "../shared/desktop-bridge.ts";
import {
  decideFocusAfterLeave,
  rememberRunningButton,
  syncModal,
} from "./JoinRequests.tsx";
import { focusesTitleAfterClose } from "./people-actions-view.ts";
import {
  createProjectRepositoryActions,
  describeProjectRepositories,
  followProjectRepositories,
  IDLE_PROJECT_REPOSITORY_ACTIONS,
  initialProjectRepositoriesView,
  PROJECT_REPOSITORY_MESSAGES,
  PROJECT_REPOSITORY_QUESTION_MESSAGES,
  repositoryActions,
  type ProjectRepositoriesModel,
  type ProjectRepositoryActions,
  type ProjectRepositoryActionsView,
  type ProjectRepositoryDialog,
  type RepositoryActionRequest,
  type RepositoryLinkRow,
  type RepositoryRow,
} from "./project-repositories-view.ts";
import type { RepositoryPanelView } from "./repository-view.ts";

/** The element ID of the part's title, which takes the focus without a tab stop. */
export const PROJECT_REPOSITORIES_TITLE_ID = "project-repositories-title";

/** The element ID of the status paragraph of the part's actions. */
export const PROJECT_REPOSITORY_MESSAGE_ID = "project-repository-message";

/** The element ID of a repository's name, by its place in the list, never its ID. */
export function repositoryNameId(index: number): string {
  return `project-repository-name-${String(index)}`;
}

/** What the part needs to offer its actions. */
export interface ProjectRepositoryHandlers {
  /** Starts an action; `button` is the one that the person used. */
  readonly onStart: (
    request: RepositoryActionRequest,
    button: Element | null,
  ) => void;
  readonly onChoose: (mountId: string) => void;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly onRegisterDraft: (text: string) => void;
  readonly onRegister: (projectId: string) => void;
}

export interface ProjectRepositoriesContentProps {
  readonly model: ProjectRepositoriesModel;
  readonly actions: ProjectRepositoryActionsView;
  /** Undefined without the bridge: then nothing is offered. */
  readonly handlers: ProjectRepositoryHandlers | undefined;
}

/**
 * The open project's registered repositories, at the top of the repository
 * panel (#286), without state: its title, which takes the focus without a
 * tab stop, a hint, one status paragraph that is always rendered, so that a
 * screen reader announces a new text, and with the bridge a second one for
 * the sentence of the last action. Each repository shows its name, as text
 * that a person entered, with `dir="auto"` and never translated, and while
 * this device's links are `ready`, where it is linked. Each offers the
 * actions of `repositoryActions`, each described by the repository's name,
 * and while the list is `ready`, a form below them registers a repository.
 * While an action runs, every action's button stays focusable and does
 * nothing (`aria-disabled`), and the field is read-only.
 */
export function ProjectRepositoriesContent({
  model,
  actions,
  handlers,
}: ProjectRepositoriesContentProps) {
  const { rows, projectId } = model;
  const offered = handlers === undefined ? null : projectId;
  return (
    <section
      className="repository-section"
      aria-labelledby={PROJECT_REPOSITORIES_TITLE_ID}
    >
      <h3
        className="repository-section-title"
        id={PROJECT_REPOSITORIES_TITLE_ID}
        tabIndex={-1}
      >
        {PROJECT_REPOSITORY_MESSAGES.title}
      </h3>
      <p className="repository-note">{PROJECT_REPOSITORY_MESSAGES.hint}</p>
      <p className="repository-status" role="status">
        {model.status}
      </p>
      {handlers === undefined ? null : (
        <p
          className="repository-status"
          id={PROJECT_REPOSITORY_MESSAGE_ID}
          role="status"
        >
          {actions.message ?? ""}
        </p>
      )}
      {model.linksNote === "" ? null : (
        <p className="repository-note">{model.linksNote}</p>
      )}
      {rows === null || rows.length === 0 ? null : (
        <ul
          className="repository-list"
          aria-labelledby={PROJECT_REPOSITORIES_TITLE_ID}
        >
          {rows.map((row, index) => (
            <RepositoryItem
              key={row.repositoryId}
              row={row}
              index={index}
              model={model}
              running={actions.running}
              handlers={handlers}
            />
          ))}
        </ul>
      )}
      {offered === null || handlers === undefined ? null : (
        <RegisterForm
          projectId={offered}
          actions={actions}
          handlers={handlers}
        />
      )}
    </section>
  );
}

/** The label of each action's button. */
const ACTION_LABELS: Readonly<Record<RepositoryActionRequest["kind"], string>> =
  Object.freeze({
    link: PROJECT_REPOSITORY_MESSAGES.link,
    unlink: PROJECT_REPOSITORY_MESSAGES.unlink,
    remove: PROJECT_REPOSITORY_MESSAGES.remove,
  });

function RepositoryItem({
  row,
  index,
  model,
  running,
  handlers,
}: {
  readonly row: RepositoryRow;
  readonly index: number;
  readonly model: ProjectRepositoriesModel;
  readonly running: boolean;
  /** Undefined without the bridge: then nothing is offered. */
  readonly handlers: ProjectRepositoryHandlers | undefined;
}) {
  const nameId = repositoryNameId(index);
  const offered = handlers === undefined ? [] : repositoryActions(model, row);
  return (
    <li className="repository">
      <h4 className="repository-name" id={nameId} dir="auto" translate="no">
        {row.name}
      </h4>
      {row.link === null ? null : <LinkLine link={row.link} />}
      {handlers === undefined || offered.length === 0 ? null : (
        <div className="account-actions">
          {offered.map((request) => (
            <button
              key={request.kind}
              type="button"
              className="panel-action"
              aria-describedby={nameId}
              aria-disabled={running ? "true" : undefined}
              onClick={
                running
                  ? undefined
                  : (event) => handlers.onStart(request, event.currentTarget)
              }
            >
              {ACTION_LABELS[request.kind]}
            </button>
          ))}
        </div>
      )}
    </li>
  );
}

/**
 * Where a repository is linked on this device: the mounted folder's name
 * from the mount list, which shows its path below, never translated; or a
 * fixed sentence.
 */
function LinkLine({ link }: { readonly link: RepositoryLinkRow }) {
  switch (link.kind) {
    case "not_linked":
      return (
        <p className="repository-state">
          {PROJECT_REPOSITORY_MESSAGES.notLinked}
        </p>
      );
    case "folder":
      return (
        <p className="repository-state">
          {PROJECT_REPOSITORY_MESSAGES.linkedTo}
          <span dir="auto" translate="no">
            {link.folder.name}
          </span>
        </p>
      );
    case "mounted":
      return (
        <p className="repository-state">
          {PROJECT_REPOSITORY_MESSAGES.linkedFolder}
        </p>
      );
    case "not_mounted":
      return (
        <p className="repository-state">
          {PROJECT_REPOSITORY_MESSAGES.linkedNotMounted}
        </p>
      );
  }
}

/**
 * The form that registers a repository by its name, with its hint and an
 * alert for a name that is not sent. The field has no `maxLength`, which
 * HTML counts in UTF-16 code units: `repositoryNamePrompt` counts the
 * characters.
 */
function RegisterForm({
  projectId,
  actions,
  handlers,
}: {
  readonly projectId: string;
  readonly actions: ProjectRepositoryActionsView;
  readonly handlers: ProjectRepositoryHandlers;
}) {
  const { running } = actions;
  return (
    <form
      className="repository-register"
      aria-labelledby="project-repository-register-title"
      onSubmit={(event) => {
        event.preventDefault();
        if (!running) {
          handlers.onRegister(projectId);
        }
      }}
    >
      <h4 id="project-repository-register-title">
        {PROJECT_REPOSITORY_MESSAGES.registerTitle}
      </h4>
      <label className="account-label" htmlFor="project-repository-field">
        {PROJECT_REPOSITORY_MESSAGES.nameLabel}
      </label>
      <input
        id="project-repository-field"
        className="account-input"
        type="text"
        dir="auto"
        autoComplete="off"
        spellCheck={false}
        value={actions.registerDraft}
        readOnly={running}
        aria-invalid={
          actions.registerProblem === undefined ? undefined : "true"
        }
        aria-describedby="project-repository-hint project-repository-problem"
        onChange={(event) =>
          handlers.onRegisterDraft(event.currentTarget.value)
        }
      />
      <p className="repository-note" id="project-repository-hint">
        {PROJECT_REPOSITORY_MESSAGES.nameHint}
      </p>
      <p className="panel-message" id="project-repository-problem" role="alert">
        {actions.registerProblem ?? ""}
      </p>
      <div className="account-actions">
        <button
          type="submit"
          className="panel-action"
          aria-disabled={running ? "true" : undefined}
        >
          {PROJECT_REPOSITORY_MESSAGES.register}
        </button>
      </div>
    </form>
  );
}

export interface ProjectRepositoryDialogProps {
  readonly dialog: ProjectRepositoryDialog | undefined;
  readonly onChoose: (mountId: string) => void;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

/**
 * The question before a removal and the choice of a link's folder, as a
 * modal dialog of the page (`showModal`), like the people actions'
 * question: the rest of the page is inert until the person answers, and
 * Escape cancels. Closing the dialog returns the focus to the action's
 * button.
 */
export function ProjectRepositoryDialogBox(
  props: ProjectRepositoryDialogProps,
) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const open = props.dialog !== undefined;
  useEffect(() => syncModal(dialogRef.current, open), [open]);
  return <ProjectRepositoryDialogContent {...props} dialogRef={dialogRef} />;
}

/**
 * The dialog for a question, without state. The element stays in the page
 * while no question is open, empty and closed, so that closing it can
 * return the focus. The repository's name is text with `dir="auto"`, never
 * translated, and describes the dialog before the sentence. A link offers
 * the folders that can be chosen as radio buttons, each with its name and
 * its path from the mount list, and says that the main process asks again
 * in a dialog of its own; without a folder to choose, it says why and
 * offers only "Cancel". Its problem shows in an alert inside the dialog,
 * because the page behind it is inert. "Cancel" comes first. The checked
 * folder has `autoFocus`; the removal's question has none, so that its
 * first control, "Cancel", takes the focus.
 */
export function ProjectRepositoryDialogContent({
  dialog,
  onChoose,
  onConfirm,
  onCancel,
  dialogRef,
}: ProjectRepositoryDialogProps & {
  readonly dialogRef?: RefObject<HTMLDialogElement | null>;
}) {
  if (dialog === undefined) {
    return <dialog ref={dialogRef} className="people-dialog" />;
  }
  const messages = PROJECT_REPOSITORY_QUESTION_MESSAGES;
  const link = dialog.kind === "link" ? dialog : undefined;
  const confirmable = link === undefined || link.choices.length > 0;
  return (
    <dialog
      ref={dialogRef}
      className="people-dialog"
      aria-labelledby="project-repository-dialog-title"
      aria-describedby="project-repository-dialog-name project-repository-dialog-text"
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
        <h2 id="project-repository-dialog-title">
          {link === undefined ? messages.removeTitle : messages.linkTitle}
        </h2>
        <p
          className="people-dialog-name"
          id="project-repository-dialog-name"
          dir="auto"
          translate="no"
        >
          {dialog.request.name}
        </p>
        <p id="project-repository-dialog-text">
          {link === undefined ? messages.removeText : messages.linkText}
        </p>
        {link === undefined ? null : link.choices.length === 0 ? (
          <p>{messages.linkNone}</p>
        ) : (
          <>
            <fieldset
              className="repository-choice"
              aria-describedby="project-repository-dialog-problem"
            >
              <legend>{messages.linkLegend}</legend>
              {link.choices.map((choice) => {
                const checked = link.mountId === choice.mountId;
                return (
                  <label className="repository-option" key={choice.mountId}>
                    <input
                      type="radio"
                      name="project-repository-folder"
                      checked={checked}
                      autoFocus={checked}
                      onChange={() => onChoose(choice.mountId)}
                    />
                    <span>
                      <span dir="auto" translate="no">
                        {choice.name}
                      </span>
                      <code
                        className="repository-option-path"
                        dir="ltr"
                        translate="no"
                      >
                        {choice.path}
                      </code>
                    </span>
                  </label>
                );
              })}
            </fieldset>
            <p
              className="panel-message"
              id="project-repository-dialog-problem"
              role="alert"
            >
              {link.problem ?? ""}
            </p>
          </>
        )}
        <div className="people-dialog-actions">
          <button type="button" className="panel-action" onClick={onCancel}>
            {PROJECT_REPOSITORY_MESSAGES.cancel}
          </button>
          {confirmable ? (
            <button type="submit" className="panel-action">
              {link === undefined
                ? messages.removeConfirm
                : messages.linkConfirm}
            </button>
          ) : null}
        </div>
      </form>
    </dialog>
  );
}

/**
 * Moves the focus to the part's title in `root`, the page's document, which
 * takes it without a tab stop.
 */
export function focusProjectRepositoriesTitle(
  root: Pick<Document, "getElementById">,
): void {
  root.getElementById(PROJECT_REPOSITORIES_TITLE_ID)?.focus();
}

/** What the repository panel needs of the project's repositories. */
export interface ProjectRepositoriesControls {
  readonly model: ProjectRepositoriesModel;
  readonly actions: ProjectRepositoryActionsView;
  readonly handlers: ProjectRepositoryHandlers | undefined;
}

/**
 * The part as the repository panel shows it, without state: the content,
 * and with the bridge the dialog of its questions, which shows the
 * controller's open question and passes a choice, "Continue", and a cancel
 * on to the handlers.
 */
export function ProjectRepositoriesPart({
  model,
  actions,
  handlers,
}: ProjectRepositoriesControls) {
  return (
    <>
      <ProjectRepositoriesContent
        model={model}
        actions={actions}
        handlers={handlers}
      />
      {handlers === undefined ? null : (
        <ProjectRepositoryDialogBox
          dialog={actions.dialog}
          onChoose={handlers.onChoose}
          onConfirm={handlers.onConfirm}
          onCancel={handlers.onCancel}
        />
      )}
    </>
  );
}

/**
 * The part's handlers on `controller`: each passes the person's input on.
 * The start of an action remembers its button in `trigger`, which the
 * dialog gives the focus back to and whose leaving the hook decides; a
 * registration remembers none, because the form's button stays.
 */
export function projectRepositoryHandlers(
  controller: ProjectRepositoryActions,
  trigger: { current: Element | null },
): ProjectRepositoryHandlers {
  return {
    onStart: (request, button) => {
      trigger.current = button;
      void controller.start(request);
    },
    onChoose: controller.choose,
    onConfirm: () => {
      void controller.confirm();
    },
    onCancel: controller.cancel,
    onRegisterDraft: controller.editRegisterDraft,
    onRegister: (projectId) => {
      trigger.current = null;
      void controller.register(projectId);
    },
  };
}

/**
 * Follows the open project's registered repositories while the panel is
 * shown, for the project that the shell shows (`projectId`) and the mount
 * list (`mounts`), and runs the part's actions
 * (`createProjectRepositoryActions`), which follow every model, with the
 * handlers of `projectRepositoryHandlers`; undefined handlers without the
 * bridge.
 *
 * The focus: a question remembers the button that opened it, which the
 * dialog gives the focus back to; when the question ends after that button
 * left the page, the focus moves to the part's title
 * (`focusesTitleAfterClose`). The button of an action that runs is
 * remembered (`rememberRunningButton`), and once it has left the page, for
 * example with a removed repository or after "Unlink", the focus moves to
 * the part's title while it is on the page (`decideFocusAfterLeave`, #274).
 */
export function useProjectRepositories(
  bridge: ProjectRepositoriesBridge | undefined,
  projectId: string,
  mounts: RepositoryPanelView,
): ProjectRepositoriesControls {
  const [view, setView] = useState(() =>
    initialProjectRepositoriesView(bridge !== undefined),
  );
  useEffect(
    () =>
      bridge === undefined
        ? undefined
        : followProjectRepositories(bridge, setView),
    [bridge],
  );
  const model = useMemo(
    () => describeProjectRepositories(view, mounts, projectId),
    [view, mounts, projectId],
  );
  const [actions, setActions] = useState(IDLE_PROJECT_REPOSITORY_ACTIONS);
  const controller = useMemo(
    () =>
      bridge === undefined
        ? undefined
        : createProjectRepositoryActions(bridge, setActions),
    [bridge],
  );
  useEffect(() => controller?.follow(model), [controller, model]);
  const trigger = useRef<Element | null>(null);
  const wasOpen = useRef(false);
  const open = actions.dialog !== undefined;
  useEffect(() => {
    const button = trigger.current;
    if (
      focusesTitleAfterClose(
        wasOpen.current,
        open,
        button !== null && !button.isConnected,
      )
    ) {
      focusProjectRepositoriesTitle(document);
    }
    wasOpen.current = open;
  }, [open]);
  const acted = useRef<Element | null>(null);
  const { running } = actions;
  useEffect(
    () => rememberRunningButton(acted, running, trigger.current),
    [running],
  );
  useEffect(() => {
    if (
      decideFocusAfterLeave(
        acted,
        open,
        running,
        document.activeElement,
        document.body,
      )
    ) {
      focusProjectRepositoriesTitle(document);
    }
  }, [model, running, open]);
  const handlers = useMemo(
    () =>
      controller === undefined
        ? undefined
        : projectRepositoryHandlers(controller, trigger),
    [controller],
  );
  return { model, actions, handlers };
}
