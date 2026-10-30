import { API_ERROR_STATUS, type ApiErrorCode } from "@mymandev/protocol";

/**
 * An error that a route raises on purpose. The error handler answers with
 * the code's fixed status from `API_ERROR_STATUS`, the status text as
 * `error` and `message`, and the code (ADR 0014, P-66). The message of this
 * object is the code itself and is never sent. A limit passes
 * `retryAfterSeconds`, which the answer sends as `Retry-After` (P-64).
 */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly statusCode: number;
  readonly retryAfterSeconds: number | undefined;

  constructor(
    code: ApiErrorCode,
    options: Readonly<{ retryAfterSeconds?: number }> = {},
  ) {
    super(code);
    this.name = "ApiError";
    this.code = code;
    this.statusCode = API_ERROR_STATUS[code];
    this.retryAfterSeconds =
      options.retryAfterSeconds === undefined
        ? undefined
        : Math.max(1, Math.ceil(options.retryAfterSeconds));
  }
}
