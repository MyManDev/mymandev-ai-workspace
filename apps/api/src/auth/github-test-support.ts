// Test support for the GitHub sign-in flow: a fake fetch that plays GitHub,
// and helpers that drive the API like a browser and the desktop would.
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { randomToken, s256 } from "./attempts.ts";

export const FAKE_TOKEN = "gho_FAKEaccessTOKENneverSHOWN0123456789";
export const REDIRECT_URI = "http://127.0.0.1:49152/callback";

export type RecordedRequest = Readonly<{
  method: string;
  url: string;
  headers: Readonly<Record<string, string>>;
  body: string;
  redirect: string | undefined;
}>;

export type FakeGitHubScenario = {
  /** The answer to the token exchange. */
  exchange:
    | "ok"
    | "error_with_200"
    | "invalid_grant_400"
    | "rate_limited"
    | "network_error";
  user: Readonly<Record<string, unknown>> | "fail";
  deleteStatus: number;
};

/** A fetch that answers like GitHub and records every request. */
export function fakeGitHub(scenario: Partial<FakeGitHubScenario> = {}) {
  const current: FakeGitHubScenario = {
    exchange: "ok",
    user: {
      id: 583231,
      login: "octocat",
      name: "The Octocat",
      created_at: "2011-01-25T18:44:36Z",
    },
    deleteStatus: 204,
    ...scenario,
  };
  const requests: RecordedRequest[] = [];
  const json = (
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const method = init?.method ?? "GET";
    requests.push({
      method,
      url,
      headers,
      body: typeof init?.body === "string" ? init.body : "",
      redirect: init?.redirect,
    });
    const path = new URL(url).pathname;
    if (method === "POST" && path === "/login/oauth/access_token") {
      switch (current.exchange) {
        case "ok":
          return json(200, { access_token: FAKE_TOKEN, token_type: "bearer" });
        case "error_with_200":
          return json(200, { error: "bad_verification_code" });
        case "invalid_grant_400":
          return json(400, { error: "invalid_grant" });
        case "rate_limited":
          return json(
            429,
            { message: "rate limited" },
            { "retry-after": "120" },
          );
        case "network_error":
          throw new TypeError("fetch failed");
      }
    }
    if (method === "GET" && path === "/user") {
      return current.user === "fail"
        ? json(401, { message: "Bad credentials" })
        : json(200, current.user);
    }
    if (method === "DELETE" && path.startsWith("/applications/")) {
      return new Response(null, { status: current.deleteStatus });
    }
    return json(404, { message: "Not Found" });
  };
  return { fetch: fetchImpl, requests, scenario: current };
}

export type StartedAttempt = Readonly<{
  response: LightMyRequestResponse;
  location: URL;
  apiState: string;
  /** The `name=value` pair to send back. */
  cookie: string;
  desktopState: string;
  codeChallenge: string;
  /** The desktop's PKCE verifier for this attempt. */
  codeVerifier: string;
}>;

/** Opens `/auth/github/authorize` the way the desktop does. */
export async function startAttempt(
  app: FastifyInstance,
  extra: Readonly<Record<string, string>> = {},
): Promise<StartedAttempt> {
  const desktopState = randomToken();
  const codeVerifier = randomToken();
  const codeChallenge = s256(codeVerifier);
  const query = new URLSearchParams({
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    redirect_uri: REDIRECT_URI,
    state: desktopState,
    ...extra,
  });
  const response = await app.inject({
    method: "GET",
    url: `/auth/github/authorize?${query.toString()}`,
  });
  if (response.statusCode !== 302) {
    throw new Error(`authorize answered ${response.statusCode}`);
  }
  const location = new URL(String(response.headers.location));
  return {
    response,
    location,
    apiState: location.searchParams.get("state") ?? "",
    cookie: String(response.headers["set-cookie"]).split(";")[0] ?? "",
    desktopState,
    codeChallenge,
    codeVerifier,
  };
}

export function callback(
  app: FastifyInstance,
  attempt: StartedAttempt,
  query: Readonly<Record<string, string>>,
  cookie: string | null = attempt.cookie,
) {
  return app.inject({
    method: "GET",
    url: `/auth/github/callback?${new URLSearchParams(query).toString()}`,
    headers: cookie === null ? {} : { cookie },
  });
}

export function confirm(
  app: FastifyInstance,
  attempt: StartedAttempt,
  decision: string,
  options: Readonly<{ cookie?: string | null; fetchSite?: string }> = {},
) {
  const cookie = options.cookie === undefined ? attempt.cookie : options.cookie;
  return app.inject({
    method: "POST",
    url: "/auth/github/confirm",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "sec-fetch-site": options.fetchSite ?? "same-origin",
      ...(cookie === null ? {} : { cookie }),
    },
    payload: new URLSearchParams({
      state: attempt.apiState,
      decision,
    }).toString(),
  });
}

/** The hidden fields and the action of the form with the ID "f". */
export function listenerForm(html: string) {
  const form =
    /<form id="f" method="post" action="([^"]*)">(.*?)<[/]form>/u.exec(html);
  if (form === null) {
    return null;
  }
  const fields: Record<string, string> = {};
  for (const match of (form[2] ?? "").matchAll(
    /name="([a-z_]+)" value="([^"]*)"/gu,
  )) {
    fields[match[1] ?? ""] = match[2] ?? "";
  }
  return { action: form[1] ?? "", fields };
}
