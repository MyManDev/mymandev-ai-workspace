// The provider connections of a host device (#295; Project Manager
// decisions of 2026-11-20, whose defaults the Project Manager accepted on
// 2026-11-23; ADR 0015, P-79 and P-82): registering a connection of the
// calling device to an AI provider, listing the device's connections, and
// removing one. Every route needs an access token.
//
// A connection is metadata, never a credential: its server-generated ID,
// its provider kind, and a label that a person chose. No provider account
// identifier and nothing derived from the credential reaches the server; the
// credential stays on the device (#33). Only the host device registers,
// lists, and removes its own connections: no path names a device, so a
// device can only ever name its own, as `GET /grant-records` does. A
// connection is device data (#110): no workspace event reports it, and no
// other device or account reads it. The README lists the contract under
// "Provider connections".

import * as z from "zod";
import type { ApiRoute } from "./auth-api.ts";
import {
  displayText,
  ProviderKindSchema,
  UtcTimestampSchema,
} from "./entities.ts";
import { ProviderConnectionIdSchema } from "./ids.ts";
import type { ApiErrorCode } from "./model.ts";
import { LIMITS, MAX_ANSWER_LIST_ITEMS } from "./model.ts";

function route(method: ApiRoute["method"], path: string): ApiRoute {
  return Object.freeze({ method, path });
}

/**
 * The provider connection routes. Every path parameter is an ID, and no
 * route takes a query. The paths start with the connections themselves and
 * name no device: the calling device is the host device of every connection
 * that a route reads or changes, as the calling device is the device of
 * `GET /grant-records`.
 */
export const PROVIDER_CONNECTION_ROUTES = Object.freeze({
  /**
   * The calling device's connections that are not removed, the oldest
   * first. Any signed-in device; a device without one gets an empty list.
   */
  listProviderConnections: route("GET", "/provider-connections"),
  /**
   * Registers a connection of the calling device, which becomes its host
   * device, and answers `200` with it. A device that holds
   * `PROVIDER_CONNECTION_COUNT_LIMITS.activePerDevice` connections that are
   * not removed answers `provider_connection_limit`, and an account at its
   * limit of registrations within 24 hours answers `rate_limited`.
   */
  registerProviderConnection: route("POST", "/provider-connections"),
  /**
   * Removes a connection of the calling device and answers `204` without a
   * body. It revokes the connection's active `provider.use` grants in the
   * same transaction (ADR 0015, P-77) and cancels no run.
   */
  removeProviderConnection: route(
    "POST",
    "/provider-connections/:providerConnectionId/remove",
  ),
});
export type ProviderConnectionRouteName =
  keyof typeof PROVIDER_CONNECTION_ROUTES;

/** The codes that every provider connection route can answer, as every membership route can. */
const COMMON_ERRORS = Object.freeze([
  "bad_request",
  "unauthorized",
  "rate_limited",
  "internal_error",
] as const satisfies readonly ApiErrorCode[]);

function errors(...codes: readonly ApiErrorCode[]): readonly ApiErrorCode[] {
  return Object.freeze([...COMMON_ERRORS, ...codes]);
}

/**
 * Every error code that each provider connection route can answer, with
 * its status from `API_ERROR_STATUS`. Every route can answer `bad_request`,
 * `unauthorized`, `rate_limited` (with `Retry-After`), and
 * `internal_error`. Beyond those:
 *
 * - a registration: `provider_connection_limit` for a device that holds
 *   `PROVIDER_CONNECTION_COUNT_LIMITS.activePerDevice` connections that are
 *   not removed, without `Retry-After`; then `rate_limited` with
 *   `Retry-After` for an account at its limit of registrations within 24
 *   hours, whose places come free with time;
 * - a removal: `not_found` for a connection ID that the calling device does
 *   not host, also one of another device of the same account; `conflict`
 *   for a connection that is already removed.
 */
export const PROVIDER_CONNECTION_ROUTE_ERRORS = Object.freeze({
  listProviderConnections: errors(),
  registerProviderConnection: errors("provider_connection_limit"),
  removeProviderConnection: errors("not_found", "conflict"),
} satisfies Record<ProviderConnectionRouteName, readonly ApiErrorCode[]>);

/**
 * How many provider connections a device and an account may have (#295;
 * Project Manager decision of 2026-11-20):
 *
 * - `activePerDevice`: at most 10 connections of one device that are not
 *   removed. A registration over it answers `provider_connection_limit`
 *   without `Retry-After`; only removing a connection frees a place.
 * - `perDay`: at most 20 registrations of one account within 24 hours, on
 *   all its devices together, removed connections included. A registration
 *   over it answers `rate_limited` with `Retry-After`, by the rule of
 *   2026-11-14 on #75: a limit whose places come free with time answers
 *   `rate_limited`.
 *
 * The API applies these values. Both lie far below
 * `MAX_ANSWER_LIST_ITEMS`, so raising one never breaks an older desktop.
 * They may be tuned with use (ADR 0014, P-64).
 */
export const PROVIDER_CONNECTION_COUNT_LIMITS = Object.freeze({
  activePerDevice: 10,
  perDay: 20,
} as const);

/**
 * A provider connection as its host device reads it: its ID, its provider
 * kind, its label, and when it was registered. It names no device, because
 * only its host device reads it, and no provider account, because none
 * reaches the server.
 */
export const ProviderConnectionSchema = z.object({
  id: ProviderConnectionIdSchema,
  kind: ProviderKindSchema,
  label: displayText(LIMITS.providerConnectionLabel),
  createdAt: UtcTimestampSchema,
});
export type ProviderConnection = z.infer<typeof ProviderConnectionSchema>;

/**
 * `POST /provider-connections`. The body holds the provider kind and the
 * label only; every other field is stripped, so an API key, a token, a
 * provider account, or a host device sent beside them never reaches the
 * database (#33). The kind is one of `PROVIDER_KINDS`. The label is 1 to
 * `LIMITS.providerConnectionLabel` (64) characters of single-line text by
 * the text rule of ADR 0005: stored as sent, not normalized, not trimmed,
 * and not unique, because one device may hold several connections of one
 * provider (decision of 2026-11-20).
 */
export const RegisterProviderConnectionRequestSchema = z.object({
  kind: ProviderKindSchema,
  label: displayText(LIMITS.providerConnectionLabel),
});
export type RegisterProviderConnectionRequest = z.infer<
  typeof RegisterProviderConnectionRequestSchema
>;

/**
 * The answer of `POST /provider-connections`: the new connection as the
 * list shows it. The schema cannot see the request, so the device checks
 * that the connection has the kind and the label that it sent.
 */
export const RegisterProviderConnectionResponseSchema = z.object({
  providerConnection: ProviderConnectionSchema,
});
export type RegisterProviderConnectionResponse = z.infer<
  typeof RegisterProviderConnectionResponseSchema
>;

/** The answer of `GET /provider-connections`: each connection once. */
export const ProviderConnectionListResponseSchema = z
  .object({
    providerConnections: z
      .array(ProviderConnectionSchema)
      .max(MAX_ANSWER_LIST_ITEMS),
  })
  .superRefine((list, ctx) => {
    const seen = new Set<string>();
    list.providerConnections.forEach((connection, index) => {
      if (seen.has(connection.id)) {
        ctx.addIssue({
          code: "custom",
          message: "A provider connection is listed once",
          path: ["providerConnections", index, "id"],
        });
      }
      seen.add(connection.id);
    });
  });
export type ProviderConnectionListResponse = z.infer<
  typeof ProviderConnectionListResponseSchema
>;
