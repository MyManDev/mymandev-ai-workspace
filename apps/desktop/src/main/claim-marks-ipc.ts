import { EVENT_CHANNELS, INVOKE_CHANNELS } from "../shared/ipc-channels.ts";
import {
  type ClaimMarksView,
  WORKSPACE_LIMITS,
} from "../shared/ipc-contract.ts";
import { CLAIM_PUBLISH_INTERVAL_MS } from "./claim-ipc.ts";
import type { ClaimMarkService, ClaimMarkState } from "./claims/marks.ts";
import {
  createEventPublisher,
  createInvokeHandler,
  type IpcRegistry,
} from "./ipc.ts";
import type { ScheduleTimer } from "./runtime.ts";

/**
 * The frozen copy of the service's state that crosses IPC, with `revision`
 * as its revision: the IDs of the workspaces that hold a claim that the
 * account has not seen (the selected one only while its claims load), at
 * most
 * `WORKSPACE_LIMITS.workspaces`. Only whether a workspace has unseen claims
 * crosses, never a claim, a member ID, or a user ID.
 */
export function claimMarksView(
  state: ClaimMarkState,
  revision: number,
): ClaimMarksView {
  return Object.freeze({
    revision,
    workspaceIds: Object.freeze(
      state.workspaceIds.slice(0, WORKSPACE_LIMITS.workspaces),
    ),
  });
}

function scheduleWithSetTimeout(
  callback: () => void,
  delayMs: number,
): () => void {
  const handle = setTimeout(callback, delayMs);
  return () => clearTimeout(handle);
}

export interface ClaimMarksIpcOptions {
  readonly marks: Pick<ClaimMarkService, "state" | "onChange">;
  /** Defaults to `setTimeout`. */
  readonly scheduleTimer?: ScheduleTimer;
  /**
   * Receives a fixed message when a publish fails, never the error, so that
   * nothing that the error holds reaches a log. Defaults to
   * `console.error`.
   */
  readonly onError?: (message: string) => void;
}

export interface ClaimMarksIpc {
  /** Stops listening and cancels a publish that waits, for the quit. */
  readonly close: () => void;
}

/**
 * Registers the handlers of the claim mark channels and sends the marks of
 * the other workspaces to the frames that subscribed (#271). Both channels
 * take no argument; every handler checks the sender and the arguments first
 * (`createInvokeHandler`) and answers with a value parsed by the contract,
 * so only workspace IDs reach the renderer.
 *
 * A change of the service raises the view's revision at once and publishes
 * the latest view after `CLAIM_PUBLISH_INTERVAL_MS`, as the claims do. Call
 * it before the first window loads.
 */
export function registerClaimMarksIpc(
  ipc: IpcRegistry,
  appUrl: string,
  options: ClaimMarksIpcOptions,
): ClaimMarksIpc {
  const { marks } = options;
  const schedule = options.scheduleTimer ?? scheduleWithSetTimeout;
  const onError =
    options.onError ?? ((message: string) => console.error(message));
  const publisher = createEventPublisher(
    EVENT_CHANNELS.claimMarksChanged,
    appUrl,
  );

  let closed = false;
  let revision = 0;
  let cancelPublish: (() => void) | null = null;

  function view(): ClaimMarksView {
    return claimMarksView(marks.state(), revision);
  }

  function publish(): void {
    cancelPublish = null;
    if (closed) {
      return;
    }
    try {
      publisher.publish(view());
    } catch {
      // A fixed message: the error is not logged, whatever it holds.
      onError("Sending the claim marks failed.");
    }
  }

  function changed(): void {
    if (closed) {
      return;
    }
    revision += 1;
    // A publish that waits sends the latest view when its time comes.
    cancelPublish ??= schedule(publish, CLAIM_PUBLISH_INTERVAL_MS);
  }

  ipc.handle(
    INVOKE_CHANNELS.getClaimMarks,
    createInvokeHandler(INVOKE_CHANNELS.getClaimMarks, appUrl, () => view()),
  );
  ipc.handle(
    INVOKE_CHANNELS.subscribeClaimMarks,
    createInvokeHandler(
      INVOKE_CHANNELS.subscribeClaimMarks,
      appUrl,
      (event) => {
        publisher.add(event.sender);
        return view();
      },
    ),
  );
  const remove = marks.onChange(changed);

  return Object.freeze({
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      remove();
      cancelPublish?.();
      cancelPublish = null;
    },
  });
}
