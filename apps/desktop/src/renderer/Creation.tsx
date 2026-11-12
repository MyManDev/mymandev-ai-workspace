import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { WorkspaceBridge } from "../shared/desktop-bridge.ts";
import {
  CREATE_MESSAGES,
  createCreation,
  describeCreatedOffer,
  describeCreation,
  IDLE_CREATION,
  type CreateDialog,
  type CreatedOffer,
  type CreatedOpenPaths,
  type CreatePlace,
  type CreationOffer,
  type CreationView,
} from "./creation-view.ts";
import { focusesTitleAfterAction } from "./device-view.ts";
import { focusesTitleAfterLeave } from "./join-invitation-view.ts";
import { focusesTitleAfterClose } from "./people-actions-view.ts";
import type { WorkspacePanelView } from "./workspace-view.ts";

/** The ID of the home screen's title, which takes the focus after a create there. */
export const HOME_TITLE_ID = "home-title";

/** The ID of the home screen's form to create a workspace. */
export const HOME_FORM_ID = "home-create";

/**
 * The ID of the sidebar's "Workspaces" heading, which takes the focus when
 * the dialog closes after the button that opened it left the page.
 */
export const WORKSPACES_HEADING_ID = "workspaces-heading";

/**
 * The IDs of the status paragraphs of the creates, by place, which
 * describe the button that a sentence offers.
 */
export const CREATE_STATUS_IDS: Readonly<Record<CreatePlace, string>> =
  Object.freeze({
    home: "create-status-home",
    workspaces: "create-status-workspaces",
    projects: "create-status-projects",
  });

/**
 * The ID of the element that takes the focus as the button of a sentence
 * ("Open this workspace" or "Open this project") changes from the place
 * `before` to `after`, or undefined: only when it was shown, left its
 * place, and the focus fell to the page (`focusesTitleAfterLeave`), as
 * when the workspace is selected or the project open. The targets are the
 * ones of the creates (#258): the home screen's title for the home screen,
 * and the sidebar's "Workspaces" heading for the sidebar.
 */
export function focusAfterOpenLeaves(
  before: CreatePlace | undefined,
  after: CreatePlace | undefined,
  focusOnPage: boolean,
): string | undefined {
  if (
    before === undefined ||
    !focusesTitleAfterLeave(true, after === before, focusOnPage)
  ) {
    return undefined;
  }
  return before === "home" ? HOME_TITLE_ID : WORKSPACES_HEADING_ID;
}

/** What the shell shows and does of its creates; see `useCreation`. */
export interface CreationControls {
  readonly view: CreationView;
  readonly offer: CreationOffer;
  /**
   * The button that the sentence offers ("Open this workspace" or "Open
   * this project"), or undefined.
   */
  readonly created: CreatedOffer | undefined;
  /** Opens what the sentence offers, through the existing paths. */
  readonly onOpenCreated: () => void;
  /**
   * Opens the sidebar's dialog for `place`; gets the button that was
   * clicked, and for a project the workspace that the button was shown for.
   */
  readonly onOpen: (
    place: "workspaces" | "projects",
    button: Element | null,
  ) => void;
  /** Changes the name in the home screen's field. */
  readonly onHomeDraft: (text: string) => void;
  /** Creates a workspace with the home screen's name. */
  readonly onCreateFromHome: () => void;
  /** Runs the create of the open dialog. */
  readonly onConfirm: () => void;
  /** Closes the dialog without a create. */
  readonly onCancel: () => void;
  /** Changes the name in the dialog's field. */
  readonly onDialogDraft: (text: string) => void;
}

/**
 * The status paragraph of the creates at `place`, always in the page while
 * its place is, empty when there is nothing to say, so that a screen
 * reader announces a new sentence. The sentence is fixed text.
 */
export function CreateStatus({
  place,
  message,
  className,
}: {
  readonly place: CreatePlace;
  readonly message: CreationView["message"];
  readonly className: string;
}) {
  return (
    <p className={className} id={CREATE_STATUS_IDS[place]} role="status">
      {message?.place === place ? message.text : ""}
    </p>
  );
}

/**
 * "Open this workspace" or "Open this project" after the status paragraph
 * at `place`, while its sentence offers it (`describeCreatedOffer`),
 * described by the sentence, like the join screen's "Open this workspace"
 * (#249). While a create runs it stays focusable and does nothing
 * (`aria-disabled`), like the other create controls. The button's text is
 * fixed; no name or ID is in it.
 */
export function CreatedOpenButton({
  place,
  created,
  running,
  onOpen,
  className,
}: {
  readonly place: CreatePlace;
  readonly created: CreatedOffer | undefined;
  readonly running: boolean;
  readonly onOpen: () => void;
  readonly className: string;
}) {
  if (created?.place !== place) {
    return null;
  }
  return (
    <div className={className}>
      <button
        type="button"
        className="panel-action"
        aria-describedby={CREATE_STATUS_IDS[place]}
        aria-disabled={running ? "true" : undefined}
        onClick={running ? undefined : onOpen}
      >
        {created.kind === "workspace"
          ? CREATE_MESSAGES.openWorkspace
          : CREATE_MESSAGES.openProject}
      </button>
    </div>
  );
}

/**
 * The sidebar's "New workspace" or "New project". While a create runs it
 * stays focusable and does nothing (`aria-disabled`), like the people
 * actions' buttons, so that the focus stays on it.
 */
export function CreateButton({
  place,
  running,
  onOpen,
}: {
  readonly place: "workspaces" | "projects";
  readonly running: boolean;
  readonly onOpen: CreationControls["onOpen"];
}) {
  return (
    <div className="nav-create">
      <button
        type="button"
        className="panel-action"
        aria-disabled={running ? "true" : undefined}
        onClick={
          running
            ? undefined
            : (event: { readonly currentTarget: Element | null }) =>
                onOpen(place, event.currentTarget)
        }
      >
        {place === "workspaces"
          ? CREATE_MESSAGES.newWorkspace
          : CREATE_MESSAGES.newProject}
      </button>
    </div>
  );
}

/**
 * The home screen's form while the account has no workspace: a name field
 * and "Create", which creates the workspace at once, without a question,
 * after the hint said what it does. The field is described by the hint and
 * by its own alert, which says why a name was not sent; the result goes to
 * the home screen's status paragraph. While a create runs, the field keeps
 * its text and the button does nothing. The field has no `maxLength`: HTML
 * counts it in UTF-16 code units, while the limit of a name counts
 * characters (code points), so `newNamePrompt` alone checks the length.
 */
export function HomeCreateWorkspace({
  draft,
  problem,
  running,
  onDraft,
  onCreate,
}: {
  readonly draft: string;
  /** Why the name was not sent, or undefined. */
  readonly problem: string | undefined;
  readonly running: boolean;
  readonly onDraft: (text: string) => void;
  readonly onCreate: () => void;
}) {
  return (
    <form
      id={HOME_FORM_ID}
      className="people-form"
      aria-labelledby="home-create-title"
      onSubmit={(event) => {
        event.preventDefault();
        if (!running) {
          onCreate();
        }
      }}
    >
      <h3 id="home-create-title">{CREATE_MESSAGES.homeTitle}</h3>
      <p>{CREATE_MESSAGES.homeIntro}</p>
      <p className="person-meta" id="home-create-hint">
        {CREATE_MESSAGES.workspaceHint}
      </p>
      <label className="account-label" htmlFor="home-create-name">
        {CREATE_MESSAGES.nameLabel}
      </label>
      <input
        id="home-create-name"
        className="account-input"
        type="text"
        dir="auto"
        autoComplete="off"
        spellCheck={false}
        value={draft}
        aria-invalid={problem === undefined ? undefined : "true"}
        aria-describedby="home-create-hint home-create-problem"
        onChange={(event) => onDraft(event.currentTarget.value)}
      />
      <p className="panel-message" id="home-create-problem" role="alert">
        {problem ?? ""}
      </p>
      <div className="account-actions">
        <button
          type="submit"
          className="panel-action"
          aria-disabled={running ? "true" : undefined}
        >
          {CREATE_MESSAGES.create}
        </button>
      </div>
    </form>
  );
}

export interface CreateDialogProps {
  /** The open dialog, or undefined when none is open. */
  readonly dialog: CreateDialog | undefined;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly onDraft: (text: string) => void;
}

/**
 * The sidebar's dialog that asks for the name of a new workspace or
 * project, as a modal dialog of the page (`showModal`), like the people
 * screen's rename: the rest of the page is inert until the person answers,
 * the focus moves to the name field, and Escape cancels. "Create" creates
 * at once; there is no second question. Closing the dialog returns the
 * focus to the button that opened it.
 */
export function CreateDialogBox(props: CreateDialogProps) {
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
  return <CreateDialogContent {...props} dialogRef={dialogRef} />;
}

/**
 * The dialog without state. The element stays in the page while no dialog
 * is open, empty and closed, so that closing it can return the focus. A
 * project's dialog names its workspace as text with `dir="auto"`, which
 * describes the dialog before the hint; the element IDs are fixed. The
 * field comes first, so that it takes the focus, and it has no
 * `maxLength`, as on the home screen. A name's problem shows in an alert
 * inside the dialog, because the page behind it is inert.
 */
export function CreateDialogContent({
  dialog,
  onConfirm,
  onCancel,
  onDraft,
  dialogRef,
}: CreateDialogProps & {
  readonly dialogRef?: RefObject<HTMLDialogElement | null>;
}) {
  if (dialog === undefined) {
    return <dialog ref={dialogRef} className="people-dialog" />;
  }
  const project = dialog.place === "projects";
  const named = project && dialog.workspaceName !== null;
  return (
    <dialog
      ref={dialogRef}
      className="people-dialog"
      aria-labelledby="create-dialog-title"
      aria-describedby={
        named ? "create-dialog-in create-dialog-hint" : "create-dialog-hint"
      }
      onCancel={(event) => {
        // Escape cancels; the dialog closes with the state.
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
        <h2 id="create-dialog-title">
          {project
            ? CREATE_MESSAGES.projectTitle
            : CREATE_MESSAGES.workspaceTitle}
        </h2>
        {named ? (
          <p className="people-dialog-name" id="create-dialog-in">
            {CREATE_MESSAGES.projectIn}
            <span dir="auto">{dialog.workspaceName}</span>
          </p>
        ) : null}
        <p id="create-dialog-hint">
          {project
            ? CREATE_MESSAGES.projectHint
            : CREATE_MESSAGES.workspaceHint}
        </p>
        <label className="account-label" htmlFor="create-dialog-field">
          {CREATE_MESSAGES.nameLabel}
        </label>
        <input
          id="create-dialog-field"
          className="account-input"
          type="text"
          dir="auto"
          autoComplete="off"
          spellCheck={false}
          value={dialog.draft}
          aria-invalid={dialog.problem === undefined ? undefined : "true"}
          aria-describedby="create-dialog-problem"
          onChange={(event) => onDraft(event.currentTarget.value)}
        />
        <p className="panel-message" id="create-dialog-problem" role="alert">
          {dialog.problem ?? ""}
        </p>
        <div className="people-dialog-actions">
          <button type="button" className="panel-action" onClick={onCancel}>
            {CREATE_MESSAGES.cancel}
          </button>
          <button type="submit" className="panel-action">
            {CREATE_MESSAGES.create}
          </button>
        </div>
      </form>
    </dialog>
  );
}

/** Moves the focus to the element with `id`, which takes it without a tab stop. */
function focusElement(id: string): void {
  document.getElementById(id)?.focus();
}

/**
 * Whether the focus is on the page or inside the element with `id`, so
 * that a person who moved on keeps their place.
 */
function focusOnPageOrIn(id: string): boolean {
  const active = document.activeElement;
  return (
    active === null ||
    active === document.body ||
    document.getElementById(id)?.contains(active) === true
  );
}

/** Whether the focus fell to the page. */
function focusOnPage(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body;
}

/**
 * The creates of the shell (`createCreation`) while it is mounted, which
 * follow every workspace state and whether the home screen is shown;
 * undefined without the bridge.
 *
 * - The dialog remembers the button that opened it, which the dialog gives
 *   the focus back to; when the dialog ends after that button left the
 *   page, for example with a sign-out, the focus moves to the sidebar's
 *   "Workspaces" heading (`focusesTitleAfterClose`).
 * - The home screen's form leaves the page once the confirmed workspace is
 *   listed, so after a confirmed create there the focus moves to the home
 *   screen's title, while it is still in the form or on the page
 *   (`focusesTitleAfterAction`).
 * - "Open this workspace" and "Open this project" go through `paths`
 *   (`createdOpenPaths`). When one leaves the page while the focus fell to
 *   the page, for example once the workspace is selected or the project
 *   open, the focus moves to the home screen's title or the sidebar's
 *   "Workspaces" heading (`focusAfterOpenLeaves`).
 */
export function useCreation(
  bridge: Pick<WorkspaceBridge, "create" | "createProject"> | undefined,
  workspaces: WorkspacePanelView,
  homeShown: boolean,
  paths: CreatedOpenPaths,
): CreationControls | undefined {
  const [view, setView] = useState(IDLE_CREATION);
  const controller = useMemo(
    () => (bridge === undefined ? undefined : createCreation(bridge, setView)),
    [bridge],
  );
  useEffect(
    () => controller?.viewChanged(workspaces),
    [controller, workspaces],
  );
  useEffect(() => controller?.homeShown(homeShown), [controller, homeShown]);
  const offer = useMemo(() => describeCreation(workspaces), [workspaces]);
  const trigger = useRef<Element | null>(null);
  const wasOpen = useRef(false);
  const open = view.dialog !== undefined;
  useEffect(() => {
    const button = trigger.current;
    if (
      focusesTitleAfterClose(
        wasOpen.current,
        open,
        button !== null && !button.isConnected,
      )
    ) {
      focusElement(WORKSPACES_HEADING_ID);
    }
    wasOpen.current = open;
  }, [open]);
  const created = useMemo(
    () => describeCreatedOffer(view.message, workspaces),
    [view.message, workspaces],
  );
  const createdAt = created?.place;
  const wasCreatedAt = useRef(createdAt);
  useEffect(() => {
    const target = focusAfterOpenLeaves(
      wasCreatedAt.current,
      createdAt,
      focusOnPage(),
    );
    wasCreatedAt.current = createdAt;
    if (target !== undefined) {
      focusElement(target);
    }
  }, [createdAt]);
  const onOpenCreated = useCallback(() => {
    controller?.openCreated(paths);
  }, [controller, paths]);
  const projectIn = offer.projectIn;
  const onOpen = useCallback(
    (place: "workspaces" | "projects", button: Element | null) => {
      trigger.current = button;
      if (place === "workspaces") {
        controller?.open(place);
      } else if (projectIn !== null) {
        controller?.open(place, projectIn.workspaceId, projectIn.workspaceName);
      }
    },
    [controller, projectIn],
  );
  return useMemo(
    (): CreationControls | undefined =>
      controller === undefined
        ? undefined
        : {
            view,
            offer,
            created,
            onOpenCreated,
            onOpen,
            onHomeDraft: controller.editHomeDraft,
            onCreateFromHome: () => {
              void controller.createFromHome().then((done) => {
                if (
                  focusesTitleAfterAction(done, focusOnPageOrIn(HOME_FORM_ID))
                ) {
                  focusElement(HOME_TITLE_ID);
                }
              });
            },
            onConfirm: () => {
              void controller.confirm();
            },
            onCancel: controller.cancel,
            onDialogDraft: controller.editDialogDraft,
          },
    [controller, view, offer, created, onOpenCreated, onOpen],
  );
}
