import assert from "node:assert/strict";
import { test } from "node:test";
import { Secret } from "../secret.ts";
import { randomToken, s256, SignInAttempts, SignInCodes } from "./attempts.ts";
import { createGitHubApi } from "./github-api.ts";
import { FAKE_TOKEN, fakeGitHub } from "./github-test-support.ts";

const CLIENT_ID = "Iv23liExampleClient1";
const SECRET = new Secret("0123456789abcdef0123456789abcdef01234567");

function apiWith(
  fetchImpl: typeof fetch,
  now = () => Date.parse("2026-10-30T12:00:00Z"),
) {
  return createGitHubApi({
    clientId: CLIENT_ID,
    clientSecret: SECRET,
    fetch: fetchImpl,
    now,
  });
}

const exchangeInput = {
  code: "c",
  codeVerifier: randomToken(),
  redirectUri: "https://api.example/auth/github/callback",
};

test("the authorize URL carries the API's client, callback, state, and S256 challenge", () => {
  const api = apiWith(fakeGitHub().fetch);
  const url = new URL(
    api.authorizeUrl({
      redirectUri: "https://api.example/auth/github/callback",
      state: "s",
      codeChallenge: s256("v"),
    }),
  );
  assert.equal(
    url.origin + url.pathname,
    "https://github.com/login/oauth/authorize",
  );
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    client_id: CLIENT_ID,
    redirect_uri: "https://api.example/auth/github/callback",
    state: "s",
    code_challenge: s256("v"),
    code_challenge_method: "S256",
  });
});

test("the exchange treats every error field as a failure and reports GitHub's limit", async () => {
  const cases: [
    scenario: Parameters<typeof fakeGitHub>[0],
    expected: unknown,
  ][] = [
    [{ exchange: "ok" }, { ok: true, accessToken: FAKE_TOKEN }],
    [{ exchange: "error_with_200" }, { ok: false, reason: "rejected" }],
    [{ exchange: "invalid_grant_400" }, { ok: false, reason: "rejected" }],
    [
      { exchange: "rate_limited" },
      { ok: false, reason: "rate_limited", retryAfterSeconds: 120 },
    ],
    [{ exchange: "network_error" }, { ok: false, reason: "unavailable" }],
  ];
  for (const [scenario, expected] of cases) {
    const fake = fakeGitHub(scenario);
    assert.deepEqual(
      await apiWith(fake.fetch).exchangeCode(exchangeInput),
      expected,
    );
    assert.equal(fake.requests.length, 1, "never retried");
  }
  const now = Date.parse("2026-10-30T12:00:00Z");
  const exhausted: typeof fetch = async () =>
    new Response("{}", {
      status: 403,
      headers: {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(now / 1000 + 300),
      },
    });
  assert.deepEqual(
    await apiWith(exhausted, () => now).exchangeCode(exchangeInput),
    {
      ok: false,
      reason: "rate_limited",
      retryAfterSeconds: 300,
    },
  );
  const notJson: typeof fetch = async () =>
    new Response("<html>", { status: 502 });
  assert.deepEqual(await apiWith(notJson).exchangeCode(exchangeInput), {
    ok: false,
    reason: "unavailable",
  });
});

test("the user is read with the token, and a broken answer gives null", async () => {
  const ok = await apiWith(fakeGitHub().fetch).getUser(FAKE_TOKEN);
  assert.deepEqual(ok, {
    githubId: "583231",
    login: "octocat",
    name: "The Octocat",
    accountCreatedAt: "2011-01-25T18:44:36Z",
  });
  for (const user of [
    "fail",
    {
      id: "583231",
      login: "octocat",
      name: null,
      created_at: "2011-01-25T18:44:36Z",
    },
    { id: 0, login: "octocat", name: null, created_at: "2011-01-25T18:44:36Z" },
    { id: 1, login: "octocat", name: null, created_at: "yesterday" },
  ] as const) {
    assert.equal(
      await apiWith(fakeGitHub({ user }).fetch).getUser(FAKE_TOKEN),
      null,
    );
  }
});

test("deleting the token uses Basic auth with the client and reports anything but 204 as a failure", async () => {
  const fake = fakeGitHub();
  assert.equal(await apiWith(fake.fetch).deleteToken(FAKE_TOKEN), true);
  const request = fake.requests[0];
  assert.equal(request?.method, "DELETE");
  assert.equal(
    new URL(request?.url ?? "").pathname,
    `/applications/${CLIENT_ID}/token`,
  );
  assert.deepEqual(JSON.parse(request?.body ?? "{}"), {
    access_token: FAKE_TOKEN,
  });
  assert.equal(
    await apiWith(fakeGitHub({ deleteStatus: 422 }).fetch).deleteToken(
      FAKE_TOKEN,
    ),
    false,
  );
});

test("the attempt store caps open attempts, needs the cookie, and drops expired attempts", () => {
  let clock = 0;
  const attempts = new SignInAttempts({
    max: 2,
    lifetimeMs: 1_000,
    now: () => clock,
  });
  const desktop = {
    codeChallenge: s256("v"),
    state: randomToken(),
    redirectUri: "http://127.0.0.1:49152/callback",
  };
  const first = attempts.create(desktop);
  const second = attempts.create(desktop);
  assert.ok(first !== null && second !== null);
  assert.equal(attempts.create(desktop), null, "the cap");
  assert.equal(
    attempts.find(first.attempt.apiState, first.cookieValue),
    first.attempt,
  );
  assert.equal(attempts.find(first.attempt.apiState, second.cookieValue), null);
  assert.equal(attempts.find(first.attempt.apiState, undefined), null);
  assert.equal(first.attempt.cookieHash.includes(first.cookieValue), false);
  clock = 1_000;
  assert.equal(attempts.find(first.attempt.apiState, first.cookieValue), null);
  assert.equal(attempts.size, 0);
  assert.notEqual(
    attempts.create(desktop),
    null,
    "expired attempts free the cap",
  );
});

test("a sign-in code is used once and expires after its lifetime", () => {
  let clock = 0;
  const codes = new SignInCodes({
    max: 10,
    lifetimeMs: 60_000,
    now: () => clock,
  });
  const binding = {
    identity: {
      githubId: "1",
      login: "a",
      name: null,
      accountCreatedAt: "2020-01-01T00:00:00Z",
    },
    desktopCodeChallenge: s256("v"),
    redirectUri: "http://127.0.0.1:49152/callback",
  };
  const code = codes.issue(binding);
  assert.ok(code !== null);
  assert.match(code, /^mmdc_[A-Za-z0-9_-]{43}$/u);
  assert.equal(codes.take(code)?.identity.login, "a");
  assert.equal(codes.take(code), null, "single use");
  const late = codes.issue(binding);
  assert.ok(late !== null);
  clock = 60_000;
  assert.equal(codes.take(late), null, "expired");
});
