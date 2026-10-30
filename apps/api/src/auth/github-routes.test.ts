import { pairingCode, SIGN_IN_CODE_PATTERN } from "@mymandev/protocol";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { buildApp } from "../app.ts";
import { loadConfig } from "../config.ts";
import { createGitHubApi } from "./github-api.ts";
import { Secret } from "../secret.ts";
import {
  callback,
  confirm,
  fakeGitHub,
  FAKE_TOKEN,
  type FakeGitHubScenario,
  listenerForm,
  REDIRECT_URI,
  startAttempt,
} from "./github-test-support.ts";

const CLIENT_ID = "Iv23liExampleClient1";
const CLIENT_SECRET = "0123456789abcdef0123456789abcdef01234567";

type FlowOptions = Readonly<{
  origin?: string;
  scenario?: Partial<FakeGitHubScenario>;
  logLines?: string[];
  now?: () => number;
}>;

async function flowApp(t: TestContext, options: FlowOptions = {}) {
  const github = fakeGitHub(options.scenario);
  const app = await buildApp({
    config: loadConfig({
      NODE_ENV: "test",
      API_PUBLIC_ORIGIN: options.origin ?? "https://api.example",
      API_GITHUB_CLIENT_ID: CLIENT_ID,
      API_GITHUB_CLIENT_SECRET: CLIENT_SECRET,
      API_LOG_LEVEL: "trace",
    }),
    version: "1.2.3",
    logger:
      options.logLines === undefined
        ? false
        : { stream: { write: (line: string) => options.logLines?.push(line) } },
    shutdownGraceMs: 50,
    github: createGitHubApi({
      clientId: CLIENT_ID,
      clientSecret: new Secret(CLIENT_SECRET),
      fetch: github.fetch,
    }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  t.after(() => app.close());
  return { app, github };
}

function pathsOf(requests: readonly { method: string; url: string }[]) {
  return requests.map(
    (request) => `${request.method} ${new URL(request.url).pathname}`,
  );
}

test("without GitHub sign-in configured, the sign-in routes answer the generic 404", async (t) => {
  const app = await buildApp({
    config: loadConfig({ NODE_ENV: "test" }),
    version: "1.2.3",
    logger: false,
  });
  t.after(() => app.close());
  for (const [method, url] of [
    ["GET", "/auth/github/authorize"],
    ["GET", "/auth/github/callback"],
    ["POST", "/auth/github/confirm"],
  ] as const) {
    const response = await app.inject({ method, url });
    assert.equal(response.statusCode, 404, url);
    assert.equal(response.json().code, "not_found", url);
  }
});

test("authorize starts an attempt, sets its cookie, and redirects with the API's own state and PKCE pair", async (t) => {
  const { app } = await flowApp(t);
  const attempt = await startAttempt(app, {
    login: "octocat",
    prompt: "select_account",
  });
  const { location, response } = attempt;
  assert.equal(
    location.origin + location.pathname,
    "https://github.com/login/oauth/authorize",
  );
  assert.equal(location.searchParams.get("client_id"), CLIENT_ID);
  assert.equal(
    location.searchParams.get("redirect_uri"),
    "https://api.example/auth/github/callback",
  );
  assert.equal(location.searchParams.get("code_challenge_method"), "S256");
  assert.equal(location.searchParams.get("login"), "octocat");
  assert.equal(location.searchParams.get("prompt"), "select_account");
  assert.notEqual(attempt.apiState, attempt.desktopState);
  assert.notEqual(
    location.searchParams.get("code_challenge"),
    attempt.codeChallenge,
  );
  assert.match(attempt.apiState, /^[A-Za-z0-9_-]{43}$/u);
  assert.match(
    String(response.headers["set-cookie"]),
    /^__Host-mmd_signin=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=600$/u,
  );
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["referrer-policy"], "no-referrer");
});

test("with an http origin in development, the cookie has no prefix and no Secure (#99)", async (t) => {
  const { app } = await flowApp(t, { origin: "http://127.0.0.1:3000" });
  const attempt = await startAttempt(app);
  assert.match(
    String(attempt.response.headers["set-cookie"]),
    /^mmd_signin=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=600$/u,
  );
  assert.equal(
    attempt.location.searchParams.get("redirect_uri"),
    "http://127.0.0.1:3000/auth/github/callback",
  );
});

test("a malformed authorize request shows an error page and never redirects", async (t) => {
  const { app } = await flowApp(t);
  const good = {
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256",
    redirect_uri: REDIRECT_URI,
    state: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
  };
  const bad: [label: string, query: string][] = [
    [
      "localhost redirect",
      new URLSearchParams({
        ...good,
        redirect_uri: "http://localhost:49152/callback",
      }).toString(),
    ],
    [
      "port 1023",
      new URLSearchParams({
        ...good,
        redirect_uri: "http://127.0.0.1:1023/callback",
      }).toString(),
    ],
    [
      "plain method",
      new URLSearchParams({
        ...good,
        code_challenge_method: "plain",
      }).toString(),
    ],
    ["short state", new URLSearchParams({ ...good, state: "abc" }).toString()],
    [
      "bad login",
      new URLSearchParams({ ...good, login: "octo cat" }).toString(),
    ],
    [
      "other prompt",
      new URLSearchParams({ ...good, prompt: "consent" }).toString(),
    ],
    [
      "repeated state",
      `${new URLSearchParams(good).toString()}&state=${good.state}`,
    ],
    ["nothing", ""],
  ];
  for (const [label, query] of bad) {
    const response = await app.inject({
      method: "GET",
      url: `/auth/github/authorize?${query}`,
    });
    assert.equal(response.statusCode, 400, label);
    assert.equal(response.headers.location, undefined, label);
    assert.equal(response.headers["set-cookie"], undefined, label);
    assert.match(
      String(response.headers["content-type"]),
      /^text\/html/u,
      label,
    );
    assert.match(
      String(response.headers["content-security-policy"]),
      /default-src 'none'/u,
      label,
    );
  }
});

test("a full sign-in: callback, confirmation page, Continue, and a code posted to the listener", async (t) => {
  const { app, github } = await flowApp(t);
  const attempt = await startAttempt(app);
  const page = await callback(app, attempt, {
    code: "github-code-1",
    state: attempt.apiState,
  });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /octocat/u);
  assert.equal(page.body.includes(pairingCode(attempt.codeChallenge)), true);
  assert.match(
    String(page.headers["content-security-policy"]),
    /form-action 'self'/u,
  );

  assert.deepEqual(pathsOf(github.requests), [
    "POST /login/oauth/access_token",
    "GET /user",
    `DELETE /applications/${CLIENT_ID}/token`,
  ]);
  const [exchange, user, removal] = github.requests;
  assert.equal(
    new URL(exchange?.url ?? "").search,
    "",
    "no parameter in the exchange URL",
  );
  assert.equal(
    exchange?.headers["content-type"],
    "application/x-www-form-urlencoded",
  );
  const form = new URLSearchParams(exchange?.body);
  assert.equal(form.get("client_id"), CLIENT_ID);
  assert.equal(form.get("client_secret"), CLIENT_SECRET);
  assert.equal(form.get("code"), "github-code-1");
  assert.equal(
    form.get("redirect_uri"),
    "https://api.example/auth/github/callback",
  );
  assert.match(form.get("code_verifier") ?? "", /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(user?.headers.authorization, `Bearer ${FAKE_TOKEN}`);
  assert.equal(JSON.parse(removal?.body ?? "{}").access_token, FAKE_TOKEN);
  assert.equal(
    removal?.headers.authorization,
    `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`,
  );

  const done = await confirm(app, attempt, "continue");
  assert.equal(done.statusCode, 200);
  const posted = listenerForm(done.body);
  assert.ok(posted !== null);
  assert.equal(posted.action, REDIRECT_URI);
  assert.equal(posted.fields.state, attempt.desktopState);
  assert.match(posted.fields.code ?? "", SIGN_IN_CODE_PATTERN);
  assert.equal(done.headers.location, undefined);
  assert.match(
    String(done.headers["content-security-policy"]),
    /form-action http:\/\/127\.0\.0\.1:49152/u,
  );
  assert.match(String(done.headers["set-cookie"]), /Max-Age=0/u);
  assert.match(done.body, /<script>/u);

  for (const response of [attempt.response, page, done]) {
    assert.equal(response.body.includes(FAKE_TOKEN), false);
    assert.equal(JSON.stringify(response.headers).includes(FAKE_TOKEN), false);
  }
  // The attempt is gone: a second confirmation and a replayed callback fail.
  assert.equal((await confirm(app, attempt, "continue")).statusCode, 400);
  assert.equal(
    (await callback(app, attempt, { code: "x", state: attempt.apiState }))
      .statusCode,
    400,
  );
  assert.equal(github.requests.length, 3);
});

test("a callback that names an attempt without its cookie ends it, so a replayed GitHub code is never exchanged", async (t) => {
  // The phishing scenario of ADR 0014 ("Threats"): an attacker starts an
  // attempt, the victim's browser brings GitHub's code back without the
  // attacker's cookie, and the attacker replays the URL with the cookie.
  const { app, github } = await flowApp(t);
  for (const victimCookie of [null, "mmd_other=x"]) {
    const attacker = await startAttempt(app);
    const other = await startAttempt(app);
    const cookie = victimCookie === null ? null : other.cookie;
    const victim = await callback(
      app,
      attacker,
      { code: "victim-code", state: attacker.apiState },
      cookie,
    );
    assert.equal(victim.statusCode, 400);
    assert.equal(listenerForm(victim.body), null);
    assert.match(victim.body, /Do not copy this page/u);
    const replay = await callback(app, attacker, {
      code: "victim-code",
      state: attacker.apiState,
    });
    assert.equal(replay.statusCode, 400, "the attacker's replay fails");
    assert.equal(listenerForm(replay.body), null);
  }
  assert.equal(github.requests.length, 0, "GitHub's code was never exchanged");
});

test("an unknown state, or a second callback, fails before another exchange", async (t) => {
  const { app, github } = await flowApp(t);
  const attempt = await startAttempt(app);
  assert.equal(
    (await callback(app, attempt, { code: "c", state: "unknown" })).statusCode,
    400,
  );
  assert.equal(
    (await callback(app, attempt, { code: "c", state: attempt.apiState }))
      .statusCode,
    200,
  );
  assert.equal(
    (await callback(app, attempt, { code: "c", state: attempt.apiState }))
      .statusCode,
    400,
  );
  assert.equal(
    github.requests.filter((request) => request.method === "POST").length,
    1,
  );
});
test("an exchange error with HTTP 200 fails after exactly one exchange and tells the listener", async (t) => {
  const { app, github } = await flowApp(t, {
    scenario: { exchange: "error_with_200" },
  });
  const attempt = await startAttempt(app);
  const response = await callback(app, attempt, {
    code: "c",
    state: attempt.apiState,
  });
  assert.deepEqual(listenerForm(response.body)?.fields, {
    error: "sign_in_failed",
    state: attempt.desktopState,
  });
  assert.deepEqual(pathsOf(github.requests), [
    "POST /login/oauth/access_token",
  ]);
});

test("GitHub's error and a declined consent reach the listener as error and state", async (t) => {
  const { app, github } = await flowApp(t);
  for (const [error, expected] of [
    ["access_denied", "access_denied"],
    ["redirect_uri_mismatch", "sign_in_failed"],
  ] as const) {
    const attempt = await startAttempt(app);
    const response = await callback(app, attempt, {
      error,
      state: attempt.apiState,
    });
    assert.deepEqual(listenerForm(response.body)?.fields, {
      error: expected,
      state: attempt.desktopState,
    });
  }
  assert.equal(github.requests.length, 0);
});

test("an unsupported login is refused at the callback, and the token is still deleted", async (t) => {
  const { app, github } = await flowApp(t, {
    scenario: {
      user: {
        id: 7,
        login: "has.dot",
        name: null,
        created_at: "2020-01-01T00:00:00Z",
      },
    },
  });
  const attempt = await startAttempt(app);
  const response = await callback(app, attempt, {
    code: "c",
    state: attempt.apiState,
  });
  assert.deepEqual(listenerForm(response.body)?.fields, {
    error: "unsupported_account",
    state: attempt.desktopState,
  });
  assert.equal(response.body.includes("Continue"), false);
  assert.deepEqual(
    pathsOf(github.requests).at(-1),
    `DELETE /applications/${CLIENT_ID}/token`,
  );
});

test("GitHub's rate limit answers sign_in_unavailable with Retry-After", async (t) => {
  const { app } = await flowApp(t, { scenario: { exchange: "rate_limited" } });
  const attempt = await startAttempt(app);
  const response = await callback(app, attempt, {
    code: "c",
    state: attempt.apiState,
  });
  assert.equal(response.headers["retry-after"], "120");
  assert.equal(
    listenerForm(response.body)?.fields.error,
    "sign_in_unavailable",
  );
});

test("Cancel tells the listener access_denied, and the attempt is gone", async (t) => {
  const { app } = await flowApp(t);
  const attempt = await startAttempt(app);
  await callback(app, attempt, { code: "c", state: attempt.apiState });
  const response = await confirm(app, attempt, "cancel");
  assert.deepEqual(listenerForm(response.body)?.fields, {
    error: "access_denied",
    state: attempt.desktopState,
  });
  assert.equal((await confirm(app, attempt, "continue")).statusCode, 400);
});

test("a confirmation needs a form, a same-origin request, and a shown confirmation page", async (t) => {
  const { app } = await flowApp(t);
  const early = await startAttempt(app);
  assert.equal(
    (await confirm(app, early, "continue")).statusCode,
    400,
    "before the callback",
  );

  const attempt = await startAttempt(app);
  await callback(app, attempt, { code: "c", state: attempt.apiState });
  assert.equal(
    (await confirm(app, attempt, "continue", { fetchSite: "cross-site" }))
      .statusCode,
    403,
  );
  assert.equal((await confirm(app, attempt, "maybe")).statusCode, 400);
  const duplicate = await app.inject({
    method: "POST",
    url: "/auth/github/confirm",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: attempt.cookie,
    },
    payload: `state=${attempt.apiState}&decision=cancel&decision=continue`,
  });
  assert.equal(duplicate.statusCode, 400);
  const json = await app.inject({
    method: "POST",
    url: "/auth/github/confirm",
    headers: { cookie: attempt.cookie },
    payload: { state: attempt.apiState, decision: "continue" },
  });
  assert.equal(json.statusCode, 415);
  assert.equal(json.json().code, "bad_request");
  // None of the refused requests ended the attempt.
  assert.equal(
    listenerForm((await confirm(app, attempt, "continue")).body)?.fields.state,
    attempt.desktopState,
  );
});

test("a confirmation without the attempt's cookie ends the attempt", async (t) => {
  const { app } = await flowApp(t);
  for (const cookie of [null, "foreign"]) {
    const attempt = await startAttempt(app);
    const other = await startAttempt(app);
    await callback(app, attempt, { code: "c", state: attempt.apiState });
    const refused = await confirm(app, attempt, "continue", {
      cookie: cookie === null ? null : other.cookie,
    });
    assert.equal(refused.statusCode, 400);
    assert.equal((await confirm(app, attempt, "continue")).statusCode, 400);
  }
});
test("an attempt expires after 10 minutes", async (t) => {
  let clock = Date.parse("2026-10-30T12:00:00.000Z");
  const { app, github } = await flowApp(t, { now: () => clock });
  const attempt = await startAttempt(app);
  clock += 10 * 60_000;
  assert.equal(
    (await callback(app, attempt, { code: "c", state: attempt.apiState }))
      .statusCode,
    400,
  );
  assert.equal(github.requests.length, 0);
});

test("authorize is limited per address and answers 429 with rate_limited", async (t) => {
  const { app } = await flowApp(t);
  for (let index = 0; index < 30; index += 1) {
    await startAttempt(app);
  }
  const response = await app.inject({
    method: "GET",
    url: "/auth/github/authorize",
    remoteAddress: "127.0.0.1",
  });
  assert.equal(response.statusCode, 429);
  assert.equal(response.json().code, "rate_limited");
  const other = await app.inject({
    method: "GET",
    url: "/auth/github/authorize",
    remoteAddress: "127.0.0.2",
  });
  assert.equal(other.statusCode, 400, "another address has its own budget");
});

test("no code, state, cookie, token, verifier, or client secret reaches the logs", async (t) => {
  const logLines: string[] = [];
  const { app, github } = await flowApp(t, { logLines });
  const attempt = await startAttempt(app);
  await callback(app, attempt, {
    code: "github-code-SECRET",
    state: attempt.apiState,
  });
  const done = await confirm(app, attempt, "continue");
  const code = listenerForm(done.body)?.fields.code ?? "";
  const failed = await flowApp(t, {
    logLines,
    scenario: { exchange: "invalid_grant_400" },
  });
  const second = await startAttempt(failed.app);
  await callback(failed.app, second, {
    code: "github-code-SECRET",
    state: second.apiState,
  });

  const verifier =
    new URLSearchParams(github.requests[0]?.body).get("code_verifier") ?? "";
  const secrets = [
    code,
    attempt.apiState,
    attempt.desktopState,
    attempt.cookie.split("=")[1] ?? "",
    FAKE_TOKEN,
    verifier,
    CLIENT_SECRET,
    "github-code-SECRET",
    second.apiState,
  ];
  assert.ok(logLines.length > 0);
  const logs = logLines.join("");
  for (const secret of secrets) {
    assert.ok(secret.length > 0);
    assert.equal(logs.includes(secret), false, secret);
  }
});
