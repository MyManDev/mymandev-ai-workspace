import { useCallback, useEffect, useState } from "react";
import type { RepositoryBridge } from "../shared/desktop-bridge.ts";
import type {
  GitRemote,
  MountedRepository,
  RepositoryState,
} from "../shared/ipc-contract.ts";
import {
  describeBranch,
  describeChanges,
  describeUpstream,
  initialRepositoryView,
  MOUNT_REFUSAL_MESSAGES,
  REPOSITORY_PROBLEM_MESSAGES,
  type RepositoryPanelView,
} from "./repository-view.ts";

/**
 * The repositories of the side panel: the repositories mounted on this
 * device, with their branch, their changes, and their remotes, read-only.
 * The list follows the main process, which refreshes it after file changes.
 */
export function RepositoryPanel({
  repositories,
}: {
  readonly repositories: RepositoryBridge | undefined;
}) {
  return <RepositoryPanelContent {...useRepositoryPanel(repositories)} />;
}

export interface RepositoryPanelContentProps {
  readonly view: RepositoryPanelView;
  /** True while the folder dialog is open or a folder is being checked. */
  readonly busy: boolean;
  /** Why the last folder was not added, or why an action failed. */
  readonly message: string | undefined;
  readonly onMount: () => void;
  readonly onUnmount: (mountId: string) => void;
}

export function RepositoryPanelContent({
  view,
  busy,
  message,
  onMount,
  onUnmount,
}: RepositoryPanelContentProps) {
  return (
    <>
      <h2 id="panel-title">Repositories</h2>
      {view.kind === "unavailable" ? (
        <p>Repositories are not available.</p>
      ) : (
        <>
          <button
            type="button"
            className="panel-action"
            disabled={busy || view.kind === "pending"}
            onClick={onMount}
          >
            Add a repository
          </button>
          {message === undefined ? null : (
            <p className="panel-message" role="alert">
              {message}
            </p>
          )}
          {view.kind === "pending" ? (
            <p>Reading the repositories.</p>
          ) : (
            <RepositoryList
              repositories={view.list.repositories}
              onUnmount={onUnmount}
            />
          )}
        </>
      )}
      <p className="placeholder-note">
        Repositories are only read: nothing in their folders is changed.
      </p>
    </>
  );
}

export function RepositoryList({
  repositories,
  onUnmount,
}: {
  readonly repositories: readonly MountedRepository[];
  readonly onUnmount: (mountId: string) => void;
}) {
  if (repositories.length === 0) {
    return <p>No repositories yet.</p>;
  }
  return (
    <ul className="repository-list" aria-labelledby="panel-title">
      {repositories.map((repository) => (
        <RepositoryItem
          key={repository.mountId}
          repository={repository}
          onUnmount={onUnmount}
        />
      ))}
    </ul>
  );
}

function RepositoryItem({
  repository,
  onUnmount,
}: {
  readonly repository: MountedRepository;
  readonly onUnmount: (mountId: string) => void;
}) {
  return (
    <li className="repository">
      <h3 className="repository-name">{repository.name}</h3>
      <p className="repository-path">
        <code>{repository.path}</code>
      </p>
      <RepositoryStateView state={repository.state} />
      {repository.watching ? null : (
        <p className="placeholder-note">Not watching for file changes.</p>
      )}
      <button
        type="button"
        className="repository-remove"
        aria-label={`Remove ${repository.name} from the list`}
        onClick={() => onUnmount(repository.mountId)}
      >
        Remove
      </button>
    </li>
  );
}

function RepositoryStateView({ state }: { readonly state: RepositoryState }) {
  switch (state.kind) {
    case "loading":
      return <p className="repository-state">Reading the repository.</p>;
    case "unavailable":
      return (
        <p className="repository-state" data-problem={state.problem}>
          {REPOSITORY_PROBLEM_MESSAGES[state.problem]}
        </p>
      );
    case "ready": {
      const upstream = describeUpstream(state.branch);
      return (
        <dl className="repository-facts">
          <dt>Branch</dt>
          <dd>{describeBranch(state.branch)}</dd>
          {upstream === undefined ? null : (
            <>
              <dt>Upstream</dt>
              <dd>{upstream}</dd>
            </>
          )}
          <dt>Changes</dt>
          <dd>{describeChanges(state.changes)}</dd>
          <dt>Remotes</dt>
          <dd>
            {state.remotes.length === 0 ? (
              "None"
            ) : (
              <ul className="remote-list">
                {state.remotes.map((remote) => (
                  <RemoteItem key={remote.name} remote={remote} />
                ))}
              </ul>
            )}
          </dd>
        </dl>
      );
    }
  }
}

function RemoteItem({ remote }: { readonly remote: GitRemote }) {
  const url = remote.fetchUrl ?? remote.pushUrl;
  return (
    <li>
      <span className="remote-name">{remote.name}</span>
      {url === null ? null : <code className="remote-url">{url}</code>}
      {remote.pushUrl === null || remote.pushUrl === url ? null : (
        <code className="remote-url">push: {remote.pushUrl}</code>
      )}
    </li>
  );
}

/** Follows the mounted repositories while the panel is shown. */
function useRepositoryPanel(
  bridge: RepositoryBridge | undefined,
): RepositoryPanelContentProps {
  const [view, setView] = useState(() =>
    initialRepositoryView(bridge !== undefined),
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (bridge === undefined) {
      return undefined;
    }
    return bridge.subscribe(
      (list) => setView({ kind: "known", list }),
      () => setView({ kind: "unavailable" }),
    );
  }, [bridge]);

  const onMount = useCallback(() => {
    if (bridge === undefined) {
      return;
    }
    setBusy(true);
    setMessage(undefined);
    bridge
      .mount()
      .then(
        (result) =>
          setMessage(
            result.outcome === "refused"
              ? MOUNT_REFUSAL_MESSAGES[result.reason]
              : undefined,
          ),
        () => setMessage(MOUNT_REFUSAL_MESSAGES.failed),
      )
      .finally(() => setBusy(false));
  }, [bridge]);

  const onUnmount = useCallback(
    (mountId: string) => {
      if (bridge === undefined) {
        return;
      }
      setMessage(undefined);
      bridge
        .unmount(mountId)
        .catch(() =>
          setMessage("The repository could not be removed from the list."),
        );
    },
    [bridge],
  );

  return { view, busy, message, onMount, onUnmount };
}
