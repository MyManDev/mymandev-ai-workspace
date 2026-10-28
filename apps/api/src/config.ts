import * as z from "zod";

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
  // Loopback only until authentication exists (M2).
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
});

type Env = z.infer<typeof EnvSchema>;

export type LogLevel = (typeof LOG_LEVELS)[number];

/** The API configuration. Loaded once at startup and never changed. */
export type Config = Readonly<{
  nodeEnv: Env["NODE_ENV"];
  /** Loopback only until authentication exists (M2). */
  host: Env["API_HOST"];
  port: number;
  logLevel: LogLevel;
  bodyLimitBytes: number;
  /** Browser origins allowed to open the WebSocket gateway. */
  allowedOrigins: readonly string[];
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
  return Object.freeze({
    nodeEnv: values.NODE_ENV,
    host: values.API_HOST,
    port: values.API_PORT,
    logLevel: values.API_LOG_LEVEL,
    bodyLimitBytes: values.API_BODY_LIMIT_BYTES,
    allowedOrigins: Object.freeze([...values.API_ALLOWED_ORIGINS]),
  });
}
