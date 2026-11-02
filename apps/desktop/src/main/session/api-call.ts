// One HTTP call to the API from the main process (ADR 0014, "Storage and
// transport on the device"): the injected `fetch` (Electron's `net.fetch` in
// production, which follows the system proxy settings), no redirect, a
// timeout, and a bounded read of the answer. The answer is classified
// without trusting it, and nothing of the request or the answer is logged.
import {
  type ApiErrorCode,
  ApiErrorBodySchema,
  type ApiRoute,
} from "@mymandev/protocol";
import type { ScheduleTimer } from "../runtime.ts";

/** How long one request may take before the call stops waiting. */
export const API_REQUEST_TIMEOUT_MS = 30_000;

/**
 * An answer body larger than this many bytes is not read as an answer of the
 * API. The device list may hold up to 1,000 devices, so this is larger than
 * the limit of the sign-in flow.
 */
export const MAX_API_ANSWER_BYTES = 512 * 1024;

/** The `fetch` that the session uses; production passes Electron's `net.fetch`. */
export type ApiFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * What the API answered, read without trusting it:
 *
 * - `ok`: a `2xx`. `value` is the parsed JSON body, or null for an empty body
 *   (`204`).
 * - `error`: a `4xx` with the API's error body whose status fits it. Only
 *   this answer is certain: the API refused and committed nothing.
 * - `server_error`: a `5xx`. The API may have committed before it failed.
 * - `unexpected_response`: any other answer, for example from a proxy, a
 *   body too large, or a body that is not JSON.
 * - `no_answer`: a network error, a refused redirect, or the timeout.
 * - `invalid_request`: the URL of the request is not on the API origin;
 *   nothing was sent.
 */
export type ApiAnswer =
  | { readonly kind: "ok"; readonly status: number; readonly value: unknown }
  | {
      readonly kind: "error";
      readonly status: number;
      readonly code: ApiErrorCode;
    }
  | { readonly kind: "server_error" }
  | { readonly kind: "unexpected_response" }
  | { readonly kind: "no_answer" }
  | { readonly kind: "invalid_request" };

export interface ApiCall {
  readonly fetch: ApiFetch;
  readonly scheduleTimer: ScheduleTimer;
  /** The API origin, the audience of every signature. */
  readonly origin: string;
  readonly route: ApiRoute;
  /** The route path with its parameters filled (`routePath`); defaults to `route.path`. */
  readonly path?: string;
  /** Sent as `Authorization: Bearer <token>`. */
  readonly accessToken?: string;
  /** Sent as JSON. Without it the request has no body. */
  readonly body?: unknown;
  readonly timeoutMs?: number;
}

/**
 * Reads the body as UTF-8 text, at most `MAX_API_ANSWER_BYTES`: a larger
 * `Content-Length` is refused before reading, and the stream is cancelled
 * once it passes the limit. Null for a body that is too large or not UTF-8.
 * Rejects when the body cannot be read, like a request without an answer.
 */
async function readBodyText(response: Response): Promise<string | null> {
  const declared = response.headers.get("content-length");
  if (declared !== null && !(Number(declared) <= MAX_API_ANSWER_BYTES)) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  const body = response.body;
  if (body === null) {
    return "";
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > MAX_API_ANSWER_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks),
    );
  } catch {
    return null;
  }
}

async function readAnswer(response: Response): Promise<ApiAnswer> {
  const status = response.status;
  if (status >= 500 && status <= 599) {
    await response.body?.cancel().catch(() => undefined);
    return { kind: "server_error" };
  }
  const text = await readBodyText(response);
  if (text === null) {
    return { kind: "unexpected_response" };
  }
  if (status >= 200 && status <= 299 && text === "") {
    return { kind: "ok", status, value: null };
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return { kind: "unexpected_response" };
  }
  if (status >= 200 && status <= 299) {
    return { kind: "ok", status, value };
  }
  // Only a 4xx with the API's error body means that nothing was committed.
  if (status >= 400 && status <= 499) {
    const parsed = ApiErrorBodySchema.safeParse(value);
    if (parsed.success && parsed.data.statusCode === status) {
      return { kind: "error", status, code: parsed.data.code };
    }
  }
  return { kind: "unexpected_response" };
}

/** Sends one request and classifies the answer. Never rejects. */
export async function callApi(call: ApiCall): Promise<ApiAnswer> {
  let url: URL;
  try {
    url = new URL(call.path ?? call.route.path, call.origin);
  } catch {
    return { kind: "invalid_request" };
  }
  // The token goes only to the API: a path such as `//host/...` would name
  // another origin.
  if (url.origin !== call.origin) {
    return { kind: "invalid_request" };
  }
  const abort = new AbortController();
  const cancelTimeout = call.scheduleTimer(
    () => abort.abort(),
    call.timeoutMs ?? API_REQUEST_TIMEOUT_MS,
  );
  const headers: Record<string, string> = { accept: "application/json" };
  if (call.accessToken !== undefined) {
    headers.authorization = `Bearer ${call.accessToken}`;
  }
  if (call.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  try {
    const response = await call.fetch(url.href, {
      method: call.route.method,
      headers,
      ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
      redirect: "error",
      // No cache and no cookie: every answer is for this request only.
      cache: "no-store",
      credentials: "omit",
      signal: abort.signal,
    });
    return await readAnswer(response);
  } catch {
    return { kind: "no_answer" };
  } finally {
    cancelTimeout();
  }
}
