import { AUTH_ROUTES } from "@mymandev/protocol";
import { describe, expect, test } from "vitest";
import type { ScheduleTimer } from "../runtime.ts";
import {
  API_REQUEST_TIMEOUT_MS,
  type ApiFetch,
  callApi,
  MAX_API_ANSWER_BYTES,
} from "./api-call.ts";

const ORIGIN = "https://api.mymandev.example";

interface Sent {
  readonly url: string;
  readonly init: RequestInit;
}

function harness(answer: (sent: Sent) => Promise<Response>) {
  const sent: Sent[] = [];
  const timers: { delayMs: number; callback: () => void }[] = [];
  const scheduleTimer: ScheduleTimer = (callback, delayMs) => {
    const timer = { delayMs, callback };
    timers.push(timer);
    return () => {
      const index = timers.indexOf(timer);
      if (index >= 0) {
        timers.splice(index, 1);
      }
    };
  };
  const fetch: ApiFetch = (url, init) => {
    const entry = { url, init };
    sent.push(entry);
    return answer(entry);
  };
  return { sent, timers, fetch, scheduleTimer };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("callApi", () => {
  test("sends JSON with the token, no redirect, and a timeout", async () => {
    const h = harness(() => Promise.resolve(json(200, { a: 1 })));

    const answer = await callApi({
      ...h,
      origin: ORIGIN,
      route: AUTH_ROUTES.revokeDevice,
      path: "/devices/x/revoke",
      accessToken: "mmda_token",
      body: { reason: "removed" },
    });

    expect(answer).toEqual({ kind: "ok", status: 200, value: { a: 1 } });
    const [request] = h.sent;
    expect(request?.url).toBe(`${ORIGIN}/devices/x/revoke`);
    expect(request?.init.method).toBe("POST");
    expect(request?.init.redirect).toBe("error");
    expect(request?.init.body).toBe('{"reason":"removed"}');
    expect(request?.init.cache).toBe("no-store");
    expect(request?.init.credentials).toBe("omit");
    const headers = new Headers(request?.init.headers);
    expect(headers.get("authorization")).toBe("Bearer mmda_token");
    expect(headers.get("content-type")).toBe("application/json");
    // The timer was cancelled after the answer.
    expect(h.timers).toEqual([]);
  });

  test("a path that names another origin is not sent, with or without a token", async () => {
    const h = harness(() => Promise.resolve(json(200, {})));
    for (const path of ["//evil.example/devices", "https://evil.example/x"]) {
      expect(
        await callApi({
          ...h,
          origin: ORIGIN,
          route: AUTH_ROUTES.listDevices,
          path,
          accessToken: "mmda_token",
        }),
      ).toEqual({ kind: "invalid_request" });
    }
    expect(h.sent).toEqual([]);
    expect(h.timers).toEqual([]);
  });

  test("a request without a body sends no content type", async () => {
    const h = harness(() =>
      Promise.resolve(new Response(null, { status: 204 })),
    );
    const answer = await callApi({
      ...h,
      origin: ORIGIN,
      route: AUTH_ROUTES.challenge,
    });
    expect(answer).toEqual({ kind: "ok", status: 204, value: null });
    const headers = new Headers(h.sent[0]?.init.headers);
    expect(headers.get("content-type")).toBeNull();
    expect(headers.get("authorization")).toBeNull();
    expect(h.sent[0]?.init.body).toBeUndefined();
  });

  test("classifies the answers", async () => {
    const cases: [Response | Error, unknown][] = [
      [
        json(401, {
          statusCode: 401,
          error: "Unauthorized",
          message: "Unauthorized",
          code: "unauthorized",
        }),
        { kind: "error", status: 401, code: "unauthorized" },
      ],
      [
        json(500, {
          statusCode: 500,
          error: "Internal Server Error",
          message: "Internal Server Error",
          code: "internal_error",
        }),
        { kind: "server_error" },
      ],
      [
        json(401, {
          statusCode: 409,
          error: "Conflict",
          message: "Conflict",
          code: "conflict",
        }),
        { kind: "unexpected_response" },
      ],
      [
        new Response("<html>", { status: 404 }),
        { kind: "unexpected_response" },
      ],
      [
        new Response("<html>", { status: 200 }),
        { kind: "unexpected_response" },
      ],
      [new Response(null, { status: 302 }), { kind: "unexpected_response" }],
      [new TypeError("fetch failed"), { kind: "no_answer" }],
    ];
    for (const [answer, expected] of cases) {
      const h = harness(() =>
        answer instanceof Error
          ? Promise.reject(answer)
          : Promise.resolve(answer),
      );
      expect(
        await callApi({ ...h, origin: ORIGIN, route: AUTH_ROUTES.listDevices }),
      ).toEqual(expected);
    }
  });

  test("a body over the limit is not read, with or without Content-Length", async () => {
    const declared = harness(() =>
      Promise.resolve(
        new Response("{}", {
          status: 200,
          headers: { "content-length": String(MAX_API_ANSWER_BYTES + 1) },
        }),
      ),
    );
    expect(
      await callApi({
        ...declared,
        origin: ORIGIN,
        route: AUTH_ROUTES.listDevices,
      }),
    ).toEqual({ kind: "unexpected_response" });

    let pulled = 0;
    const streamed = harness(() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulled += 1;
              controller.enqueue(new Uint8Array(64 * 1024).fill(0x20));
            },
          }),
          { status: 200 },
        ),
      ),
    );
    expect(
      await callApi({
        ...streamed,
        origin: ORIGIN,
        route: AUTH_ROUTES.listDevices,
      }),
    ).toEqual({ kind: "unexpected_response" });
    expect(pulled).toBeLessThan(MAX_API_ANSWER_BYTES / (64 * 1024) + 3);
  });

  test("a call's own cap replaces the default, at its exact size", async () => {
    // A JSON string body of exactly `size` bytes.
    const body = (size: number) => `"${" ".repeat(size - 2)}"`;
    const cap = 2 * MAX_API_ANSWER_BYTES;
    const cases: [number, number | undefined, string][] = [
      [MAX_API_ANSWER_BYTES, undefined, "ok"],
      [MAX_API_ANSWER_BYTES + 1, undefined, "unexpected_response"],
      [cap, cap, "ok"],
      [cap + 1, cap, "unexpected_response"],
    ];
    for (const [size, maxAnswerBytes, kind] of cases) {
      for (const declare of [true, false]) {
        const h = harness(() =>
          Promise.resolve(
            new Response(body(size), {
              status: 200,
              headers: declare ? { "content-length": String(size) } : {},
            }),
          ),
        );
        const answer = await callApi({
          ...h,
          origin: ORIGIN,
          route: AUTH_ROUTES.listDevices,
          ...(maxAnswerBytes === undefined ? {} : { maxAnswerBytes }),
        });
        expect(answer.kind, `${size} bytes, cap ${maxAnswerBytes}`).toBe(kind);
      }
    }
  });

  test("the timeout aborts the request", async () => {
    const h = harness(
      (sent) =>
        new Promise((_resolve, reject) => {
          sent.init.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    );
    const pending = callApi({
      ...h,
      origin: ORIGIN,
      route: AUTH_ROUTES.listDevices,
    });
    expect(h.timers.map((timer) => timer.delayMs)).toEqual([
      API_REQUEST_TIMEOUT_MS,
    ]);
    h.timers[0]?.callback();
    expect(await pending).toEqual({ kind: "no_answer" });
  });
});
