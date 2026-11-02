// The values of one sign-in attempt and the authorize URL (ADR 0014,
// "Sign-in", step 1). The main process creates a PKCE verifier and a state,
// derives the S256 code challenge and the pairing code, and opens
// `<API base>/auth/github/authorize` in the system browser. None of the values
// in the URL is secret; the verifier never leaves the main process until
// `POST /auth/sign-in`, and it is not enumerable, so logging an attempt does
// not show it.
import { createHash, randomBytes } from "node:crypto";
import {
  AUTH_ROUTES,
  Base64Url32BytesSchema,
  GitHubAuthorizeQuerySchema,
  type GitHubAuthorizeQuery,
  isDeviceAuthAudience,
  pairingCode,
} from "@mymandev/protocol";

/** One sign-in attempt of the desktop. */
export interface SignInAttempt {
  /** 32 random bytes as 43 base64url characters; the listener expects it back. */
  readonly state: string;
  /** The S256 challenge of the verifier, as 43 base64url characters. */
  readonly codeChallenge: string;
  /** Six digits that the desktop and the API's confirmation page both show. */
  readonly pairingCode: string;
  /**
   * The PKCE verifier: 32 random bytes as 43 base64url characters. Sent only
   * in the body of `POST /auth/sign-in`. Not enumerable, so `console.log` and
   * `JSON.stringify` of the attempt leave it out.
   */
  readonly codeVerifier: string;
}

/** Throws a `TypeError` that names the field, never the value. */
function checked32Bytes(field: string, value: unknown): string {
  const parsed = Base64Url32BytesSchema.safeParse(value);
  if (!parsed.success) {
    throw new TypeError(`Invalid ${field}`);
  }
  return parsed.data;
}

/** 32 random bytes as 43 base64url characters without padding (ADR 0004). */
function random32Bytes(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * The PKCE S256 code challenge of a verifier (RFC 7636, section 4.2): the
 * SHA-256 hash of its ASCII bytes as base64url without padding. Only S256 is
 * used (ADR 0014). Throws a `TypeError` unless the verifier is 43 canonical
 * base64url characters.
 */
export function codeChallengeS256(codeVerifier: string): string {
  const verifier = checked32Bytes("code verifier", codeVerifier);
  return checked32Bytes(
    "code challenge",
    createHash("sha256").update(verifier, "ascii").digest("base64url"),
  );
}

/**
 * Creates the values of a new sign-in attempt: a verifier and a state of 32
 * random bytes each, the S256 challenge, and the pairing code of
 * `@mymandev/protocol`.
 */
export function createSignInAttempt(): SignInAttempt {
  const codeVerifier = checked32Bytes("code verifier", random32Bytes());
  const state = checked32Bytes("state", random32Bytes());
  const codeChallenge = codeChallengeS256(codeVerifier);
  const attempt = {
    state,
    codeChallenge,
    pairingCode: pairingCode(codeChallenge),
  };
  Object.defineProperty(attempt, "codeVerifier", {
    value: codeVerifier,
    enumerable: false,
  });
  return Object.freeze(attempt) as SignInAttempt;
}

/**
 * Which sign-in this is, which decides the optional parameters of the
 * authorize URL (ADR 0014, step 1):
 *
 * - `first`: the installation has no account yet; adds `prompt=select_account`.
 * - `repeated`: the device signs in again; adds `login` with the GitHub login
 *   of the device's account.
 * - `after_account_mismatch`: the previous sign-in answered
 *   `device_account_mismatch`; adds `prompt=select_account`, and `login` when
 *   the person chose to sign in as the account that the installation holds.
 */
export type AuthorizeSignInKind =
  | { readonly kind: "first" }
  | { readonly kind: "repeated"; readonly login: string }
  | { readonly kind: "after_account_mismatch"; readonly login?: string };

export interface AuthorizeUrlInput {
  /**
   * The origin of the API base URL, `scheme://host[:port]` as a URL parser
   * writes it. It is the audience of every signature and must equal the
   * API's `API_PUBLIC_ORIGIN` exactly: https, or http only on `127.0.0.1` or
   * `localhost`, as the API's configuration allows in development and test.
   */
  readonly apiOrigin: string;
  readonly codeChallenge: string;
  /** The listener's `http://127.0.0.1:<port>/callback`. */
  readonly redirectUri: string;
  readonly state: string;
  readonly signIn: AuthorizeSignInKind;
}

/**
 * The http origins that the API accepts as `API_PUBLIC_ORIGIN`, in
 * development and test only: a loopback host. Every other origin must use
 * https. The same pattern as the API's configuration.
 */
const LOOPBACK_HTTP_ORIGIN =
  /^http:\/\/(?:127[.]0[.]0[.]1|localhost)(?::[0-9]+)?$/u;

/** The order of the query parameters in the URL; every key of the schema. */
const AUTHORIZE_PARAMETER_ORDER: readonly (keyof GitHubAuthorizeQuery)[] =
  Object.freeze([
    "code_challenge",
    "code_challenge_method",
    "redirect_uri",
    "state",
    "login",
    "prompt",
  ]);

/**
 * Builds `<API origin>/auth/github/authorize` with `code_challenge`,
 * `code_challenge_method=S256`, `redirect_uri`, `state`, and the parameters
 * of the sign-in kind. Every value is checked with the protocol's schemas
 * first, so the API never sees a query that it would refuse. Throws a
 * `TypeError` that names the field, never its value.
 */
export function authorizeUrl(input: AuthorizeUrlInput): string {
  if (
    !isDeviceAuthAudience(input.apiOrigin) ||
    !(
      input.apiOrigin.startsWith("https://") ||
      LOOPBACK_HTTP_ORIGIN.test(input.apiOrigin)
    )
  ) {
    throw new TypeError("Invalid API origin");
  }
  const query: Record<string, string> = {
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
    redirect_uri: input.redirectUri,
    state: input.state,
  };
  const { signIn } = input;
  switch (signIn.kind) {
    case "first":
      query.prompt = "select_account";
      break;
    case "repeated":
      query.login = signIn.login;
      break;
    case "after_account_mismatch":
      if (signIn.login !== undefined) {
        query.login = signIn.login;
      }
      query.prompt = "select_account";
      break;
    default:
      throw new TypeError("Invalid sign-in kind");
  }
  const parsed = GitHubAuthorizeQuerySchema.safeParse(query);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path.map(String).join(".") || "query";
    throw new TypeError(`Invalid authorize parameter ${field}`);
  }
  const url = new URL(AUTH_ROUTES.githubAuthorize.path, input.apiOrigin);
  if (url.origin !== input.apiOrigin) {
    throw new TypeError("Invalid API origin");
  }
  for (const name of AUTHORIZE_PARAMETER_ORDER) {
    const value = parsed.data[name];
    if (value !== undefined) {
      url.searchParams.set(name, value);
    }
  }
  return url.href;
}
