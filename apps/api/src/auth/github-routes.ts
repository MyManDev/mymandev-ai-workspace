import {
  AUTH_ROUTES,
  Base64Url32BytesSchema,
  GitHubAuthorizeQuerySchema,
  GitHubLoginSchema,
  pairingCode,
} from "@mymandev/protocol";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import * as z from "zod";
import {
  type SignInAttempt,
  type SignInAttempts,
  type SignInCodes,
  s256,
} from "./attempts.ts";
import type { GitHubApi } from "./github-api.ts";
import {
  confirmationPage,
  errorPage,
  listenerPage,
  originOf,
  sendPage,
} from "./pages.ts";

export type GitHubSignInOptions = Readonly<{
  publicOrigin: string;
  github: GitHubApi;
  attempts: SignInAttempts;
  codes: SignInCodes;
  now: () => number;
}>;

/** The attempt cookie lives as long as the attempt (ADR 0014, "Lifetimes"). */
const ATTEMPT_COOKIE_SECONDS = 600;

/** Per remote address, while the API is reached directly (P-63). */
const ROUTE_LIMIT = { max: 30, timeWindow: 10 * 60_000 };

/** GitHub allows 2,000 token requests per hour per app; warn before that. */
const EXCHANGE_WARNING_PER_HOUR = 1_500;

const CallbackQuerySchema = z.object({
  state: z.string().max(128),
  code: z.string().min(1).max(256).optional(),
  error: z.string().max(128).optional(),
});

const ConfirmFormSchema = z.object({
  state: Base64Url32BytesSchema,
  decision: z.enum(["continue", "cancel"]),
});

/**
 * The attempt cookie (ADR 0014, step 2; #99): the `__Host-` form with an
 * https origin, and a plain form without `Secure` only with an http origin,
 * which configuration allows only in development and test on a loopback host.
 */
function attemptCookie(publicOrigin: string) {
  const secure = publicOrigin.startsWith("https://");
  const name = secure ? "__Host-mmd_signin" : "mmd_signin";
  const attributes = secure
    ? "Path=/; Secure; HttpOnly; SameSite=Lax"
    : "Path=/; HttpOnly; SameSite=Lax";
  return {
    name,
    set: (value: string) =>
      `${name}=${value}; ${attributes}; Max-Age=${ATTEMPT_COOKIE_SECONDS}`,
    clear: () => `${name}=; ${attributes}; Max-Age=0`,
  };
}

/** The value of one cookie; undefined when it is missing or sent more than once. */
function readCookie(request: FastifyRequest, name: string): string | undefined {
  const header = request.headers.cookie;
  if (header === undefined) {
    return undefined;
  }
  const values = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
    .map((part) => part.slice(name.length + 1));
  return values.length === 1 ? values[0] : undefined;
}

const INVALID_ATTEMPT = errorPage(
  "This sign-in is no longer valid",
  "The sign-in expired, was already used, or was started in another browser. Do not copy this page's address or send it to anyone.",
);

/**
 * GitHub sign-in brokered by the API (ADR 0014, steps 2 to 5): authorize,
 * GitHub's callback, and the confirmation. Registered only when GitHub
 * sign-in is configured; otherwise the routes answer the generic 404.
 */
export async function registerGitHubSignIn(
  app: FastifyInstance,
  options: GitHubSignInOptions,
): Promise<void> {
  const { publicOrigin, github, attempts, codes } = options;
  const callbackUrl = `${publicOrigin}${AUTH_ROUTES.githubCallback.path}`;
  const cookie = attemptCookie(publicOrigin);

  // Expired attempts and codes leave memory within seconds of their lifetime.
  const sweeper = setInterval(() => {
    attempts.sweep();
    codes.sweep();
  }, 15_000);
  sweeper.unref();
  app.addHook("onClose", async () => {
    clearInterval(sweeper);
  });

  let exchangeHour = -1;
  let exchangeCount = 0;
  function countExchange(request: FastifyRequest): void {
    const hour = Math.floor(options.now() / 3_600_000);
    if (hour !== exchangeHour) {
      exchangeHour = hour;
      exchangeCount = 0;
    }
    exchangeCount += 1;
    if (exchangeCount === EXCHANGE_WARNING_PER_HOUR + 1) {
      request.log.warn(
        { exchangesThisHour: exchangeCount },
        "GitHub token exchanges are near GitHub's hourly limit",
      );
    }
  }

  /** Tells the desktop's listener how the attempt ended and drops the attempt. */
  function toListener(
    reply: FastifyReply,
    attempt: SignInAttempt,
    fields: Readonly<Record<string, string>>,
    title: string,
    text: string,
  ): FastifyReply {
    attempts.delete(attempt);
    reply.header("set-cookie", cookie.clear());
    return sendPage(
      reply,
      200,
      listenerPage({
        redirectUri: attempt.desktop.redirectUri,
        fields: { ...fields, state: attempt.desktop.state },
        title,
        text,
      }),
      [originOf(attempt.desktop.redirectUri)],
    );
  }

  await app.register(async (scope) => {
    // The confirmation page posts an HTML form, and nothing else is accepted.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string", bodyLimit: 4096 },
      (_request, body, done) => {
        const params = new URLSearchParams(String(body));
        const keys = [...params.keys()];
        if (new Set(keys).size !== keys.length) {
          done(null, null);
          return;
        }
        done(null, Object.fromEntries(params));
      },
    );

    scope.get(
      AUTH_ROUTES.githubAuthorize.path,
      { config: { rateLimit: ROUTE_LIMIT } },
      async (request, reply) => {
        const query = GitHubAuthorizeQuerySchema.safeParse(request.query);
        if (!query.success) {
          // Never redirect on a malformed request (ADR 0014, step 2).
          return sendPage(
            reply,
            400,
            errorPage(
              "Sign-in could not start",
              "The request from the MyManDev application is not valid.",
            ),
          );
        }
        const created = attempts.create({
          codeChallenge: query.data.code_challenge,
          state: query.data.state,
          redirectUri: query.data.redirect_uri,
        });
        if (created === null) {
          reply.header("retry-after", "60");
          return sendPage(
            reply,
            429,
            errorPage(
              "Too many sign-ins",
              "Too many sign-ins are open right now. Try again in a minute.",
            ),
          );
        }
        const { attempt, cookieValue } = created;
        const location = github.authorizeUrl({
          redirectUri: callbackUrl,
          state: attempt.apiState,
          codeChallenge: s256(attempt.apiVerifier),
          ...(query.data.login === undefined
            ? {}
            : { login: query.data.login }),
          ...(query.data.prompt === undefined
            ? {}
            : { prompt: query.data.prompt }),
        });
        return reply
          .header("set-cookie", cookie.set(cookieValue))
          .header("cache-control", "no-store")
          .header("referrer-policy", "no-referrer")
          .redirect(location, 302);
      },
    );

    scope.get(
      AUTH_ROUTES.githubCallback.path,
      { config: { rateLimit: ROUTE_LIMIT } },
      async (request, reply) => {
        const query = CallbackQuerySchema.safeParse(request.query);
        const attempt = query.success
          ? attempts.find(query.data.state, readCookie(request, cookie.name))
          : null;
        // Consume the callback once; a second one never reaches GitHub.
        if (!query.success || attempt === null || attempt.phase !== "started") {
          return sendPage(reply, 400, INVALID_ATTEMPT);
        }
        attempt.phase = "callback";
        const { code, error } = query.data;
        if (error !== undefined || code === undefined) {
          return toListener(
            reply,
            attempt,
            {
              error:
                error === "access_denied" ? "access_denied" : "sign_in_failed",
            },
            "Sign-in was cancelled",
            "GitHub did not complete the sign-in. The MyManDev application shows what to do next.",
          );
        }

        countExchange(request);
        const exchanged = await github.exchangeCode({
          code,
          codeVerifier: attempt.apiVerifier,
          redirectUri: callbackUrl,
        });
        if (!exchanged.ok) {
          if (exchanged.reason === "rate_limited") {
            reply.header(
              "retry-after",
              String(exchanged.retryAfterSeconds ?? 60),
            );
            return toListener(
              reply,
              attempt,
              { error: "sign_in_unavailable" },
              "Sign-in is unavailable",
              "GitHub sign-in is busy right now. Try again later.",
            );
          }
          return toListener(
            reply,
            attempt,
            { error: "sign_in_failed" },
            "Sign-in failed",
            "GitHub did not confirm the sign-in. Start it again from the MyManDev application.",
          );
        }

        // The API keeps no GitHub token (ADR 0014, step 3): it deletes the
        // token right after reading the account, also when reading fails.
        const identity = await github
          .getUser(exchanged.accessToken)
          .finally(async () => {
            if (!(await github.deleteToken(exchanged.accessToken))) {
              request.log.warn("deleting the GitHub user token failed");
            }
          });
        if (identity === null) {
          return toListener(
            reply,
            attempt,
            { error: "sign_in_failed" },
            "Sign-in failed",
            "GitHub did not return the account. Start the sign-in again from the MyManDev application.",
          );
        }
        if (!GitHubLoginSchema.safeParse(identity.login).success) {
          return toListener(
            reply,
            attempt,
            { error: "unsupported_account" },
            "This GitHub account is not supported",
            "MyManDev cannot use this GitHub account.",
          );
        }
        attempt.identity = identity;
        attempt.phase = "identified";
        return sendPage(
          reply,
          200,
          confirmationPage({
            login: identity.login,
            pairingCode: pairingCode(attempt.desktop.codeChallenge),
            apiState: attempt.apiState,
          }),
          ["'self'"],
        );
      },
    );

    scope.post(
      AUTH_ROUTES.githubConfirm.path,
      { config: { rateLimit: ROUTE_LIMIT } },
      async (request, reply) => {
        // Our own page posts same-origin; its no-referrer policy makes the
        // Origin header null, so Sec-Fetch-Site is the signal. A cross-site
        // POST also lacks the SameSite=Lax cookie.
        const fetchSite = request.headers["sec-fetch-site"];
        if (fetchSite !== undefined && fetchSite !== "same-origin") {
          return sendPage(reply, 403, INVALID_ATTEMPT);
        }
        const form = ConfirmFormSchema.safeParse(request.body);
        const attempt = form.success
          ? attempts.find(form.data.state, readCookie(request, cookie.name))
          : null;
        if (
          !form.success ||
          attempt === null ||
          attempt.phase !== "identified" ||
          attempt.identity === null
        ) {
          return sendPage(reply, 400, INVALID_ATTEMPT);
        }
        if (form.data.decision === "cancel") {
          return toListener(
            reply,
            attempt,
            { error: "access_denied" },
            "Sign-in was cancelled",
            "You cancelled the sign-in. You can close this tab.",
          );
        }
        const code = codes.issue({
          identity: attempt.identity,
          desktopCodeChallenge: attempt.desktop.codeChallenge,
          redirectUri: attempt.desktop.redirectUri,
        });
        if (code === null) {
          return toListener(
            reply,
            attempt,
            { error: "sign_in_unavailable" },
            "Sign-in is unavailable",
            "Too many sign-ins are open right now. Try again in a minute.",
          );
        }
        return toListener(
          reply,
          attempt,
          { code },
          "Returning to MyManDev",
          "The MyManDev application finishes the sign-in. You can close this tab.",
        );
      },
    );
  });
}
