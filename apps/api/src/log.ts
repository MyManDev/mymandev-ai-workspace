import type { FastifyRequest } from "fastify";

/** Logs the path without the query string, so a token in a URL never reaches the logs. */
export function serializeRequest(request: FastifyRequest) {
  return {
    method: request.method,
    url: request.url.split("?", 1)[0],
    remoteAddress: request.ip,
  };
}

/** Own keys of driver and ORM errors that carry SQL, query parameters or row details. */
const QUERY_DATA_KEYS = ["query", "params", "detail"];

function carriesQueryData(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    QUERY_DATA_KEYS.some((key) => key in value)
  );
}

/**
 * Allowlist error serializer. An error that may carry SQL, query parameters or
 * row details (Drizzle and driver errors) is logged without message and stack,
 * because their message itself contains the parameter values.
 */
export function serializeError(
  error: unknown,
  depth = 0,
): {
  type: string;
  message: string;
  stack: string;
  [key: string]: unknown;
} {
  if (!(error instanceof Error)) {
    return { type: typeof error, message: "", stack: "" };
  }
  const fields = error as Error & { code?: unknown; statusCode?: unknown };
  const redact = carriesQueryData(error) || carriesQueryData(error.cause);
  return {
    type: error.name,
    code: typeof fields.code === "string" ? fields.code : undefined,
    statusCode:
      typeof fields.statusCode === "number" ? fields.statusCode : undefined,
    message: redact ? "[redacted: may contain query data]" : error.message,
    stack: redact ? "" : (error.stack ?? ""),
    cause:
      error.cause === undefined || depth >= 2
        ? undefined
        : serializeError(error.cause, depth + 1),
  };
}
