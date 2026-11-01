import {
  acceptInvitation,
  type Database,
  type InvitationCodeRefusal,
  previewInvitation,
} from "@mymandev/database";
import {
  type AcceptInvitationRequest,
  AcceptInvitationRequestSchema,
  type AcceptInvitationResponse,
  MEMBERSHIP_ROUTES,
  type PreviewInvitationRequest,
  PreviewInvitationRequestSchema,
  type PreviewInvitationResponse,
  type UserId,
} from "@mymandev/protocol";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { authOf, lockActor } from "../auth/authenticate.ts";
import { ApiError } from "../errors.ts";
import {
  sendWorkspaceEvent,
  serverEventHeader,
  type WorkspaceEventHandler,
} from "./events.ts";
import { invitationCodeHash } from "./invitation-routes.ts";

/** ADR 0014, "Limits": failed invitation previews and accepts per account. */
const FAILURES_PER_ACCOUNT = { max: 10, windowMs: 15 * 60_000 };
const SWEEP_INTERVAL_MS = 60_000;

/** One attempt that counts as a failure until it is released. */
type Attempt = { readonly at: number };

/**
 * The failed invitation codes of each account within a sliding window, in
 * API memory like the other limits of one instance. An attempt counts as a
 * failure from its start until `release` takes it back, so that concurrent
 * attempts of one account count too, and at most `max` attempts within the
 * window can fail.
 */
export class InvitationFailures {
  readonly #attempts = new Map<string, Attempt[]>();
  readonly #max: number;
  readonly #windowMs: number;
  readonly #now: () => number;

  constructor(max: number, windowMs: number, now: () => number) {
    this.#max = max;
    this.#windowMs = windowMs;
    this.#now = now;
  }

  /**
   * Starts an attempt of `key`. With `max` failures and open attempts within
   * the window, it returns the seconds until the oldest of them leaves the
   * window instead, and counts nothing.
   */
  begin(
    key: string,
  ): Readonly<{ attempt: Attempt }> | Readonly<{ wait: number }> {
    const now = this.#now();
    const recent = this.#recent(key, now);
    const oldest = recent[0];
    if (recent.length >= this.#max && oldest !== undefined) {
      return {
        wait: Math.max(1, Math.ceil((oldest.at + this.#windowMs - now) / 1000)),
      };
    }
    const attempt = { at: now };
    recent.push(attempt);
    this.#attempts.set(key, recent);
    return { attempt };
  }

  /** Takes back an attempt that did not fail. */
  release(key: string, attempt: Attempt): void {
    const recent = this.#attempts.get(key);
    const index = recent?.indexOf(attempt) ?? -1;
    if (recent === undefined || index < 0) {
      return;
    }
    recent.splice(index, 1);
    if (recent.length === 0) {
      this.#attempts.delete(key);
    }
  }

  sweep(): void {
    const now = this.#now();
    for (const key of [...this.#attempts.keys()]) {
      if (this.#recent(key, now).length === 0) {
        this.#attempts.delete(key);
      }
    }
  }

  /** The attempts of `key` within the window before `now`, the oldest first. */
  #recent(key: string, now: number): Attempt[] {
    const recent = (this.#attempts.get(key) ?? []).filter(
      (attempt) => now - attempt.at < this.#windowMs,
    );
    this.#attempts.set(key, recent);
    return recent;
  }
}

export type InvitationCodeRouteOptions = Readonly<{
  database: Database;
  now: () => number;
  /** Receives `workspace.member.claimed` after an acceptance committed. */
  onWorkspaceEvent: WorkspaceEventHandler;
}>;

/** Every answer of both routes, also an error, carries `Cache-Control: no-store`. */
async function noStore(
  _request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown,
): Promise<unknown> {
  reply.header("cache-control", "no-store");
  return payload;
}

/**
 * Previewing and accepting an invitation code (ADR 0014, "Invitations",
 * "Limits", and "Threats"). Registered on a scope that needs an access
 * token, outside `/workspaces/:workspaceId`: the code travels only in the
 * body. Every answer carries `Cache-Control: no-store`. An account that is
 * already an active member of the code's workspace gets `already_member`,
 * and every other refusal answers the same `invitation_invalid`; the log
 * names the reason and the invitation's ID, never the code. An account may
 * fail 10 times within 15 minutes, previews and accepts together; then both
 * routes answer `429` with `rate_limited` and `Retry-After` until the oldest
 * counted attempt is 15 minutes old.
 */
export function registerInvitationCodeRoutes(
  scope: FastifyInstance,
  options: InvitationCodeRouteOptions,
): void {
  const { database } = options;
  const failures = new InvitationFailures(
    FAILURES_PER_ACCOUNT.max,
    FAILURES_PER_ACCOUNT.windowMs,
    options.now,
  );
  const sweeper = setInterval(() => {
    failures.sweep();
  }, SWEEP_INTERVAL_MS);
  sweeper.unref();
  scope.addHook("onClose", async () => {
    clearInterval(sweeper);
  });

  /**
   * Runs `attempt` under the account's failure limit. Only an
   * `invitation_invalid` answer counts as a failure.
   */
  async function limited<T>(
    userId: UserId,
    attempt: () => Promise<T>,
  ): Promise<T> {
    const started = failures.begin(userId);
    if ("wait" in started) {
      throw new ApiError("rate_limited", { retryAfterSeconds: started.wait });
    }
    try {
      const result = await attempt();
      failures.release(userId, started.attempt);
      return result;
    } catch (error) {
      if (!(error instanceof ApiError && error.code === "invitation_invalid")) {
        failures.release(userId, started.attempt);
      }
      throw error;
    }
  }

  /** The answer to a refused code; the log names an invalid code's reason. */
  function refused(
    request: FastifyRequest,
    refusal: InvitationCodeRefusal,
  ): ApiError {
    if (refusal.refusal === "already_member") {
      return new ApiError("already_member");
    }
    request.log.info(
      { invitationId: refusal.invitationId, reason: refusal.reason },
      "invitation code refused",
    );
    return new ApiError("invitation_invalid");
  }

  scope.post(
    MEMBERSHIP_ROUTES.previewInvitation.path,
    { schema: { body: PreviewInvitationRequestSchema }, onSend: noStore },
    async (request): Promise<PreviewInvitationResponse> => {
      const auth = authOf(request);
      const { code } = request.body as PreviewInvitationRequest;
      return limited(auth.userId, async () => {
        const result = await previewInvitation(database, {
          tokenHash: invitationCodeHash(code),
          userId: auth.userId,
          now: new Date(options.now()),
        });
        if (!result.previewed) {
          throw refused(request, result);
        }
        return result.preview;
      });
    },
  );

  scope.post(
    MEMBERSHIP_ROUTES.acceptInvitation.path,
    { schema: { body: AcceptInvitationRequestSchema }, onSend: noStore },
    async (request): Promise<AcceptInvitationResponse> => {
      const auth = authOf(request);
      const { code } = request.body as AcceptInvitationRequest;
      const now = new Date(options.now());
      const membership = await limited(auth.userId, () =>
        database.transaction(async (tx) => {
          await lockActor(tx, auth, now.getTime());
          const result = await acceptInvitation(tx, {
            tokenHash: invitationCodeHash(code),
            userId: auth.userId,
            deviceId: auth.deviceId,
            now,
          });
          if (!result.accepted) {
            throw refused(request, result);
          }
          return result.membership;
        }),
      );
      sendWorkspaceEvent(request, options.onWorkspaceEvent, {
        ...serverEventHeader(membership.workspace.id, now),
        type: "workspace.member.claimed",
        payload: { member: membership.member },
      });
      return membership;
    },
  );
}
