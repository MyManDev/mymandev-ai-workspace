import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import * as z from "zod";
import {
  AccessTokenSchema,
  Base64Url32BytesSchema,
  DeviceSignatureSchema,
  GitHubLoginSchema,
  InvitationCodeSchema,
  SignInCodeSchema,
} from "./account.ts";
import {
  LOOPBACK_REDIRECT_URI_PATTERN,
  LoopbackRedirectUriSchema,
} from "./auth-api.ts";
import { decodeClientEvent, decodeEvent } from "./decode.ts";
import {
  ACCESS_TOKEN_PATTERN,
  BASE64URL_32_BYTES_PATTERN,
  DEVICE_AUTH_AUDIENCE_PATTERN,
  DEVICE_PUBLIC_KEY_PATTERN,
  DEVICE_SIGNATURE_PATTERN,
  INVITATION_CODE_PATTERN,
  isDeviceAuthAudience,
  isDevicePublicKey,
  SIGN_IN_CODE_PATTERN,
} from "./device-auth.ts";
import { displayText } from "./entities.ts";
import { envelopeHeaderShape, ProtocolEventSchema } from "./envelope.ts";
import { UserIdSchema } from "./ids.ts";
import {
  EVENT_TYPE_PATTERN,
  GITHUB_LOGIN_PATTERN,
  NOT_BLANK_PATTERN,
  RUN_STATES,
  RUN_TRANSITIONS,
  SAFE_TEXT_PATTERN,
  UUIDV7_PATTERN,
} from "./model.ts";

// Every non-ASCII character in this file is written as an escape.

const EVENT_ID = "0192f0a0-7b3c-7d4e-8f50-000000000001";
const OTHER_EVENT_ID = "0192f0a0-7b3c-7d4e-8f50-000000000002";
const WORKSPACE_ID = "0192f0a0-7b3c-7d4e-8f50-000000000003";
const DEVICE_ID = "0192f0a0-7b3c-7d4e-8f50-000000000004";
const AGENT_ID = "0192f0a0-7b3c-7d4e-8f50-000000000005";
const OTHER_AGENT_ID = "0192f0a0-7b3c-7d4e-8f50-000000000006";
const RUN_ID = "0192f0a0-7b3c-7d4e-8f50-000000000007";
const REPOSITORY_ID = "0192f0a0-7b3c-7d4e-8f50-000000000008";
const USER_ID = "0192f0a0-7b3c-7d4e-8f50-000000000009";
const CORRELATION_ID = "0192f0a0-7b3c-7d4e-8f50-00000000000a";

type Json = Record<string, unknown>;

/** A valid transition that the agent's host device reports. */
function baseEvent(): Json {
  return {
    protocolVersion: 0,
    id: EVENT_ID,
    type: "agent.run.state_changed",
    occurredAt: "2026-10-27T12:34:56.789Z",
    workspaceId: WORKSPACE_ID,
    actor: { kind: "agent", agentId: AGENT_ID },
    deviceId: DEVICE_ID,
    correlationId: CORRELATION_ID,
    causationId: OTHER_EVENT_ID,
    payload: {
      runId: RUN_ID,
      agentId: AGENT_ID,
      repositoryId: REPOSITORY_ID,
      previousState: "queued",
      state: "running",
      reason: "Started on the host device",
    },
  };
}

/** The run creation that only the server emits. */
function serverCreatedRun(): Json {
  return {
    ...baseEvent(),
    actor: { kind: "system" },
    deviceId: null,
    payload: {
      runId: RUN_ID,
      agentId: AGENT_ID,
      previousState: null,
      state: "queued",
    },
  };
}

function withHeader(fields: Json): Json {
  return { ...baseEvent(), ...fields };
}

function withPayload(fields: Json): Json {
  const event = baseEvent();
  return { ...event, payload: { ...(event.payload as Json), ...fields } };
}

function without(key: string): Json {
  const event = baseEvent();
  delete event[key];
  return event;
}

/** Adds own `__proto__`, `constructor` and unknown keys, as JSON.parse creates them. */
function hostile(value: Json): Json {
  const keys =
    '"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"extra":"unknown",';
  return JSON.parse(`{${keys}${JSON.stringify(value).slice(1)}`) as Json;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function collectPatterns(value: unknown, patterns: string[]): string[] {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectPatterns(item, patterns);
    }
  } else if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      if (key === "pattern" && typeof child === "string") {
        patterns.push(child);
      } else {
        collectPatterns(child, patterns);
      }
    }
  }
  return patterns;
}

test("hostile inputs are classified by decoding stage", () => {
  assert.equal(decodeEvent(baseEvent()).ok, true);

  const cases: [label: string, input: unknown, code: string][] = [
    ["null", null, "malformed"],
    ["an array", [baseEvent()], "malformed"],
    ["missing protocolVersion", without("protocolVersion"), "malformed"],
    [
      "protocolVersion as a string",
      withHeader({ protocolVersion: "0" }),
      "malformed",
    ],
    [
      "negative protocolVersion",
      withHeader({ protocolVersion: -1 }),
      "malformed",
    ],
    [
      "protocolVersion 1",
      withHeader({ protocolVersion: 1 }),
      "unsupported_version",
    ],
    [
      "a version 4 UUID as event ID",
      withHeader({ id: "9b2f0e3a-4c5d-4e6f-8a7b-0c1d2e3f4a5b" }),
      "malformed",
    ],
    [
      "an uppercase UUIDv7 as event ID",
      withHeader({ id: EVENT_ID.toUpperCase() }),
      "malformed",
    ],
    [
      "a +02:00 offset",
      withHeader({ occurredAt: "2026-10-27T14:34:56.789+02:00" }),
      "malformed",
    ],
    [
      "a timestamp without milliseconds",
      withHeader({ occurredAt: "2026-10-27T12:34:56Z" }),
      "malformed",
    ],
    [
      "2026-02-30",
      withHeader({ occurredAt: "2026-02-30T12:34:56.789Z" }),
      "malformed",
    ],
    [
      "a type that is not lowercase dotted",
      withHeader({ type: "Agent.Run.StateChanged" }),
      "malformed",
    ],
    [
      "an unknown actor kind",
      withHeader({ actor: { kind: "admin" } }),
      "malformed",
    ],
    [
      "an unknown event type",
      withHeader({ type: "agent.run.exploded" }),
      "unknown_type",
    ],
    ["a missing payload", without("payload"), "invalid_payload"],
    [
      "a 501-character reason",
      withPayload({ reason: "r".repeat(501) }),
      "invalid_payload",
    ],
    [
      "a reason containing U+202E",
      withPayload({ reason: "invoice\u202Efdp.exe" }),
      "invalid_payload",
    ],
    [
      "an illegal transition",
      withPayload({ previousState: "completed", state: "running" }),
      "invalid_payload",
    ],
    [
      "an unknown run state",
      withPayload({ state: "paused" }),
      "invalid_payload",
    ],
  ];
  assert.equal(cases.length, 19);
  for (const [label, input, code] of cases) {
    assert.deepEqual(decodeEvent(input), { ok: false, code }, label);
  }

  // Over the limit, a pattern must not run: on ten million characters it
  // overflows the stack instead of returning a result.
  const oversized: [label: string, input: unknown, code: string][] = [
    [
      "a ten-million-character reason ending in U+202E",
      withPayload({ reason: `${"r".repeat(10_000_000)}\u202E` }),
      "invalid_payload",
    ],
    [
      "a ten-million-character type",
      withHeader({ type: `a${"_a".repeat(5_000_000)}` }),
      "malformed",
    ],
  ];
  for (const [label, input, code] of oversized) {
    assert.deepEqual(decodeEvent(input), { ok: false, code }, label);
    assert.deepEqual(decodeClientEvent(input), { ok: false, code }, label);
  }
});

test("every allowed transition decodes", () => {
  const created = decodeEvent(serverCreatedRun());
  assert.equal(created.ok, true, "null -> queued");
  let transitions = 1;
  for (const from of RUN_STATES) {
    for (const to of RUN_TRANSITIONS[from]) {
      const result = decodeEvent(
        withPayload({ previousState: from, state: to }),
      );
      assert.ok(result.ok, `${from} -> ${to}`);
      assert.ok(result.event.type === "agent.run.state_changed");
      assert.equal(result.event.payload.previousState, from);
      assert.equal(result.event.payload.state, to);
      transitions += 1;
    }
  }
  assert.equal(transitions, 11);
});

test("unknown keys and __proto__ and constructor keys are stripped at every level", () => {
  const event = baseEvent();
  const input = hostile({
    ...event,
    actor: hostile(event.actor as Json),
    payload: hostile(event.payload as Json),
  });
  assert.equal(Object.hasOwn(input, "__proto__"), true);
  assert.equal(Object.hasOwn(input.payload as Json, "__proto__"), true);

  const result = decodeEvent(input);
  assert.ok(result.ok);
  const levels: [label: string, value: object][] = [
    ["event", result.event],
    ["actor", result.event.actor],
    ["payload", result.event.payload],
  ];
  for (const [label, value] of levels) {
    for (const key of ["__proto__", "constructor", "extra"]) {
      assert.equal(Object.hasOwn(value, key), false, `${label}.${key}`);
    }
    assert.equal(Object.getPrototypeOf(value), Object.prototype, label);
  }
  assert.deepEqual(result.event, baseEvent());
  assert.equal((Object.prototype as Json)["polluted"], undefined);
});

test("the input is not mutated", () => {
  const input = deepFreeze(
    hostile({ ...baseEvent(), payload: hostile(baseEvent().payload as Json) }),
  );
  const before = structuredClone(input);

  const result = decodeEvent(input);
  const clientResult = decodeClientEvent(input);

  assert.ok(result.ok);
  assert.ok(clientResult.ok);
  assert.deepEqual(input, before);
  assert.notEqual(result.event, input);
  assert.notEqual(result.event.actor, input.actor);
  assert.notEqual(result.event.payload, input.payload);
  assert.equal(Object.hasOwn(input, "extra"), true);
});

/**
 * Counts, in a fresh process, how often a function is created from a string
 * while this package is evaluated and decodes one event.
 */
function codeGenerations(jitlessFirst: boolean): {
  ok: boolean;
  calls: number;
} {
  const zod = JSON.stringify(import.meta.resolve("zod"));
  const protocol = JSON.stringify(new URL("./index.ts", import.meta.url).href);
  const script = `
let calls = 0;
globalThis.Function = new Proxy(Function, {
  construct(target, args, newTarget) {
    calls += 1;
    return Reflect.construct(target, args, newTarget);
  },
  apply(target, thisArg, args) {
    calls += 1;
    return Reflect.apply(target, thisArg, args);
  },
});
const z = await import(${zod});
if (${String(jitlessFirst)}) z.config({ jitless: true });
const { decodeEvent } = await import(${protocol});
const { ok } = decodeEvent(${JSON.stringify(baseEvent())});
process.stdout.write(JSON.stringify({ ok, calls }));
`;
  const output = execFileSync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    { encoding: "utf8" },
  );
  return JSON.parse(output) as { ok: boolean; calls: number };
}

test("the JSON Schema export works, every exported pattern compiles with the u flag, and jitless set before loading generates no code", () => {
  const schema = z.toJSONSchema(ProtocolEventSchema, {
    target: "draft-2020-12",
    io: "input",
  });
  const patterns = collectPatterns(schema, []);
  assert.ok(patterns.includes(SAFE_TEXT_PATTERN.source));
  assert.ok(patterns.includes(NOT_BLANK_PATTERN.source));
  assert.ok(patterns.includes(UUIDV7_PATTERN.source));
  for (const pattern of patterns) {
    assert.doesNotThrow(() => new RegExp(pattern, "u"), pattern);
  }
  // Input mode documents that unknown keys are accepted (and stripped).
  assert.equal(
    JSON.stringify(schema).includes('"additionalProperties":false'),
    false,
  );

  for (const pattern of [
    UUIDV7_PATTERN,
    EVENT_TYPE_PATTERN,
    SAFE_TEXT_PATTERN,
    NOT_BLANK_PATTERN,
    GITHUB_LOGIN_PATTERN,
    BASE64URL_32_BYTES_PATTERN,
    DEVICE_SIGNATURE_PATTERN,
    DEVICE_PUBLIC_KEY_PATTERN,
    SIGN_IN_CODE_PATTERN,
    ACCESS_TOKEN_PATTERN,
    INVITATION_CODE_PATTERN,
    DEVICE_AUTH_AUDIENCE_PATTERN,
    LOOPBACK_REDIRECT_URI_PATTERN,
  ]) {
    assert.equal(pattern.flags, "u", pattern.source);
  }

  // zod reads `jitless` when a schema is created, so a consumer sets it before
  // this package is evaluated (README). The first count shows that the
  // counter sees zod's code generation.
  const withCodeGeneration = codeGenerations(false);
  assert.equal(withCodeGeneration.ok, true);
  assert.ok(withCodeGeneration.calls > 0, "zod generated no code");
  assert.deepEqual(codeGenerations(true), { ok: true, calls: 0 });
});

test("changing an exported pattern or the header shape does not change any schema", () => {
  const nul = String.fromCharCode(0);
  const cases: [label: string, pattern: RegExp, result: () => unknown][] = [
    [
      "UUIDV7_PATTERN",
      UUIDV7_PATTERN,
      () => UserIdSchema.safeParse("not-a-uuid").success,
    ],
    [
      "EVENT_TYPE_PATTERN",
      EVENT_TYPE_PATTERN,
      () => decodeEvent(withHeader({ type: "Not A Type" })),
    ],
    // displayText creates its schema when it is called, here after the change.
    [
      "SAFE_TEXT_PATTERN",
      SAFE_TEXT_PATTERN,
      () => displayText(100).safeParse(`a${nul}b`).success,
    ],
    [
      "NOT_BLANK_PATTERN",
      NOT_BLANK_PATTERN,
      () => displayText(100).safeParse("   ").success,
    ],
  ];
  const accountCases: [
    label: string,
    pattern: RegExp,
    result: () => unknown,
  ][] = [
    [
      "GITHUB_LOGIN_PATTERN",
      GITHUB_LOGIN_PATTERN,
      () => GitHubLoginSchema.safeParse("a b").success,
    ],
    [
      "BASE64URL_32_BYTES_PATTERN",
      BASE64URL_32_BYTES_PATTERN,
      () => Base64Url32BytesSchema.safeParse("x").success,
    ],
    [
      "DEVICE_SIGNATURE_PATTERN",
      DEVICE_SIGNATURE_PATTERN,
      () => DeviceSignatureSchema.safeParse("x").success,
    ],
    [
      "DEVICE_PUBLIC_KEY_PATTERN",
      DEVICE_PUBLIC_KEY_PATTERN,
      () => isDevicePublicKey("x"),
    ],
    [
      "SIGN_IN_CODE_PATTERN",
      SIGN_IN_CODE_PATTERN,
      () => SignInCodeSchema.safeParse("x").success,
    ],
    [
      "ACCESS_TOKEN_PATTERN",
      ACCESS_TOKEN_PATTERN,
      () => AccessTokenSchema.safeParse("x").success,
    ],
    [
      "INVITATION_CODE_PATTERN",
      INVITATION_CODE_PATTERN,
      () => InvitationCodeSchema.safeParse("x").success,
    ],
    [
      "DEVICE_AUTH_AUDIENCE_PATTERN",
      DEVICE_AUTH_AUDIENCE_PATTERN,
      () => isDeviceAuthAudience("x y"),
    ],
    [
      "LOOPBACK_REDIRECT_URI_PATTERN",
      LOOPBACK_REDIRECT_URI_PATTERN,
      () => LoopbackRedirectUriSchema.safeParse("x").success,
    ],
  ];
  cases.push(...accountCases);
  assert.equal(cases.length, 13);
  for (const [label, pattern, result] of cases) {
    const { source, flags } = pattern;
    const before = result();
    let after: unknown;
    try {
      // The legacy compile replaces the pattern of the exported object.
      pattern.compile("[^]*", "u");
      assert.equal(pattern.source, "[^]*", `${label} was replaced`);
      after = result();
    } finally {
      pattern.compile(source, flags);
    }
    assert.equal(pattern.source, source, `${label} restored`);
    assert.deepEqual(after, before, label);
  }

  assert.equal(Object.isFrozen(envelopeHeaderShape), true);
  assert.throws(() => {
    (envelopeHeaderShape as Record<string, unknown>).id = z.string();
  }, TypeError);
});

test("the actor must fit the event type", () => {
  assert.deepEqual(
    decodeEvent(withHeader({ actor: { kind: "user", userId: USER_ID } })),
    { ok: false, code: "invalid_actor" },
  );
  assert.deepEqual(
    decodeEvent(
      withHeader({ actor: { kind: "agent", agentId: OTHER_AGENT_ID } }),
    ),
    { ok: false, code: "invalid_actor" },
  );

  const created = decodeEvent(serverCreatedRun());
  assert.ok(created.ok);
  assert.deepEqual(created.event.actor, { kind: "system" });
  assert.equal(created.event.deviceId, null);
  assert.ok(created.event.type === "agent.run.state_changed");
  assert.equal(created.event.payload.previousState, null);
  assert.equal(created.event.payload.state, "queued");
});

test("decodeClientEvent rejects what only the server may originate", () => {
  const notAllowed = { ok: false, code: "not_allowed_from_device" };
  assert.deepEqual(
    decodeClientEvent(withHeader({ actor: { kind: "system" } })),
    notAllowed,
  );
  assert.deepEqual(
    decodeClientEvent(withHeader({ deviceId: null })),
    notAllowed,
  );
  assert.deepEqual(
    decodeClientEvent(withPayload({ previousState: null, state: "queued" })),
    notAllowed,
  );
  assert.deepEqual(decodeClientEvent(serverCreatedRun()), notAllowed);

  assert.deepEqual(decodeClientEvent(withHeader({ protocolVersion: 1 })), {
    ok: false,
    code: "unsupported_version",
  });
  assert.deepEqual(decodeClientEvent(null), { ok: false, code: "malformed" });
  assert.deepEqual(
    decodeClientEvent(
      withHeader({ actor: { kind: "agent", agentId: OTHER_AGENT_ID } }),
    ),
    { ok: false, code: "invalid_actor" },
  );

  const accepted = decodeClientEvent(baseEvent());
  assert.ok(accepted.ok);
  assert.deepEqual(accepted.event, baseEvent());
});
