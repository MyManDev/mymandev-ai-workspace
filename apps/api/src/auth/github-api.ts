import * as z from "zod";
import type { Secret } from "../secret.ts";

/** The GitHub account that a sign-in identified. The ID never changes; the login is display data. */
export type GitHubIdentity = Readonly<{
  /** GitHub's numeric user ID as decimal text. */
  githubId: string;
  login: string;
  /** null when the account has no name. */
  name: string | null;
  /** When the GitHub account was created. */
  accountCreatedAt: string;
}>;

export type GitHubExchangeResult =
  | Readonly<{ ok: true; accessToken: string }>
  | Readonly<{
      ok: false;
      /** `rejected`: GitHub refused the code; `rate_limited`: GitHub's limit; `unavailable`: no usable answer. */
      reason: "rejected" | "rate_limited" | "unavailable";
      retryAfterSeconds?: number;
    }>;

/** The three GitHub calls of a sign-in (ADR 0014, step 3). Tests replace it with a stub. */
export interface GitHubApi {
  /** The URL that starts GitHub's authorization, with the API's own state and PKCE challenge. */
  authorizeUrl(
    input: Readonly<{
      redirectUri: string;
      state: string;
      codeChallenge: string;
      login?: string;
      prompt?: "select_account";
    }>,
  ): string;
  /** Exchanges the code once; a failed exchange consumes the code too (#67). */
  exchangeCode(
    input: Readonly<{
      code: string;
      codeVerifier: string;
      redirectUri: string;
    }>,
  ): Promise<GitHubExchangeResult>;
  /** `GET /user`; null when the answer is not a usable account. */
  getUser(accessToken: string): Promise<GitHubIdentity | null>;
  /** `DELETE /applications/{client_id}/token`; true when GitHub deleted it. */
  deleteToken(accessToken: string): Promise<boolean>;
}

const GITHUB_API_VERSION = "2022-11-28";

const TokenResponseSchema = z.union([
  z.object({ error: z.string() }),
  z.object({ access_token: z.string().min(1).max(1024) }),
]);

const UserResponseSchema = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  login: z.string().max(100),
  name: z.string().max(1000).nullable(),
  created_at: z.iso.datetime(),
});

/** Seconds from `Retry-After`, or from `x-ratelimit-reset` (an epoch second), capped at one hour. */
function retryAfterOf(response: Response, nowMs: number): number {
  const retryAfter = Number(response.headers.get("retry-after"));
  if (Number.isInteger(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter, 3600);
  }
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  if (Number.isInteger(reset) && reset * 1000 > nowMs) {
    return Math.min(Math.ceil((reset * 1000 - nowMs) / 1000), 3600);
  }
  return 60;
}

function isRateLimited(response: Response): boolean {
  return (
    response.status === 429 ||
    (response.status === 403 &&
      response.headers.get("x-ratelimit-remaining") === "0")
  );
}

export type GitHubApiOptions = Readonly<{
  clientId: string;
  clientSecret: Secret;
  /** Defaults to the global fetch. */
  fetch?: typeof fetch;
  webBase?: string;
  apiBase?: string;
  timeoutMs?: number;
  now?: () => number;
}>;

/**
 * The GitHub calls with the global fetch. Parameters travel in request
 * bodies, never in a URL, and no response body is ever logged or returned.
 */
export function createGitHubApi(options: GitHubApiOptions): GitHubApi {
  const send = options.fetch ?? fetch;
  const webBase = options.webBase ?? "https://github.com";
  const apiBase = options.apiBase ?? "https://api.github.com";
  const timeoutMs = options.timeoutMs ?? 10_000;
  const now = options.now ?? Date.now;
  const apiHeaders = {
    accept: "application/vnd.github+json",
    "x-github-api-version": GITHUB_API_VERSION,
  };

  return {
    authorizeUrl(input) {
      const query = new URLSearchParams({
        client_id: options.clientId,
        redirect_uri: input.redirectUri,
        state: input.state,
        code_challenge: input.codeChallenge,
        code_challenge_method: "S256",
      });
      if (input.login !== undefined) {
        query.set("login", input.login);
      }
      if (input.prompt !== undefined) {
        query.set("prompt", input.prompt);
      }
      return `${webBase}/login/oauth/authorize?${query.toString()}`;
    },

    async exchangeCode(input) {
      let response: Response;
      try {
        response = await send(`${webBase}/login/oauth/access_token`, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            client_id: options.clientId,
            client_secret: options.clientSecret.reveal(),
            code: input.code,
            redirect_uri: input.redirectUri,
            code_verifier: input.codeVerifier,
          }).toString(),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        return { ok: false, reason: "unavailable" };
      }
      if (isRateLimited(response)) {
        return {
          ok: false,
          reason: "rate_limited",
          retryAfterSeconds: retryAfterOf(response, now()),
        };
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return { ok: false, reason: "unavailable" };
      }
      const parsed = TokenResponseSchema.safeParse(body);
      if (!parsed.success) {
        return { ok: false, reason: "unavailable" };
      }
      // GitHub can answer an exchange error with HTTP 200 (#67).
      if ("error" in parsed.data) {
        return { ok: false, reason: "rejected" };
      }
      if (!response.ok) {
        return { ok: false, reason: "unavailable" };
      }
      return { ok: true, accessToken: parsed.data.access_token };
    },

    async getUser(accessToken) {
      try {
        const response = await send(`${apiBase}/user`, {
          headers: { ...apiHeaders, authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
          return null;
        }
        const parsed = UserResponseSchema.safeParse(await response.json());
        if (!parsed.success) {
          return null;
        }
        return Object.freeze({
          githubId: String(parsed.data.id),
          login: parsed.data.login,
          name: parsed.data.name,
          accountCreatedAt: parsed.data.created_at,
        });
      } catch {
        return null;
      }
    },

    async deleteToken(accessToken) {
      const basic = Buffer.from(
        `${options.clientId}:${options.clientSecret.reveal()}`,
      ).toString("base64");
      try {
        const response = await send(
          `${apiBase}/applications/${encodeURIComponent(options.clientId)}/token`,
          {
            method: "DELETE",
            headers: {
              ...apiHeaders,
              authorization: `Basic ${basic}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ access_token: accessToken }),
            signal: AbortSignal.timeout(timeoutMs),
          },
        );
        return response.status === 204;
      } catch {
        return false;
      }
    },
  };
}
