import assert from "node:assert/strict";
import { test } from "node:test";
import { Secret } from "../secret.ts";
import {
  randomToken,
  RecentRevocations,
  s256,
  sha256Hex,
  SIGN_IN_CODE_PREFIX,
  SignInAttempts,
  SignInCodes,
} from "./attempts.ts";
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
  const desktop = () => ({
    codeChallenge: s256(randomToken()),
    state: randomToken(),
    redirectUri: "http://127.0.0.1:49152/callback",
  });
  const first = attempts.create(desktop());
  const second = attempts.create(desktop());
  assert.ok(typeof first !== "string" && typeof second !== "string");
  assert.equal(attempts.create(desktop()), "full", "the cap");
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
  assert.equal(
    typeof attempts.create(desktop()),
    "object",
    "expired attempts free the cap",
  );
});

test("the attempt store refuses a desktop challenge or state that started an attempt within its lifetime (#149)", () => {
  let clock = 0;
  const attempts = new SignInAttempts({
    max: 10,
    lifetimeMs: 1_000,
    now: () => clock,
  });
  const desktop = {
    codeChallenge: s256(randomToken()),
    state: randomToken(),
    redirectUri: "http://127.0.0.1:49152/callback",
  };
  const first = attempts.create(desktop);
  assert.ok(typeof first !== "string");
  assert.equal(attempts.create(desktop), "reused", "the same values");
  assert.equal(
    attempts.create({ ...desktop, codeChallenge: s256(randomToken()) }),
    "reused",
    "the same state",
  );
  assert.equal(
    attempts.create({ ...desktop, state: randomToken() }),
    "reused",
    "the same challenge",
  );
  attempts.delete(first.attempt);
  assert.equal(attempts.create(desktop), "reused", "after the attempt ended");
  clock = 999;
  assert.equal(attempts.create(desktop), "reused", "until its lifetime ends");
  clock = 1_000;
  assert.equal(typeof attempts.create(desktop), "object", "after the lifetime");
});

const CODE_BINDING = {
  identity: {
    githubId: "1",
    login: "a",
    name: null,
    accountCreatedAt: "2020-01-01T00:00:00Z",
  },
  identityReadAt: 0,
  desktopCodeChallenge: s256("v"),
  redirectUri: "http://127.0.0.1:49152/callback",
};

test("a sign-in code is used once and expires after its lifetime", () => {
  let clock = 0;
  const codes = new SignInCodes({
    max: 10,
    lifetimeMs: 60_000,
    now: () => clock,
  });
  const code = codes.issue(CODE_BINDING);
  assert.ok(code !== null);
  assert.match(code, /^mmdc_[A-Za-z0-9_-]{43}$/u);
  assert.equal(codes.take(code)?.identity.login, "a");
  assert.equal(codes.take(code), null, "single use");
  const late = codes.issue(CODE_BINDING);
  assert.ok(late !== null);
  clock = 60_000;
  assert.equal(codes.take(late), null, "expired");
});

test("a taken sign-in code is recorded as used, with its challenge and redirect URI, for one code lifetime after the take (#152)", () => {
  let clock = 0;
  const codes = new SignInCodes({
    max: 10,
    lifetimeMs: 60_000,
    now: () => clock,
  });
  const code = codes.issue(CODE_BINDING);
  assert.ok(code !== null);
  assert.equal(codes.used(code), null, "a live code is not used");
  clock = 59_000;
  assert.ok(codes.take(code) !== null);
  assert.deepEqual(codes.used(code), {
    desktopCodeChallenge: CODE_BINDING.desktopCodeChallenge,
    redirectUri: CODE_BINDING.redirectUri,
    expiresAt: 119_000,
  });
  assert.equal(
    codes.used(`${SIGN_IN_CODE_PREFIX}${randomToken()}`),
    null,
    "unknown",
  );
  clock = 118_999;
  assert.ok(codes.used(code) !== null, "past the code's own expiry");
  clock = 119_000;
  assert.equal(codes.used(code), null, "expired");

  const late = codes.issue(CODE_BINDING);
  assert.ok(late !== null);
  clock += 60_000;
  assert.equal(codes.take(late), null);
  assert.equal(codes.used(late), null, "a code that expired is not recorded");
});

test("the code store writes a sign-in code only as its hash, also when it records the code as used (#152)", (t) => {
  const codes = new SignInCodes({
    max: 10,
    lifetimeMs: 60_000,
    now: () => 0,
  });
  const set = t.mock.method(Map.prototype, "set");
  const code = codes.issue(CODE_BINDING);
  const taken = code === null ? null : codes.take(code);
  set.mock.restore();
  assert.ok(code !== null && taken !== null);
  const written = set.mock.calls.map((call) => call.arguments);
  assert.deepEqual(
    written.map(([key]) => key),
    [sha256Hex(code), sha256Hex(code)],
    "the live code and its record of use",
  );
  assert.equal(JSON.stringify(written).includes(code), false);
});

test("live sign-in codes and records of used codes share twice the cap, and expired records free their places (#152)", () => {
  let clock = 0;
  const codes = new SignInCodes({
    max: 2,
    lifetimeMs: 60_000,
    now: () => clock,
  });
  const issue = () => {
    const code = codes.issue(CODE_BINDING);
    assert.ok(code !== null);
    return code;
  };
  const first = issue();
  const second = issue();
  assert.equal(codes.issue(CODE_BINDING), null, "two live codes");
  codes.take(first);
  codes.take(second);
  clock = 30_000;
  const third = issue();
  issue();
  codes.take(third);
  // One live code and three records: taking a code never drops a record.
  assert.equal(codes.issue(CODE_BINDING), null, "four entries");
  assert.ok(codes.used(first) !== null);
  assert.ok(codes.used(third) !== null);
  clock = 60_000;
  assert.ok(
    codes.issue(CODE_BINDING) !== null,
    "the first two records expired",
  );
  assert.equal(codes.used(first), null);
  assert.ok(codes.used(third) !== null);
});

test("recent revocations keep the latest time per GitHub ID, expire after their lifetime, and drop the oldest at the cap", () => {
  let clock = 0;
  const revocations = new RecentRevocations({
    max: 2,
    lifetimeMs: 1_000,
    now: () => clock,
  });
  revocations.record("1", 0);
  assert.equal(revocations.latest("1"), 0);
  assert.equal(revocations.latest("2"), null);
  clock = 500;
  revocations.record("1", 500);
  revocations.record("1", 400);
  assert.equal(revocations.latest("1"), 500, "never an earlier time");

  revocations.record("2", 500);
  revocations.record("3", 600);
  assert.equal(revocations.size, 2, "the cap");
  assert.equal(revocations.latest("1"), null, "the oldest left");
  assert.equal(revocations.latest("2"), 500);
  assert.equal(revocations.latest("3"), 600);

  clock = 1_500;
  assert.equal(revocations.latest("2"), null, "expired");
  assert.equal(revocations.latest("3"), 600);
  revocations.sweep();
  assert.equal(revocations.size, 1);
  clock = 1_600;
  assert.equal(revocations.size, 0);
});

test("every GitHub call refuses redirects", async () => {
  const fake = fakeGitHub();
  const api = apiWith(fake.fetch);
  await api.exchangeCode(exchangeInput);
  await api.getUser(FAKE_TOKEN);
  await api.deleteToken(FAKE_TOKEN);
  assert.deepEqual(
    fake.requests.map((request) => request.redirect),
    ["error", "error", "error"],
  );
});

test("a token in a failed exchange answer is deleted at once", async () => {
  for (const [status, body] of [
    [200, { error: "bad_verification_code", access_token: FAKE_TOKEN }],
    [500, { access_token: FAKE_TOKEN }],
  ] as const) {
    const deleted: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      if (init?.method === "DELETE") {
        deleted.push(JSON.parse(String(init.body)).access_token);
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    };
    const result = await apiWith(fetchImpl).exchangeCode(exchangeInput);
    assert.equal(result.ok, false, String(status));
    assert.deepEqual(deleted, [FAKE_TOKEN], String(status));
  }
});

test("sweeping drops expired attempts and codes without a new request", () => {
  let clock = 0;
  const options = { max: 10, lifetimeMs: 1_000, now: () => clock };
  const attempts = new SignInAttempts(options);
  const codes = new SignInCodes(options);
  const desktop = {
    codeChallenge: s256("v"),
    state: randomToken(),
    redirectUri: "http://127.0.0.1:49152/callback",
  };
  const created = attempts.create(desktop);
  assert.ok(typeof created !== "string");
  const code = codes.issue({
    identity: {
      githubId: "1",
      login: "a",
      name: null,
      accountCreatedAt: "2020-01-01T00:00:00Z",
    },
    identityReadAt: 0,
    desktopCodeChallenge: desktop.codeChallenge,
    redirectUri: desktop.redirectUri,
  });
  assert.ok(code !== null);
  const taken = codes.issue(CODE_BINDING);
  assert.ok(taken !== null && codes.take(taken) !== null);
  clock = 1_000;
  attempts.sweep();
  codes.sweep();
  clock = 0;
  assert.equal(
    attempts.find(created.attempt.apiState, created.cookieValue),
    null,
  );
  assert.equal(codes.take(code), null);
  assert.equal(codes.used(taken), null, "the record of a used code");
});
