import { API_ERROR_STATUS, type ApiErrorCode } from "@mymandev/protocol";

/**
 * An error that a route raises on purpose. The error handler answers with
 * the code's fixed status from `API_ERROR_STATUS`, the status text as
 * `error` and `message`, and the code (ADR 0014, P-66). The message of this
 * object is the code itself and is never sent.
 */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly statusCode: number;

  constructor(code: ApiErrorCode) {
    super(code);
    this.name = "ApiError";
    this.code = code;
    this.statusCode = API_ERROR_STATUS[code];
  }
}
