import assert from "node:assert/strict";
import { test } from "node:test";
import { inspect } from "node:util";
import { ConfigError, loadConfig } from "./config.ts";

/** Returns the issues of the ConfigError that `loadConfig(env)` throws. */
function issuesFor(env: Record<string, string>): readonly string[] {
  try {
    loadConfig(env);
  } catch (error) {
    assert.ok(error instanceof ConfigError);
    return error.issues;
  }
  assert.fail(`Expected ${JSON.stringify(env)} to be rejected`);
}

test("defaults apply when no variable is set", () => {
  assert.deepEqual(loadConfig({}), {
    nodeEnv: "development",
    host: "127.0.0.1",
    port: 3000,
    logLevel: "info",
    bodyLimitBytes: 65_536,
    allowedOrigins: [],
    githubSignIn: null,
    databaseUrl: null,
  });
});

test("known variables are read, empty strings count as unset, other variables are ignored, and the result is frozen", () => {
  const config = loadConfig({
    NODE_ENV: "production",
    API_HOST: "localhost",
    API_PORT: "8080",
    API_LOG_LEVEL: "warn",
    API_BODY_LIMIT_BYTES: "1024",
    API_ALLOWED_ORIGINS: "https://app.example",
    API_PUBLIC_ORIGIN: "https://api.example",
    API_GITHUB_CLIENT_ID: "Iv23liExampleClient1",
    API_GITHUB_CLIENT_SECRET: "0123456789abcdef0123456789abcdef01234567",
    DATABASE_URL: "postgres://api:pw@db.example/mymandev?sslmode=verify-full",
    API_UNKNOWN: "ignored",
    PATH: "/usr/bin",
  });
  const { githubSignIn, databaseUrl, ...plain } = config;
  assert.deepEqual(plain, {
    nodeEnv: "production",
    host: "localhost",
    port: 8080,
    logLevel: "warn",
    bodyLimitBytes: 1024,
    allowedOrigins: ["https://app.example"],
  });
  assert.equal(githubSignIn?.publicOrigin, "https://api.example");
  assert.equal(githubSignIn?.clientId, "Iv23liExampleClient1");
  assert.equal(
    githubSignIn?.clientSecret.reveal(),
    "0123456789abcdef0123456789abcdef01234567",
  );
  assert.equal(
    databaseUrl?.reveal(),
    "postgres://api:pw@db.example/mymandev?sslmode=verify-full",
  );
  assert.ok(Object.isFrozen(githubSignIn));
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.allowedOrigins));
  assert.equal("API_UNKNOWN" in config, false);

  const empty = loadConfig({
    NODE_ENV: "",
    API_HOST: "",
    API_PORT: "",
    API_LOG_LEVEL: "",
    API_BODY_LIMIT_BYTES: "",
    API_ALLOWED_ORIGINS: "",
  });
  assert.deepEqual(empty, loadConfig({}));
  assert.equal(loadConfig({ API_PORT: "0" }).port, 0);
  assert.equal(loadConfig({ API_PORT: "65535" }).port, 65_535);
});

test("numbers must be plain decimal integers in range, and enums must be known", () => {
  for (const value of [
    "80.5",
    "0x50",
    "8e1",
    " 80",
    "true",
    "-1",
    "65536",
    "080",
    "1_000",
  ]) {
    const issues = issuesFor({ API_PORT: value });
    assert.equal(issues.length, 1, value);
    assert.match(issues[0] ?? "", /^API_PORT: /u, value);
  }
  assert.match(
    issuesFor({ API_BODY_LIMIT_BYTES: "0" }).join("\n"),
    /^API_BODY_LIMIT_BYTES: /u,
  );
  assert.match(
    issuesFor({ API_BODY_LIMIT_BYTES: "10485761" }).join("\n"),
    /^API_BODY_LIMIT_BYTES: /u,
  );
  assert.match(issuesFor({ NODE_ENV: "staging" }).join("\n"), /^NODE_ENV: /u);
  assert.match(
    issuesFor({ API_LOG_LEVEL: "loud" }).join("\n"),
    /^API_LOG_LEVEL: /u,
  );
});

test("API_HOST is loopback only and API_ALLOWED_ORIGINS accepts only exact http and https origins", () => {
  for (const value of ["0.0.0.0", "::", "192.168.1.10", "example.com"]) {
    assert.match(issuesFor({ API_HOST: value }).join("\n"), /^API_HOST: /u);
  }
  assert.equal(loadConfig({ API_HOST: "::1" }).host, "::1");

  assert.deepEqual(
    loadConfig({
      API_ALLOWED_ORIGINS: "https://app.example, http://localhost:5173,",
    }).allowedOrigins,
    ["https://app.example", "http://localhost:5173"],
  );
  for (const value of [
    "https://app.example/",
    "https://app.example/path",
    "file://",
    "null",
    "*",
    "app://desktop",
  ]) {
    assert.match(
      issuesFor({ API_ALLOWED_ORIGINS: `https://ok.example,${value}` }).join(
        "\n",
      ),
      /^API_ALLOWED_ORIGINS\.1: /u,
      value,
    );
  }
  const tooMany = Array.from(
    { length: 21 },
    (_, index) => `https://app${index}.example`,
  ).join(",");
  assert.match(
    issuesFor({ API_ALLOWED_ORIGINS: tooMany }).join("\n"),
    /^API_ALLOWED_ORIGINS: /u,
  );
});

test("errors name every invalid variable and never contain a value", () => {
  const secret = "hunter2-SECRET-db-password";
  const env = {
    NODE_ENV: secret,
    API_HOST: secret,
    API_PORT: secret,
    API_LOG_LEVEL: secret,
    API_BODY_LIMIT_BYTES: secret,
    API_ALLOWED_ORIGINS: `https://${secret}.example/${secret}`,
  };
  let caught: unknown;
  try {
    loadConfig(env);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof ConfigError);
  for (const name of Object.keys(env)) {
    assert.match(caught.message, new RegExp(`^  ${name}[.:]`, "mu"), name);
  }
  for (const text of [
    caught.message,
    caught.stack ?? "",
    caught.issues.join("\n"),
    JSON.stringify(caught),
    String(caught),
  ]) {
    assert.equal(text.includes(secret), false, text);
  }
});

const SIGN_IN = {
  API_PUBLIC_ORIGIN: "https://api.example",
  API_GITHUB_CLIENT_ID: "Iv23liExampleClient1",
  API_GITHUB_CLIENT_SECRET: "0123456789abcdef0123456789abcdef01234567",
} as const;

test("GitHub sign-in needs all three variables, and production needs every variable", () => {
  assert.equal(loadConfig({}).githubSignIn, null);
  assert.equal(loadConfig({ NODE_ENV: "test" }).databaseUrl, null);
  assert.notEqual(loadConfig(SIGN_IN).githubSignIn, null);

  const partial = issuesFor({
    API_PUBLIC_ORIGIN: SIGN_IN.API_PUBLIC_ORIGIN,
  });
  assert.equal(partial.length, 2);
  assert.match(
    partial[0] ?? "",
    /^API_GITHUB_CLIENT_ID: is required with API_PUBLIC_ORIGIN;/u,
  );
  assert.match(partial[1] ?? "", /^API_GITHUB_CLIENT_SECRET: /u);

  const production = issuesFor({ NODE_ENV: "production" });
  assert.deepEqual(
    production.map((issue) => issue.split(":")[0]),
    [
      "API_PUBLIC_ORIGIN",
      "API_GITHUB_CLIENT_ID",
      "API_GITHUB_CLIENT_SECRET",
      "DATABASE_URL",
    ],
  );
  for (const issue of production) {
    assert.match(issue, /: is required with NODE_ENV=production$/u);
  }
});

test("API_PUBLIC_ORIGIN uses https, except a loopback http origin in development and test", () => {
  for (const nodeEnv of ["development", "test"]) {
    for (const origin of [
      "http://127.0.0.1:3000",
      "http://localhost:3000",
      "https://api.example",
    ]) {
      assert.equal(
        loadConfig({ ...SIGN_IN, NODE_ENV: nodeEnv, API_PUBLIC_ORIGIN: origin })
          .githubSignIn?.publicOrigin,
        origin,
        `${nodeEnv} ${origin}`,
      );
    }
  }
  const rejected: [env: Record<string, string>, label: string][] = [
    [{ API_PUBLIC_ORIGIN: "http://api.example" }, "http on a public host"],
    [
      { API_PUBLIC_ORIGIN: "http://192.168.1.10:3000" },
      "http on a private address",
    ],
    [{ API_PUBLIC_ORIGIN: "https://api.example/" }, "trailing slash"],
    [{ API_PUBLIC_ORIGIN: "https://API.example" }, "uppercase host"],
    [{ API_PUBLIC_ORIGIN: "https://api.example:443" }, "default port"],
    [{ API_PUBLIC_ORIGIN: "http://127.1:3000" }, "short IPv4 form"],
    [{ API_PUBLIC_ORIGIN: "http://[::1]:3000" }, "IPv6 loopback"],
    [{ API_PUBLIC_ORIGIN: "wss://api.example" }, "WebSocket scheme"],
  ];
  for (const [env, label] of rejected) {
    assert.match(
      issuesFor({ ...SIGN_IN, ...env }).join("\n"),
      /^API_PUBLIC_ORIGIN: /u,
      label,
    );
  }
  assert.match(
    issuesFor({
      ...SIGN_IN,
      NODE_ENV: "production",
      API_PUBLIC_ORIGIN: "http://127.0.0.1:3000",
      DATABASE_URL: "postgres://api:pw@db.example/mymandev?sslmode=verify-full",
    }).join("\n"),
    /^API_PUBLIC_ORIGIN: must use https/u,
  );
  for (const [name, value] of [
    ["API_GITHUB_CLIENT_ID", "client id"],
    ["API_GITHUB_CLIENT_SECRET", "short"],
    ["API_GITHUB_CLIENT_SECRET", "has space 0123456789abcdef0123456789"],
  ] as const) {
    assert.match(
      issuesFor({ ...SIGN_IN, [name]: value }).join("\n"),
      new RegExp(`^${name}: `, "u"),
      value,
    );
  }
});

test("DATABASE_URL follows the database package's rules", () => {
  assert.equal(
    loadConfig({
      DATABASE_URL: "postgres://api:pw@127.0.0.1/mymandev",
    }).databaseUrl?.reveal(),
    "postgres://api:pw@127.0.0.1/mymandev",
  );
  for (const [env, label] of [
    [{ DATABASE_URL: "mysql://api:pw@127.0.0.1/mymandev" }, "scheme"],
    [
      { DATABASE_URL: "postgres://api:pw@127.0.0.1/mymandev?sslmode=require" },
      "sslmode",
    ],
    [
      {
        ...SIGN_IN,
        NODE_ENV: "production",
        DATABASE_URL: "postgres://api:pw@db.example/mymandev?sslmode=disable",
      },
      "production without verify-full",
    ],
  ] as const) {
    assert.match(issuesFor(env).join("\n"), /^DATABASE_URL: /mu, label);
  }
});

test("secret values never appear in errors, JSON, strings, or inspection", () => {
  const secret = "SECRETvalue0123456789abcdef0123456789ab";
  const password = "hunter2-db-password";
  const config = loadConfig({
    ...SIGN_IN,
    API_GITHUB_CLIENT_SECRET: secret,
    DATABASE_URL: `postgres://api:${password}@127.0.0.1/mymandev`,
  });
  for (const text of [
    JSON.stringify(config),
    inspect(config, { depth: 10 }),
    String(config.githubSignIn?.clientSecret),
    `${config.databaseUrl}`,
    inspect(config.databaseUrl),
  ]) {
    assert.equal(text.includes(secret), false, text);
    assert.equal(text.includes(password), false, text);
    assert.match(text, /redacted/u);
  }

  let caught: unknown;
  try {
    loadConfig({
      ...SIGN_IN,
      API_GITHUB_CLIENT_SECRET: `${secret} with a space`,
      DATABASE_URL: `postgres://api:${password}@127.0.0.1/mymandev?sslmode=prefer`,
    });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof ConfigError);
  for (const text of [
    caught.message,
    caught.stack ?? "",
    JSON.stringify(caught),
    String(caught),
  ]) {
    assert.equal(text.includes(secret), false, text);
    assert.equal(text.includes(password), false, text);
  }
  assert.match(caught.message, /API_GITHUB_CLIENT_SECRET: /u);
  assert.match(caught.message, /DATABASE_URL: /u);
});
