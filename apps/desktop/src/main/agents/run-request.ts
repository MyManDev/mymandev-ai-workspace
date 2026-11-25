// Requesting a run of an agent from the project chat (#35, part A; the
// Project Manager's decisions of 2026-11-14 and 2026-11-25), in the main
// process: `POST /projects/:projectId/runs`, sent once with the account
// service's `sendWorkspaceAction` (`createRun` of the write allowlist).
//
// - Who asks. Only the agent's owner, and only from the agent's host
//   device. The agent list gives the host device to the agent's own account
//   only (#342); it is compared here with this device's ID
//   (`agentAccess`, `agentHost`) and never leaves the main process. An
//   agent whose host is not known, from a server without `hostDeviceId` or
//   before this device's key is ready, is refused as not hosted here.
// - What is the input. One of the person's own messages of the open
//   project's chat, as the chat service holds it now: a message of another
//   person or of an agent, or one that this device does not hold, is
//   refused. The request carries IDs only, never a text.
// - Which provider connection. One of this device's connections, as the
//   provider connection service's list holds it now. The API checks the
//   connection again on the agent's host device; an agent has no provider
//   kind of its own, so any of this device's connections is accepted here.
// - Refused locally, without a request: an ID that is not one, a project
//   that is not the open one, an agent that is not one of its agents, not
//   the account's, not hosted here, or disabled, a message that is not the
//   person's own in the open project, a connection that is not this
//   device's, and a second request while one waits (`busy`).
// - Sent once. The request carries no idempotency key, so the same request
//   sent again would create a second run: nothing here ever sends it again,
//   also not after `unknown`, a timeout, or a thrown error. The person
//   decides.
// - After every request that may have reached the API
//   (`workspaceActionMayHaveSent`), whatever its outcome, the agent
//   activity is asked to reload (`requestReload`), so that a run whose
//   answer or event was lost still shows. The run itself shows only
//   through the agent activity, the one list of runs; nothing here holds
//   it.
// - An answer whose run does not name the project, the agent, the
//   connection, and the message that were sent, or that names a
//   repository, is not this request's answer: it is `unknown`.
// - The outcome is kept. The answer goes back to the chat screen that
//   asked, but a switch of the project or the workspace, or leaving the
//   chat while the request waits, closes that screen, and its answer, also
//   "it may have been created" after `unknown`, would be lost, so that the
//   person might ask again and create a second run. So the outcome of the
//   last request of each project that passed the checks above is kept here
//   (`takeOutcome`), without the run's ID, for the device that sent it, for
//   at most `KEPT_RUN_REQUEST_OUTCOMES` projects. The chat screen of that
//   project takes it once when it opens, and after it showed an answer
//   itself. Another device or a sign-out drops them all.
// - The one retry after a `401`. The device session sends `createRun`
//   once more after a `401` that carries the API's error body, with a new
//   token for the same device and account only (`sendAuthorized`): the API
//   authenticates before the route's handler runs, so such a `401` means
//   that nothing was committed. A `401` without that body is `unknown`, and
//   it is not sent again.
//
// The host run supervisor picks a queued run up like any other. Until an
// executor is registered for its provider kind (#30, #31), it fails on the
// host device with `no_executor`; nothing here says that a run will run.
//
// The logs are fixed text, never an ID, a name, or a message body.
import {
  type AgentId,
  AgentIdSchema,
  type CreateRunResponse,
  type MessageId,
  MessageIdSchema,
  type ProjectId,
  ProjectIdSchema,
  type ProviderConnectionId,
  ProviderConnectionIdSchema,
} from "@mymandev/protocol";
import type {
  RunRequestOutcome,
  RunRequestRefusal,
  RunRequestResult,
  RunRequestView,
} from "../../shared/ipc-contract.ts";
import type { AccountService } from "../account.ts";
import {
  type RunCreationFailure,
  type WorkspaceActionResult,
  workspaceActionMayHaveSent,
} from "../api-actions.ts";
import type { ChatService } from "../chat/service.ts";
import {
  agentAccess,
  agentHost,
  grantViewer,
} from "../permissions/grant-actions.ts";
import { signedInDevice } from "../permissions/grant-store.ts";
import type { ProviderConnectionService } from "../provider-connections/service.ts";
import type { WorkspaceService } from "../workspace/service.ts";
import type { AgentActivityService } from "./service.ts";

/**
 * Each failure of a run creation and what a run request answers: every
 * code of `RUN_ROUTE_ERRORS.createRun` beyond the common ones has its own
 * refusal; `bad_request` is `failed`, `unauthorized` `not_signed_in`, and
 * `internal_error` `unknown`, as for every write. The codes that no run
 * creation answers are `failed`.
 */
const RUN_OUTCOMES = {
  invalid: "invalid",
  too_soon: "too_soon",
  not_signed_in: "not_signed_in",
  unavailable: "unavailable",
  forbidden: "forbidden",
  not_found: "not_found",
  conflict: "conflict",
  already_member: "failed",
  invitation_invalid: "failed",
  join_requests_closed: "failed",
  workspace_not_found: "failed",
  device_too_new: "failed",
  unclaimed_limit: "failed",
  project_limit: "failed",
  repository_limit: "failed",
  grant_limit: "failed",
  provider_connection_limit: "failed",
  rate_limited: "rate_limited",
  unknown: "unknown",
  failed: "failed",
  run_limit: "run_limit",
  run_daily_limit: "run_daily_limit",
} satisfies Record<RunCreationFailure, RunRequestRefusal | "unknown">;
Object.freeze(RUN_OUTCOMES);

const UNKNOWN: RunRequestResult = Object.freeze({ outcome: "unknown" });

/**
 * The most projects whose last run request outcome is kept; a request of
 * another project drops the oldest. A person asks in the open project, so
 * a few projects already cover switching back and forth.
 */
export const KEPT_RUN_REQUEST_OUTCOMES = 20;

function refused(
  reason: RunRequestRefusal,
  retryAfterMs: number | null = null,
): RunRequestResult {
  return Object.freeze({ outcome: "refused", reason, retryAfterMs });
}

/** The result of a failed creation, with its wait for the waits only. */
function failedResult(
  result: Extract<
    WorkspaceActionResult<unknown, RunCreationFailure>,
    { ok: false }
  >,
): RunRequestResult {
  const outcome = RUN_OUTCOMES[result.reason];
  if (outcome === "unknown") {
    return UNKNOWN;
  }
  return "retryAfterMs" in result
    ? refused(outcome, result.retryAfterMs)
    : refused(outcome);
}

export interface RunRequestOptions {
  readonly account: Pick<AccountService, "status" | "sendWorkspaceAction">;
  readonly agents: Pick<AgentActivityService, "state" | "requestReload">;
  readonly chat: Pick<ChatService, "state">;
  readonly workspaces: Pick<WorkspaceService, "ownMemberId">;
  readonly providerConnections: Pick<ProviderConnectionService, "state">;
  /**
   * Receives fixed messages, never an ID, a name, or a body. An error that
   * it throws is ignored.
   */
  readonly log?: (message: string) => void;
  /** The clock of a kept wait; `Date.now` by default. */
  readonly now?: () => number;
}

export interface RunRequestService {
  /**
   * Requests a run, after the checks above; sent at most once, and never
   * again on its own. Never rejects.
   */
  readonly request: (request: RunRequestView) => Promise<RunRequestResult>;
  /**
   * The outcome of the project's last request that passed the checks,
   * once: it is dropped as it is taken. While a request of that project is
   * on its way, it waits for its outcome. Null when nothing is kept, for
   * an ID that is not one, when another device or none is signed in, and
   * after close. A wait counts from the answer. Never rejects.
   */
  readonly takeOutcome: (
    projectId: string,
  ) => Promise<RunRequestOutcome | null>;
  /** Refuses every later request, for the quit, and drops what is kept. */
  readonly close: () => void;
}

/** A kept outcome: for the device that sent it, from the time of its answer. */
interface KeptOutcome {
  /** Compared with the signed-in device; it never leaves this module. */
  readonly deviceId: string;
  readonly outcome: RunRequestOutcome;
  readonly at: number;
}

/** What is kept of a result: never the run's ID. */
function outcomeOf(result: RunRequestResult): RunRequestOutcome {
  return result.outcome === "ok" ? Object.freeze({ outcome: "ok" }) : result;
}

export function createRunRequests(
  options: RunRequestOptions,
): RunRequestService {
  const { account, agents, chat, workspaces, providerConnections } = options;
  const now = options.now ?? Date.now;

  function log(message: string): void {
    try {
      options.log?.(message);
    } catch {
      // A failing log changes nothing.
    }
  }

  let closed = false;
  /** A request is waiting for its answer. */
  let requesting = false;
  /** The request on its way, and when its outcome is kept. */
  let onItsWay: {
    readonly projectId: ProjectId;
    readonly done: Promise<void>;
  } | null = null;
  /** The last outcome of each project, the oldest first. */
  const kept = new Map<ProjectId, KeptOutcome>();

  /** Keeps a project's outcome for `deviceId`; another device's go. */
  function keep(
    projectId: ProjectId,
    deviceId: string,
    result: RunRequestResult,
  ): void {
    for (const [key, entry] of kept) {
      if (entry.deviceId !== deviceId) {
        kept.delete(key);
      }
    }
    kept.delete(projectId);
    kept.set(projectId, { deviceId, outcome: outcomeOf(result), at: now() });
    for (const key of kept.keys()) {
      if (kept.size <= KEPT_RUN_REQUEST_OUTCOMES) {
        break;
      }
      kept.delete(key);
    }
  }

  async function takeOutcome(value: string): Promise<RunRequestOutcome | null> {
    const projectId = ProjectIdSchema.safeParse(value);
    if (!projectId.success) {
      return null;
    }
    if (onItsWay !== null && onItsWay.projectId === projectId.data) {
      await onItsWay.done;
    }
    const entry = kept.get(projectId.data);
    if (closed || entry === undefined) {
      return null;
    }
    kept.delete(projectId.data);
    // Signed out, or another device: nothing kept is this one's.
    if (entry.deviceId !== signedInDevice(account.status())) {
      kept.clear();
      return null;
    }
    const { outcome } = entry;
    if (outcome.outcome !== "refused" || outcome.retryAfterMs === null) {
      return outcome;
    }
    // The wait counts from the answer; one that passed is the shortest.
    const left = Math.ceil(outcome.retryAfterMs - (now() - entry.at));
    return Object.freeze({ ...outcome, retryAfterMs: Math.max(1, left) });
  }

  /** Asks the agent activity to read the runs again; never throws. */
  function reloadRuns(): void {
    try {
      agents.requestReload();
    } catch {
      log("The agent activity could not be read again.");
    }
  }

  async function request(value: RunRequestView): Promise<RunRequestResult> {
    const projectId = ProjectIdSchema.safeParse(value.projectId);
    const agentId = AgentIdSchema.safeParse(value.agentId);
    const connectionId = ProviderConnectionIdSchema.safeParse(
      value.providerConnectionId,
    );
    const messageId = MessageIdSchema.safeParse(value.inputMessageId);
    if (
      !projectId.success ||
      !agentId.success ||
      !connectionId.success ||
      !messageId.success
    ) {
      return refused("invalid");
    }
    if (closed) {
      return refused("unavailable");
    }

    // The agent: one of the open project's, the account's own, hosted on
    // this device, and enabled.
    const activity = agents.state();
    if (activity.projectId === null || activity.projectId !== projectId.data) {
      return refused("not_open");
    }
    const agent = activity.agents.find((item) => item.id === agentId.data);
    if (agent === undefined) {
      return refused("not_open");
    }
    const viewer = grantViewer(
      account.status(),
      activity,
      workspaces.ownMemberId,
    );
    if (!agentAccess(agent, viewer).ownedByMe) {
      return refused("not_owner");
    }
    if (agentHost(agent, viewer) !== "here") {
      return refused("not_hosted_here");
    }
    if (agent.disabledAt !== null) {
      return refused("disabled");
    }

    // The input: the person's own message of the open project's chat.
    const held = chat.state();
    const message =
      held.projectId === projectId.data &&
      held.workspaceId === activity.workspaceId
        ? held.messages.find(
            (item) =>
              item.id === messageId.data && item.projectId === projectId.data,
          )
        : undefined;
    if (message === undefined) {
      return refused("message_not_found");
    }
    if (
      message.author.kind !== "member" ||
      viewer.ownMemberId === null ||
      message.author.memberId !== viewer.ownMemberId
    ) {
      return refused("not_own_message");
    }

    // The provider connection: one of this device's, as its list holds it.
    const connections = providerConnections.state().connections;
    if (!connections.some((item) => item.id === connectionId.data)) {
      return refused("connection_not_here");
    }

    // One at a time: a second press while the first waits is refused, never
    // queued, because a queued one would still reach the server.
    if (requesting) {
      return refused("busy");
    }
    requesting = true;
    // `agentHost` found this device's ID above.
    const deviceId = viewer.deviceId ?? "";
    let finish = (): void => undefined;
    onItsWay = {
      projectId: projectId.data,
      done: new Promise<void>((resolve) => {
        finish = resolve;
      }),
    };
    let result: RunRequestResult;
    try {
      result = await send(projectId.data, {
        agentId: agentId.data,
        providerConnectionId: connectionId.data,
        inputMessageId: messageId.data,
      });
    } catch {
      // Not expected: the request may have reached the API.
      log("A run request could not be sent.");
      result = UNKNOWN;
    }
    // Kept before the answer goes back, so that a screen that takes it
    // once it has the answer finds it; only then may the next one go.
    keep(projectId.data, deviceId, result);
    requesting = false;
    onItsWay = null;
    finish();
    return result;
  }

  /** Sends the creation once; its result, never a rejection. */
  async function send(
    projectId: ProjectId,
    body: {
      readonly agentId: AgentId;
      readonly providerConnectionId: ProviderConnectionId;
      readonly inputMessageId: MessageId;
    },
  ): Promise<RunRequestResult> {
    let answer: WorkspaceActionResult<CreateRunResponse, RunCreationFailure>;
    try {
      answer = await account.sendWorkspaceAction(
        "createRun",
        { projectId },
        body,
      );
    } catch {
      log("A run request could not be sent.");
      // It may have reached the API; it is never sent again.
      reloadRuns();
      return UNKNOWN;
    }
    // Whatever the outcome of a request that may have reached the API: the
    // run may be stored although its answer was lost. Never after a refusal
    // of the account service, which sent nothing.
    if (workspaceActionMayHaveSent(answer)) {
      reloadRuns();
    }
    if (!answer.ok) {
      return failedResult(answer);
    }
    const { run } = answer.value;
    // A run of another project, agent, connection, or message, or with a
    // repository, is not this request's answer.
    if (
      run.projectId !== projectId ||
      run.agentId !== body.agentId ||
      run.providerConnectionId !== body.providerConnectionId ||
      run.inputMessageId !== body.inputMessageId ||
      run.repositoryId !== null
    ) {
      log("A run request was answered with another run.");
      return UNKNOWN;
    }
    return Object.freeze({ outcome: "ok", runId: run.id });
  }

  return Object.freeze({
    request,
    takeOutcome,
    close: () => {
      closed = true;
      kept.clear();
    },
  });
}
