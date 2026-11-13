import { WorkspaceIdSchema } from "@mymandev/protocol";
import { INVOKE_CHANNELS } from "../shared/ipc-channels.ts";
import type { CopyWorkspaceIdResult } from "../shared/ipc-contract.ts";
import { createInvokeHandler, type IpcRegistry } from "./ipc.ts";
import type { WorkspaceService } from "./workspace/service.ts";

const OK: CopyWorkspaceIdResult = Object.freeze({ outcome: "ok" });
const INVALID: CopyWorkspaceIdResult = Object.freeze({
  outcome: "refused",
  reason: "invalid",
});
const NOT_FOUND: CopyWorkspaceIdResult = Object.freeze({
  outcome: "refused",
  reason: "not_found",
});
const FAILED: CopyWorkspaceIdResult = Object.freeze({ outcome: "failed" });

/** The part of Electron's `clipboard` that copying a workspace ID uses. */
export interface WorkspaceIdClipboard {
  readonly writeText: (text: string) => void;
}

export interface WorkspaceIdCopyOptions {
  /** The workspace service, whose list holds the workspaces that may be copied. */
  readonly workspaces: Pick<WorkspaceService, "state">;
  /** Electron's `clipboard`, the only place that the ID is written to. */
  readonly clipboard: WorkspaceIdClipboard;
  /** Reports a write that the system refused, with a fixed message. */
  readonly onError?: ((message: string, error: unknown) => void) | undefined;
}

/**
 * Copies the ID of a workspace of the account's list to the system
 * clipboard (#95; the Project Manager's decision of 2026-11-13), so that a
 * member can pass it on to someone who then asks to join with it. The ID is
 * not a secret (ADR 0014, "What a workspace ID allows"): a request only
 * creates something that an approver must accept.
 *
 * It checks the ID with the protocol's ID schema, after the contract's own
 * check, and refuses another value as `invalid`; it then refuses a
 * workspace that the workspace service's list does not hold as
 * `not_found`, also without a signed-in device, whose list is empty. Only
 * then does it write, and it writes the list's own ID and nothing else: no
 * other text of the renderer ever reaches the clipboard. A write that
 * throws is reported with a fixed message, which names no ID, and answers
 * `failed`.
 */
export function copyWorkspaceId(
  value: string,
  options: WorkspaceIdCopyOptions,
): CopyWorkspaceIdResult {
  const parsed = WorkspaceIdSchema.safeParse(value);
  if (!parsed.success) {
    return INVALID;
  }
  const listed = options.workspaces
    .state()
    .workspaces.find((workspace) => workspace.id === parsed.data);
  if (listed === undefined) {
    return NOT_FOUND;
  }
  try {
    options.clipboard.writeText(listed.id);
  } catch (error) {
    (options.onError ?? ((message, cause) => console.error(message, cause)))(
      "Copying the workspace ID failed.",
      error,
    );
    return FAILED;
  }
  return OK;
}

/**
 * Registers the handler of the channel that copies a workspace ID. It
 * checks the sender and the arguments first (`createInvokeHandler`): one
 * workspace ID as a lowercase UUIDv7, with no other argument. The result
 * is parsed by the contract, so only a fixed outcome reaches the renderer.
 * Call it before the first window loads.
 */
export function registerWorkspaceIdIpc(
  ipc: IpcRegistry,
  appUrl: string,
  options: WorkspaceIdCopyOptions,
): void {
  ipc.handle(
    INVOKE_CHANNELS.copyWorkspaceId,
    createInvokeHandler(
      INVOKE_CHANNELS.copyWorkspaceId,
      appUrl,
      (_event, [workspaceId]) => copyWorkspaceId(workspaceId, options),
    ),
  );
}
