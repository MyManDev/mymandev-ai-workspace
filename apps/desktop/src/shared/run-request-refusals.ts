// The refusals of a run request (#35) that the main process and the
// renderer share. This module imports nothing, so the renderer may import
// its values.

/**
 * The refusals of a run request that the main process gives from its own
 * checks, before anything is sent: each is a code of
 * `RUN_REQUEST_REFUSALS` in `ipc-contract.ts`. The main process keeps the
 * outcome of every other request (`RunRequestOutcomeSchema`), and the chat
 * screen takes that kept outcome after it showed the answer itself.
 */
export const RUN_REQUEST_LOCAL_REFUSALS: ReadonlySet<string> = new Set([
  "invalid",
  "not_open",
  "not_owner",
  "not_hosted_here",
  "disabled",
  "message_not_found",
  "not_own_message",
  "connection_not_here",
  "busy",
]);
