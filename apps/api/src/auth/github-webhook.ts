import { type Database, recordGitHubRevocation } from "@mymandev/database";
import { AUTH_ROUTES } from "@mymandev/protocol";
import type { FastifyInstance } from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import * as z from "zod";
import { ApiError } from "../errors.ts";
import type { ConnectionRegistry } from "../gateway.ts";
import type { Secret } from "../secret.ts";
import type { AccessTokens } from "./tokens.ts";

export type GitHubWebhookOptions = Readonly<{
  /** The current secret, then the previous one while a rotation is in progress. */
  secrets: readonly Secret[];
  database: Database;
  connections: ConnectionRegistry;
  /** The access tokens of the device routes; null when they are not registered. */
  tokens: AccessTokens | null;
  now: () => number;
}>;

/** Far above a `github_app_authorization` delivery, which is a few kilobytes. */
const WEBHOOK_BODY_LIMIT = 1024 * 1024;

const SIGNATURE_PREFIX = "sha256=";
const SIGNATURE_PATTERN = /^sha256=[0-9a-f]{64}$/u;

/** GitHub sends a GUID; the check only keeps the stored value short and plain. */
const DELIVERY_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/u;

/** Event names are logged only in this form; anything else is logged as `other`. */
const EVENT_NAME_PATTERN = /^[a-z_]{1,64}$/u;

const REVOCATION_EVENT = "github_app_authorization";

/** GitHub's numeric account ID, as in `GET /user` of the sign-in. */
const SenderSchema = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

/**
 * Whether the header is `sha256=` and the lowercase hexadecimal HMAC-SHA256
 * of the raw body under one of the secrets, compared in constant time.
 */
function signatureValid(
  header: string | string[] | undefined,
  body: Buffer,
  secrets: readonly Secret[],
): boolean {
  if (typeof header !== "string" || !SIGNATURE_PATTERN.test(header)) {
    return false;
  }
  const received = Buffer.from(header.slice(SIGNATURE_PREFIX.length), "hex");
  return secrets.some((secret) => {
    const expected = createHmac("sha256", secret.reveal())
      .update(body)
      .digest();
    return (
      received.length === expected.length && timingSafeEqual(received, expected)
    );
  });
}

/** The body as a JSON object; null when it is not one. */
function jsonObject(body: Buffer): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(body.toString("utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * `POST /auth/github/webhook` (ADR 0014, "Revocation, sign-out, and
 * recovery"; P-54). Registered only with the webhook secret and the
 * database; otherwise the route answers the generic 404. The signature is
 * checked on the raw body before anything is parsed. Only
 * `github_app_authorization` with the action `revoked` changes anything;
 * every other event is acknowledged and ignored, because an installation
 * grants nothing. No body, signature, or delivery ID is logged.
 */
export async function registerGitHubWebhook(
  app: FastifyInstance,
  options: GitHubWebhookOptions,
): Promise<void> {
  const { secrets, database, connections, tokens } = options;

  await app.register(async (scope) => {
    // The signature covers the exact bytes, so the body stays a buffer.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser(
      "application/json",
      { parseAs: "buffer", bodyLimit: WEBHOOK_BODY_LIMIT },
      (_request, body, done) => {
        done(null, body);
      },
    );

    // No rate limit: GitHub delivers from shared addresses, and a request
    // without a valid signature costs one HMAC per configured secret.
    scope.post(AUTH_ROUTES.githubWebhook.path, async (request, reply) => {
      const body = Buffer.isBuffer(request.body)
        ? request.body
        : Buffer.alloc(0);
      if (
        !signatureValid(request.headers["x-hub-signature-256"], body, secrets)
      ) {
        throw new ApiError("unauthorized");
      }
      const payload = jsonObject(body);
      if (payload === null) {
        throw new ApiError("bad_request");
      }
      const header = request.headers["x-github-event"];
      const event =
        typeof header === "string" && EVENT_NAME_PATTERN.test(header)
          ? header
          : "other";
      if (event !== REVOCATION_EVENT || payload.action !== "revoked") {
        request.log.info(
          { githubEvent: event, outcome: "ignored" },
          "GitHub webhook",
        );
        return reply.code(204).send();
      }

      const deliveryId = request.headers["x-github-delivery"];
      const sender = SenderSchema.safeParse(payload.sender);
      if (
        typeof deliveryId !== "string" ||
        !DELIVERY_ID_PATTERN.test(deliveryId) ||
        !sender.success
      ) {
        throw new ApiError("bad_request");
      }
      const result = await recordGitHubRevocation(database, {
        subject: String(sender.data.id),
        deliveryId,
        now: new Date(options.now()),
      });
      if (result.changed && result.userId !== null) {
        // Every later request reads the account's sign_in_required_at; this
        // ends the open sockets and keeps old tokens out of memory.
        connections.closeUser(result.userId, "sign_in_required", request.log);
        for (const deviceId of result.deviceIds) {
          tokens?.dropDevice(deviceId);
        }
      }
      request.log.info(
        {
          githubEvent: event,
          outcome: !result.changed
            ? "already_processed"
            : result.userId === null
              ? "no_account"
              : "revoked",
        },
        "GitHub webhook",
      );
      return reply.code(204).send();
    });
  });
}
