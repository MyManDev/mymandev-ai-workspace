import { checkDatabaseUrl } from "@mymandev/database";
import { isDeviceAuthAudience } from "@mymandev/protocol";
import * as z from "zod";
import { Secret } from "./secret.ts";

// Validate the raw string first: Number(" 80"), Number("0x50") and Number("8e1") all return 80.
const DecimalString = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,8})$/, "Expected a decimal integer");

/** True only for an http or https origin written exactly as `scheme://host[:port]`. */
function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.origin === value
    );
  } catch {
    return false;
  }
}

const OriginList = z
  .string()
  .max(2048)
  .transform((value) =>
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ""),
  )
  .pipe(
    z
      .array(
        z
          .string()
          .refine(isOrigin, "Expected an origin such as https://app.example"),
      )
      .max(20),
  );

const LOG_LEVELS = [
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
] as const;

const EnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  // Loopback only; widening it is part of the hosting decision (#96).
  API_HOST: z.enum(["127.0.0.1", "::1", "localhost"]).default("127.0.0.1"),
  API_PORT: DecimalString.default("3000")
    .transform(Number)
    .pipe(z.number().int().min(0).max(65_535)),
  API_LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
  API_BODY_LIMIT_BYTES: DecimalString.default("65536")
    .transform(Number)
    .pipe(
      z
        .number()
        .int()
        .min(1)
        .max(10 * 1024 * 1024),
    ),
  // Browser origins allowed to open /ws. Empty: no browser origin is allowed.
  API_ALLOWED_ORIGINS: OriginList.default([]),
  // The API's public origin: the GitHub callback and the audience of device signatures (ADR 0014).
  API_PUBLIC_ORIGIN: z
    .string()
    .max(2048)
    .refine(isOrigin, "Expected an origin such as https://api.example")
    .refine(
      isDeviceAuthAudience,
      "Expected a lowercase origin whose host is a DNS name or a dotted IPv4 address",
    )
    .optional(),
  API_GITHUB_CLIENT_ID: z
    .string()
    .regex(/^[A-Za-z0-9.]{1,64}$/u, "Expected a GitHub App client ID")
    .optional(),
  API_GITHUB_CLIENT_SECRET: z
    .string()
    .regex(/^[A-Za-z0-9_]{20,128}$/u, "Expected a GitHub App client secret")
    .optional(),
  // Checked here without the production rule, so that its issues come with
  // the other variables' issues; production adds sslmode=verify-full below.
  DATABASE_URL: z
    .string()
    .max(4096)
    .superRefine((url, ctx) => {
      const problem = checkDatabaseUrl(url, false);
      if (problem !== undefined) {
        ctx.addIssue({ code: "custom", message: problem });
      }
    })
    .optional(),
});

type Env = z.infer<typeof EnvSchema>;

export type LogLevel = (typeof LOG_LEVELS)[number];

/** The API configuration. Loaded once at startup and never changed. */
export type Config = Readonly<{
  nodeEnv: Env["NODE_ENV"];
  /** Loopback only; widening it is part of the hosting decision (#96). */
  host: Env["API_HOST"];
  port: number;
  logLevel: LogLevel;
  bodyLimitBytes: number;
  /** Browser origins allowed to open the WebSocket gateway. */
  allowedOrigins: readonly string[];
  /** GitHub sign-in (ADR 0014); null when it is disabled, which only development and test allow. */
  githubSignIn: Readonly<{
    /** The API's public origin, exactly as configured. */
    publicOrigin: string;
    clientId: string;
    clientSecret: Secret;
  }> | null;
  /** The PostgreSQL connection URL; null when the database is disabled, which only development and test allow. */
  databaseUrl: Secret | null;
}>;

/** Invalid configuration. Each issue names the variable and never contains its value. */
export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(
      ["Invalid configuration:", ...issues.map((issue) => `  ${issue}`)].join(
        "\n",
      ),
    );
    this.name = "ConfigError";
    this.issues = Object.freeze([...issues]);
  }
}

/**
 * Reads the API configuration from environment variables. Only the known
 * variables are read, and an empty string counts as unset. Throws
 * `ConfigError` when a variable is invalid.
 */
export function loadConfig(
  env: Readonly<Record<string, string | undefined>>,
): Config {
  const raw: Record<string, string> = {};
  for (const key of Object.keys(EnvSchema.shape)) {
    const value = env[key];
    if (value !== undefined && value !== "") {
      raw[key] = value;
    }
  }
  const result = EnvSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map(
        (issue) => `${issue.path.join(".")}: ${issue.message}`,
      ),
    );
  }
  const values = result.data;
  const issues = crossChecks(values);
  if (issues.length > 0) {
    throw new ConfigError(issues);
  }
  return Object.freeze({
    nodeEnv: values.NODE_ENV,
    host: values.API_HOST,
    port: values.API_PORT,
    logLevel: values.API_LOG_LEVEL,
    bodyLimitBytes: values.API_BODY_LIMIT_BYTES,
    allowedOrigins: Object.freeze([...values.API_ALLOWED_ORIGINS]),
    githubSignIn:
      values.API_PUBLIC_ORIGIN !== undefined &&
      values.API_GITHUB_CLIENT_ID !== undefined &&
      values.API_GITHUB_CLIENT_SECRET !== undefined
        ? Object.freeze({
            publicOrigin: values.API_PUBLIC_ORIGIN,
            clientId: values.API_GITHUB_CLIENT_ID,
            clientSecret: new Secret(values.API_GITHUB_CLIENT_SECRET),
          })
        : null,
    databaseUrl:
      values.DATABASE_URL === undefined
        ? null
        : new Secret(values.DATABASE_URL),
  });
}

const GITHUB_SIGN_IN_VARIABLES = [
  "API_PUBLIC_ORIGIN",
  "API_GITHUB_CLIENT_ID",
  "API_GITHUB_CLIENT_SECRET",
] as const;

const LOOPBACK_ORIGIN = new RegExp(
  "^http://(?:127[.]0[.]0[.]1|localhost)(?::[0-9]+)?$",
  "u",
);

/** Rules between variables. Each issue names a variable and never contains a value. */
function crossChecks(values: Env): string[] {
  const issues: string[] = [];
  const production = values.NODE_ENV === "production";
  const origin = values.API_PUBLIC_ORIGIN;
  if (
    origin !== undefined &&
    !origin.startsWith("https://") &&
    (production || !LOOPBACK_ORIGIN.test(origin))
  ) {
    issues.push(
      "API_PUBLIC_ORIGIN: must use https, except in development and test with a loopback host",
    );
  }
  const signInSet = GITHUB_SIGN_IN_VARIABLES.filter(
    (name) => values[name] !== undefined,
  );
  for (const name of GITHUB_SIGN_IN_VARIABLES) {
    if (values[name] !== undefined) {
      continue;
    }
    if (production) {
      issues.push(`${name}: is required with NODE_ENV=production`);
    } else if (signInSet.length > 0) {
      issues.push(
        `${name}: is required with ${signInSet.join(" and ")}; set all three or none`,
      );
    }
  }
  if (values.DATABASE_URL === undefined) {
    if (production) {
      issues.push("DATABASE_URL: is required with NODE_ENV=production");
    }
  } else if (production) {
    const problem = checkDatabaseUrl(values.DATABASE_URL, true);
    if (problem !== undefined) {
      issues.push(`DATABASE_URL: ${problem}`);
    }
  }
  return issues;
}
