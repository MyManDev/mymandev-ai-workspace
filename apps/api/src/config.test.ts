import assert from "node:assert/strict";
import { test } from "node:test";
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
    API_UNKNOWN: "ignored",
    PATH: "/usr/bin",
  });
  assert.deepEqual(config, {
    nodeEnv: "production",
    host: "localhost",
    port: 8080,
    logLevel: "warn",
    bodyLimitBytes: 1024,
    allowedOrigins: ["https://app.example"],
  });
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
