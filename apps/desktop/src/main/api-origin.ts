// The API origin of the desktop (ADR 0014, "Configuration"). A production
// build fixes the API base URL; a development build reads it from the
// environment. The origin is the audience of every device signature, so it
// must equal the API's `API_PUBLIC_ORIGIN` exactly.
import { isDeviceAuthAudience } from "@mymandev/protocol";

/**
 * The API origin of production builds. Hosting (#96) has not chosen it yet,
 * so it is null, and a production build answers a sign-in with
 * `api_origin_unset`.
 */
export const PRODUCTION_API_ORIGIN: string | null = null;

/** The environment variable that a development build reads the origin from. */
export const API_ORIGIN_VARIABLE = "MYMANDEV_API_ORIGIN";

/**
 * The http origins that the API accepts as `API_PUBLIC_ORIGIN`, in
 * development and test only: a loopback host. Every other origin must use
 * https. The same pattern as the API's configuration.
 */
const LOOPBACK_HTTP_ORIGIN =
  /^http:\/\/(?:127[.]0[.]0[.]1|localhost)(?::[0-9]+)?$/u;

/**
 * Whether a value can be the API origin: an audience that the protocol
 * accepts, with https, or with http on `127.0.0.1` or `localhost` only.
 */
export function isApiOrigin(value: unknown): value is string {
  return (
    typeof value === "string" &&
    isDeviceAuthAudience(value) &&
    (value.startsWith("https://") || LOOPBACK_HTTP_ORIGIN.test(value))
  );
}

/**
 * The API origin, or why there is none: `api_origin_unset` (a production
 * build without a fixed origin, or a development build without the
 * variable) or `api_origin_invalid` (a value that `isApiOrigin` refuses, or
 * a production origin without https).
 */
export type ApiOrigin =
  | { readonly ok: true; readonly origin: string }
  | {
      readonly ok: false;
      readonly reason: "api_origin_unset" | "api_origin_invalid";
    };

export interface ApiOriginInput {
  /** `app.isPackaged`: true in an installed application. */
  readonly isPackaged: boolean;
  /** `process.env`; read only in a development build. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Defaults to `PRODUCTION_API_ORIGIN`; tests pass another one. */
  readonly productionOrigin?: string | null;
}

/**
 * The API origin of this build. A packaged build uses the fixed production
 * origin, which must use https, and never reads the environment; a
 * development build reads `MYMANDEV_API_ORIGIN`. The result never contains
 * a refused value.
 */
export function resolveApiOrigin(input: ApiOriginInput): ApiOrigin {
  const value = input.isPackaged
    ? input.productionOrigin === undefined
      ? PRODUCTION_API_ORIGIN
      : input.productionOrigin
    : input.env[API_ORIGIN_VARIABLE];
  if (value === null || value === undefined || value === "") {
    return Object.freeze({ ok: false, reason: "api_origin_unset" });
  }
  // The loopback http origins are for development and tests only.
  if (
    !isApiOrigin(value) ||
    (input.isPackaged && !value.startsWith("https://"))
  ) {
    return Object.freeze({ ok: false, reason: "api_origin_invalid" });
  }
  return Object.freeze({ ok: true, origin: value });
}
