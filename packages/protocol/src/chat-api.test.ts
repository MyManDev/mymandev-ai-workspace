import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as z from "zod";
import { routePath } from "./auth-api.ts";
import {
  CHAT_ROUTE_ERRORS,
  CHAT_ROUTES,
  ChatHistoryQuerySchema,
  ChatHistoryResponseSchema,
} from "./chat-api.ts";
import { API_ERROR_CODES, CHAT_HISTORY_PAGE } from "./model.ts";

const PROJECT_ID = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192b1";
const OTHER_PROJECT_ID = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192b2";
const MEMBER_ID = "0192f2a0-7c3e-7d2e-9f10-112233445502";
const AGENT_ID = "0192f2a0-7c3e-7e00-8000-000000000005";
const NOW = "2026-11-02T12:00:00.000Z";

/** The codes that every route can answer, as for the membership routes. */
const COMMON_CODES: readonly string[] = [
  "bad_request",
  "unauthorized",
  "rate_limited",
  "internal_error",
];

/** The message with `seq`, the newest of a page when `seq` is the highest. */
function message(seq: number, fields: Record<string, unknown> = {}) {
  return {
    id: `0192f2a0-7c3e-7b00-8000-${seq.toString(16).padStart(12, "0")}`,
    projectId: PROJECT_ID,
    seq,
    author: { kind: "member", memberId: MEMBER_ID },
    body: `Message ${seq}`,
    createdAt: NOW,
    ...fields,
  };
}

/** A page of `count` messages, the newest first, from `count` down to 1. */
function page(count: number) {
  return {
    messages: Array.from({ length: count }, (_, index) =>
      message(count - index),
    ),
  };
}

test("the chat route is fixed, frozen, and reads a project's history", () => {
  assert.deepEqual(
    Object.values(CHAT_ROUTES).map((route) => `${route.method} ${route.path}`),
    ["GET /projects/:projectId/messages"],
  );
  assert.equal(Object.isFrozen(CHAT_ROUTES), true);
  assert.equal(Object.isFrozen(CHAT_ROUTES.listMessages), true);
  assert.equal(
    routePath(CHAT_ROUTES.listMessages.path, { projectId: PROJECT_ID }),
    `/projects/${PROJECT_ID}/messages`,
  );
  for (const projectId of ["not-a-uuid", PROJECT_ID.toUpperCase(), ""]) {
    assert.throws(
      () => routePath(CHAT_ROUTES.listMessages.path, { projectId }),
      TypeError,
      projectId,
    );
  }
});

test("the chat route answers the common codes and not_found, frozen", () => {
  assert.deepEqual(Object.keys(CHAT_ROUTE_ERRORS), Object.keys(CHAT_ROUTES));
  assert.deepEqual(CHAT_ROUTE_ERRORS.listMessages, [
    ...COMMON_CODES,
    "not_found",
  ]);
  const known = new Set<string>(API_ERROR_CODES);
  for (const code of CHAT_ROUTE_ERRORS.listMessages) {
    assert.equal(known.has(code), true, code);
  }
  assert.equal(Object.isFrozen(CHAT_ROUTE_ERRORS), true);
  assert.equal(Object.isFrozen(CHAT_ROUTE_ERRORS.listMessages), true);
});

test("the history query takes an optional beforeSeq and a limit from 1 to 100, 50 by default", () => {
  const accepted: [label: string, query: unknown, parsed: unknown][] = [
    ["nothing", {}, { limit: 50 }],
    ["a limit of 1", { limit: "1" }, { limit: 1 }],
    ["the largest limit", { limit: "100" }, { limit: 100 }],
    ["a cursor", { beforeSeq: "51" }, { beforeSeq: 51, limit: 50 }],
    [
      "the largest cursor",
      { beforeSeq: String(Number.MAX_SAFE_INTEGER) },
      { beforeSeq: Number.MAX_SAFE_INTEGER, limit: 50 },
    ],
    ["an unknown field", { limit: "10", after: "3" }, { limit: 10 }],
  ];
  for (const [label, query, parsed] of accepted) {
    const result = ChatHistoryQuerySchema.safeParse(query);
    assert.ok(result.success, label);
    assert.deepEqual(result.data, parsed, label);
  }
  assert.equal(CHAT_HISTORY_PAGE.default, 50);
  assert.equal(CHAT_HISTORY_PAGE.max, 100);

  // A query value is a string; only the plain decimal form is a number.
  const refused: [label: string, query: unknown][] = [
    ["a limit of 0", { limit: "0" }],
    ["a limit over the maximum", { limit: "101" }],
    ["a negative limit", { limit: "-1" }],
    ["a fractional limit", { limit: "1.5" }],
    ["a leading zero", { limit: "050" }],
    ["an exponent", { limit: "1e2" }],
    ["white space", { limit: " 5" }],
    ["a sign", { limit: "+5" }],
    ["a hexadecimal value", { limit: "0x10" }],
    ["an empty value", { limit: "" }],
    ["a number instead of the query string", { limit: 5 }],
    ["a repeated key", { limit: ["5", "6"] }],
    ["a cursor of 0", { beforeSeq: "0" }],
    ["a cursor beyond the safe integers", { beforeSeq: "9007199254740992" }],
    ["a cursor of 17 digits", { beforeSeq: "10000000000000000" }],
    ["a cursor that is not a number", { beforeSeq: "latest" }],
  ];
  for (const [label, query] of refused) {
    assert.equal(ChatHistoryQuerySchema.safeParse(query).success, false, label);
  }
});

test("a history page holds up to 100 messages of one project, each once, the newest first", () => {
  for (const count of [
    0,
    1,
    CHAT_HISTORY_PAGE.default,
    CHAT_HISTORY_PAGE.max,
  ]) {
    assert.equal(
      ChatHistoryResponseSchema.safeParse(page(count)).success,
      true,
      String(count),
    );
  }
  // A later page: the messages before a cursor need not end at 1.
  assert.equal(
    ChatHistoryResponseSchema.safeParse({
      messages: [message(90), message(80), message(12)],
    }).success,
    true,
  );
  // A message by an agent is listed like one by a person.
  assert.equal(
    ChatHistoryResponseSchema.safeParse({
      messages: [
        message(2, { author: { kind: "agent", agentId: AGENT_ID } }),
        message(1),
      ],
    }).success,
    true,
  );

  const refused: [label: string, value: unknown][] = [
    ["over the page maximum", page(CHAT_HISTORY_PAGE.max + 1)],
    ["the oldest first", { messages: [message(1), message(2)] }],
    ["a message twice", { messages: [message(2), message(2)] }],
    [
      "two projects",
      {
        messages: [message(2), message(1, { projectId: OTHER_PROJECT_ID })],
      },
    ],
    ["a message without seq", { messages: [message(1, { seq: undefined })] }],
    ["a message with seq 0", { messages: [message(0)] }],
    [
      "a message without an author",
      { messages: [message(1, { author: undefined })] },
    ],
    [
      "the author as a person ID",
      { messages: [message(1, { author: MEMBER_ID })] },
    ],
    [
      "a body over the limit",
      { messages: [message(1, { body: "a".repeat(16_001) })] },
    ],
    ["no list", {}],
  ];
  for (const [label, value] of refused) {
    assert.equal(
      ChatHistoryResponseSchema.safeParse(value).success,
      false,
      label,
    );
  }
});

test("the history schemas export to JSON Schema for documentation", () => {
  for (const schema of [ChatHistoryQuerySchema, ChatHistoryResponseSchema]) {
    const json = z.toJSONSchema(schema, { io: "input" });
    assert.equal(typeof json, "object");
  }
});

test("the README's table lists the chat route with its codes", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const rows = readme
    .split("\n")
    .filter((line) => line.startsWith("| `GET /projects/"))
    .map((line) => line.split("|").map((cell) => cell.trim()));
  for (const [name, route] of Object.entries(CHAT_ROUTES)) {
    const row = rows.find(
      (cells) => cells[1] === `\`${route.method} ${route.path}\``,
    );
    assert.ok(row, `${name} is not in the README`);
    assert.equal(row.length, 7, name);
    const codes = [...(row[5] ?? "").matchAll(/`([a-z_]+)`/gu)].map(
      (match) => match[1],
    );
    assert.deepEqual(
      codes,
      CHAT_ROUTE_ERRORS[name as keyof typeof CHAT_ROUTES].filter(
        (code) => !COMMON_CODES.includes(code),
      ),
      name,
    );
  }
});
