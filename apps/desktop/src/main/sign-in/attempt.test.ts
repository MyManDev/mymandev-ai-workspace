import { createHash } from "node:crypto";
import { inspect } from "node:util";
import {
  AUTH_ROUTES,
  BASE64URL_32_BYTES_PATTERN,
  GitHubAuthorizeQuerySchema,
  pairingCode,
} from "@mymandev/protocol";
import { describe, expect, test } from "vitest";
import {
  authorizeUrl,
  type AuthorizeUrlInput,
  codeChallengeS256,
  createSignInAttempt,
} from "./attempt.ts";

// RFC 7636, appendix B.
const RFC_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const RFC_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

describe("createSignInAttempt", () => {
  test("creates a verifier and a state of 32 random bytes as 43 base64url characters", () => {
    const attempt = createSignInAttempt();
    for (const value of [attempt.codeVerifier, attempt.state]) {
      expect(value).toHaveLength(43);
      expect(value).toMatch(BASE64URL_32_BYTES_PATTERN);
      expect(Buffer.from(value, "base64url")).toHaveLength(32);
    }
    expect(attempt.codeVerifier).not.toBe(attempt.state);
  });

  test("creates new values every time", () => {
    const attempts = Array.from({ length: 20 }, () => createSignInAttempt());
    const values = attempts.flatMap((attempt) => [
      attempt.codeVerifier,
      attempt.state,
    ]);
    expect(new Set(values).size).toBe(values.length);
  });

  test("derives the S256 challenge and the protocol's pairing code from the verifier", () => {
    const attempt = createSignInAttempt();
    const expected = createHash("sha256")
      .update(attempt.codeVerifier, "ascii")
      .digest("base64url");
    expect(attempt.codeChallenge).toBe(expected);
    expect(attempt.codeChallenge).toMatch(BASE64URL_32_BYTES_PATTERN);
    expect(attempt.pairingCode).toBe(pairingCode(attempt.codeChallenge));
    expect(attempt.pairingCode).toMatch(/^[0-9]{6}$/u);
  });

  test("keeps the verifier out of logs and JSON", () => {
    const attempt = createSignInAttempt();
    expect(Object.keys(attempt)).toEqual([
      "state",
      "codeChallenge",
      "pairingCode",
    ]);
    expect(JSON.stringify(attempt)).not.toContain(attempt.codeVerifier);
    expect(inspect(attempt)).not.toContain(attempt.codeVerifier);
    expect(String(attempt)).not.toContain(attempt.codeVerifier);
    expect(Object.isFrozen(attempt)).toBe(true);
  });
});

describe("codeChallengeS256", () => {
  test("matches the example of RFC 7636", () => {
    expect(codeChallengeS256(RFC_VERIFIER)).toBe(RFC_CHALLENGE);
  });

  test.each([
    "",
    "short",
    `${RFC_VERIFIER}A`,
    // Not canonical: the unused low bits of the last character are set.
    `${RFC_VERIFIER.slice(0, 42)}l`,
    `${RFC_VERIFIER.slice(0, 42)}=`,
  ])("refuses the verifier %j without naming it", (verifier) => {
    expect(() => codeChallengeS256(verifier)).toThrow(
      new TypeError("Invalid code verifier"),
    );
  });
});

describe("authorizeUrl", () => {
  const attempt = createSignInAttempt();
  const base: Omit<AuthorizeUrlInput, "signIn"> = {
    apiOrigin: "https://api.mymandev.example",
    codeChallenge: attempt.codeChallenge,
    redirectUri: "http://127.0.0.1:49152/callback",
    state: attempt.state,
  };

  function query(url: string): Record<string, string> {
    const parsed = new URL(url);
    const names = [...parsed.searchParams.keys()];
    expect(new Set(names).size).toBe(names.length);
    return Object.fromEntries(parsed.searchParams);
  }

  test("builds the authorize route on the API origin", () => {
    const url = new URL(authorizeUrl({ ...base, signIn: { kind: "first" } }));
    expect(url.origin).toBe(base.apiOrigin);
    expect(url.pathname).toBe(AUTH_ROUTES.githubAuthorize.path);
    expect(url.pathname).toBe("/auth/github/authorize");
    expect(url.hash).toBe("");
    expect(url.username).toBe("");
  });

  test("a first sign-in adds prompt=select_account and no login", () => {
    const url = authorizeUrl({ ...base, signIn: { kind: "first" } });
    expect(query(url)).toEqual({
      code_challenge: attempt.codeChallenge,
      code_challenge_method: "S256",
      redirect_uri: base.redirectUri,
      state: attempt.state,
      prompt: "select_account",
    });
    expect(GitHubAuthorizeQuerySchema.parse(query(url))).toEqual(query(url));
  });

  test("a repeated sign-in adds the login and no prompt", () => {
    const url = authorizeUrl({
      ...base,
      signIn: { kind: "repeated", login: "octo-cat_1" },
    });
    expect(query(url)).toEqual({
      code_challenge: attempt.codeChallenge,
      code_challenge_method: "S256",
      redirect_uri: base.redirectUri,
      state: attempt.state,
      login: "octo-cat_1",
    });
    expect(GitHubAuthorizeQuerySchema.parse(query(url))).toEqual(query(url));
  });

  test("after device_account_mismatch it adds prompt=select_account, with the held login when given", () => {
    const without = authorizeUrl({
      ...base,
      signIn: { kind: "after_account_mismatch" },
    });
    expect(query(without).prompt).toBe("select_account");
    expect(query(without)).not.toHaveProperty("login");
    expect(GitHubAuthorizeQuerySchema.parse(query(without))).toEqual(
      query(without),
    );

    const withLogin = authorizeUrl({
      ...base,
      signIn: { kind: "after_account_mismatch", login: "octocat" },
    });
    expect(query(withLogin)).toMatchObject({
      login: "octocat",
      prompt: "select_account",
    });
    expect(GitHubAuthorizeQuerySchema.parse(query(withLogin))).toEqual(
      query(withLogin),
    );
  });

  test.each([
    "http://127.0.0.1:3000",
    "http://localhost:3000",
    "http://localhost",
  ])("works with a development API on the loopback origin %s", (apiOrigin) => {
    const url = authorizeUrl({ ...base, apiOrigin, signIn: { kind: "first" } });
    expect(url.startsWith(`${apiOrigin}/auth/github/authorize?`)).toBe(true);
    expect(GitHubAuthorizeQuerySchema.safeParse(query(url)).success).toBe(true);
  });

  test("never carries the verifier", () => {
    const url = authorizeUrl({ ...base, signIn: { kind: "first" } });
    expect(url).not.toContain(attempt.codeVerifier);
  });

  test.each([
    ["https://api.mymandev.example/", "Invalid API origin"],
    ["https://api.mymandev.example/v1", "Invalid API origin"],
    ["https://api.mymandev.example:443", "Invalid API origin"],
    ["HTTPS://API.MYMANDEV.EXAMPLE", "Invalid API origin"],
    ["ftp://api.mymandev.example", "Invalid API origin"],
    ["https://user@api.mymandev.example", "Invalid API origin"],
    ["api.mymandev.example", "Invalid API origin"],
    // http only on a loopback host, as the API's configuration requires.
    ["http://api.mymandev.example", "Invalid API origin"],
    ["http://api.mymandev.example:3000", "Invalid API origin"],
    ["http://192.168.1.10:3000", "Invalid API origin"],
    ["http://127.0.0.2:3000", "Invalid API origin"],
    ["http://localhost.example:3000", "Invalid API origin"],
    ["http://127.1:3000", "Invalid API origin"],
  ])("refuses the API origin %j", (apiOrigin, message) => {
    expect(() =>
      authorizeUrl({ ...base, apiOrigin, signIn: { kind: "first" } }),
    ).toThrow(new TypeError(message));
  });

  test.each([
    ["redirect_uri", { redirectUri: "http://localhost:49152/callback" }],
    ["redirect_uri", { redirectUri: "http://127.0.0.1:80/callback" }],
    ["redirect_uri", { redirectUri: "http://127.0.0.1:49152/other" }],
    ["redirect_uri", { redirectUri: "https://127.0.0.1:49152/callback" }],
    ["code_challenge", { codeChallenge: "plain-verifier" }],
    ["state", { state: `${attempt.state}x` }],
    ["state", { state: "" }],
  ])("refuses an invalid %s and names only the field", (field, change) => {
    const input = { ...base, ...change, signIn: { kind: "first" } as const };
    let error: unknown;
    try {
      authorizeUrl(input);
    } catch (caught) {
      error = caught;
    }
    expect(error).toEqual(
      new TypeError(`Invalid authorize parameter ${field}`),
    );
    const value = Object.values(change)[0] ?? "";
    if (value !== "") {
      expect(String(error)).not.toContain(value);
    }
  });

  test.each(["", "octo cat", "a".repeat(40), "octo.cat", "octo\ncat"])(
    "refuses the login %j",
    (login) => {
      expect(() =>
        authorizeUrl({ ...base, signIn: { kind: "repeated", login } }),
      ).toThrow(new TypeError("Invalid authorize parameter login"));
    },
  );

  test("refuses an unknown sign-in kind", () => {
    expect(() =>
      authorizeUrl({
        ...base,
        signIn: { kind: "other" } as unknown as AuthorizeUrlInput["signIn"],
      }),
    ).toThrow(new TypeError("Invalid sign-in kind"));
  });
});
