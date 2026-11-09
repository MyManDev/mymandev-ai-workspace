import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROTOCOL_VERSION,
  type AuthChallengeFrame,
  type AuthResponseFrame,
  type DeviceId,
  type WorkspaceId,
} from "@mymandev/protocol";
import { expect, test } from "vitest";
import {
  ConnectionStatusSchema,
  type AccountStatus,
  type ConnectionStatus,
} from "../../shared/ipc-contract.ts";
import type { ChallengeAnswer, DeviceRefusalCode } from "../account.ts";
import type { ApiOrigin } from "../api-origin.ts";
import {
  AUTH_OK_TIMEOUT_MS,
  backoffDelayMs,
  CLOSE_WAIT_MS,
  createConnectionClient,
  gatewayUrl,
  HANDSHAKE_TIMEOUT_MS,
  MAX_BUFFERED_SEND_BYTES,
  RECEIVE_LIMIT_BYTES,
  RECONNECT_BUDGET,
  RECONNECT_BUDGET_WINDOW_MS,
  RECONNECT_COOLDOWN_MS,
  STABLE_CONNECTION_MS,
  type ClientEvent,
  type ConnectionClient,
  type ConnectionIdentity,
  type ServerMessage,
  type SocketEvents,
} from "./client.ts";

const ORIGIN = "https://api.mymandev.example";
const DEVICE_ID = "0192f0a0-7b3c-7d4e-8f50-000000000004" as DeviceId;
const OTHER_DEVICE_ID = "0192f0a0-7b3c-7d4e-8f50-000000000014" as DeviceId;
const USER_ID = "0192f0a0-7b3c-7d4e-8f50-000000000009";
const OTHER_USER_ID = "0192f0a0-7b3c-7d4e-8f50-000000000019";
const CONNECTION_ID = "0192f0a0-7b3c-7d4e-8f50-00000000000b";
const WORKSPACE_ID = "0192f0a0-7b3c-7d4e-8f50-000000000003" as WorkspaceId;
const OTHER_WORKSPACE_ID =
  "0192f0a0-7b3c-7d4e-8f50-000000000013" as WorkspaceId;
const MEMBER_ID = "0192f0a0-7b3c-7d4e-8f50-00000000000c";
const EVENT_ID = "0192f0a0-7b3c-7d4e-8f50-000000000001";
const PROJECT_ID = "0192f0a0-7b3c-7d4e-8f50-00000000000e";
const AGENT_ID = "0192f0a0-7b3c-7d4e-8f50-000000000005";
const RUN_ID = "0192f0a0-7b3c-7d4e-8f50-000000000007";
const NONCE = Buffer.alloc(32, 7).toString("base64url");
const SIGNATURE = Buffer.alloc(64, 9).toString("base64url");
const WALL_START = Date.parse("2026-11-03T10:00:00.000Z");

const CHALLENGE = Object.freeze({
  protocolVersion: 0,
  type: "auth.challenge",
  nonce: NONCE,
  connectionId: CONNECTION_ID,
});

const AUTH_OK = Object.freeze({
  protocolVersion: 0,
  type: "auth.ok",
  userId: USER_ID,
  deviceId: DEVICE_ID,
  signInExpiresAt: "2026-12-02T10:00:00.000Z",
});

const RESPONSE: AuthResponseFrame = Object.freeze({
  protocolVersion: 0,
  type: "auth.response",
  deviceId: DEVICE_ID,
  signature: SIGNATURE,
} as AuthResponseFrame);

const PRESENCE = Object.freeze({
  protocolVersion: 0,
  type: "presence.changed",
  workspaceId: WORKSPACE_ID,
  memberId: MEMBER_ID,
  status: "online",
});

/** A chat message that a person sends from this device. */
function chatSend(body = "Hello"): ClientEvent {
  return {
    protocolVersion: 0,
    id: EVENT_ID,
    type: "chat.message.send",
    occurredAt: "2026-11-03T10:00:00.000Z",
    workspaceId: WORKSPACE_ID,
    actor: { kind: "user", userId: USER_ID },
    deviceId: DEVICE_ID,
    payload: { projectId: PROJECT_ID, body },
  } as unknown as ClientEvent;
}

/** The chat message of `chatSend`, from the account and device of `identity`. */
function chatSendAs(identity: ConnectionIdentity, body = "Hello"): ClientEvent {
  return {
    ...chatSend(body),
    actor: { kind: "user", userId: identity.userId },
    deviceId: identity.deviceId,
  } as unknown as ClientEvent;
}

function accountStatus(
  overrides: Partial<AccountStatus> = {},
  deviceId: string = DEVICE_ID,
): AccountStatus {
  return Object.freeze({
    revision: 1,
    account: Object.freeze({
      kind: "signed_in",
      login: "octocat",
      displayName: "The Octocat",
      deviceId,
    }),
    signIn: Object.freeze({ kind: "idle" }),
    lastOutcome: null,
    deviceKey: "ready",
    replacementPending: false,
    apiOrigin: "set",
    device: "signed_in",
    ...overrides,
  }) as AccountStatus;
}

const SIGNED_OUT = accountStatus({
  account: Object.freeze({ kind: "signed_out" }),
  device: "signed_out",
});

/** A socket of the fake factory. Its close event fires only when the test says so. */
class FakeSocket {
  readonly sent: string[] = [];
  readonly closes: number[] = [];
  buffered = 0;
  readonly url: string;
  readonly events: SocketEvents;

  constructor(url: string, events: SocketEvents) {
    this.url = url;
    this.events = events;
  }

  open(): void {
    this.events.open();
  }

  receive(data: unknown): void {
    this.events.message(data);
  }

  receiveJson(value: unknown): void {
    this.events.message(JSON.stringify(value));
  }

  /** The close event, from the server or after the client's `close`. */
  closed(code: number, reason = ""): void {
    this.events.close(code, reason);
  }

  sentJson(): unknown[] {
    return this.sent.map((text) => JSON.parse(text) as unknown);
  }
}

interface Timer {
  at: number;
  callback: () => void;
  active: boolean;
}

function harness(
  options: {
    readonly apiOrigin?: ApiOrigin;
    readonly status?: AccountStatus;
    readonly random?: number;
  } = {},
) {
  let clock = 0;
  const timers: Timer[] = [];
  const sockets: FakeSocket[] = [];
  const statuses: ConnectionStatus[] = [];
  const logs: string[] = [];
  const refusals: [DeviceRefusalCode, DeviceId][] = [];
  const challenges: AuthChallengeFrame[] = [];
  const accountListeners = new Set<(status: AccountStatus) => void>();
  let status = options.status ?? accountStatus();
  const state = {
    random: options.random ?? 0,
    sign: async (): Promise<ChallengeAnswer> => ({ ok: true, frame: RESPONSE }),
    openFails: false,
  };
  const client: ConnectionClient = createConnectionClient({
    apiOrigin: options.apiOrigin ?? { ok: true, origin: ORIGIN },
    account: {
      status: () => status,
      onStatusChange: (listener) => {
        accountListeners.add(listener);
        return () => {
          accountListeners.delete(listener);
        };
      },
      signWebSocketChallenge: async (challenge) => {
        challenges.push(challenge);
        return state.sign();
      },
      deviceRefused: async (code, deviceId) => {
        refusals.push([code, deviceId]);
      },
    },
    openSocket: (url, events) => {
      if (state.openFails) {
        throw new TypeError("refused");
      }
      const socket = new FakeSocket(url, events);
      sockets.push(socket);
      return {
        bufferedAmount: () => socket.buffered,
        send: (data) => {
          socket.sent.push(data);
        },
        close: (code) => {
          socket.closes.push(code);
        },
      };
    },
    scheduleTimer: (callback, delayMs) => {
      const timer: Timer = { at: clock + delayMs, callback, active: true };
      timers.push(timer);
      return () => {
        timer.active = false;
      };
    },
    now: () => clock,
    wallClock: () => WALL_START + clock,
    random: () => state.random,
    log: (message) => logs.push(message),
  });
  client.onStatusChange((next) => statuses.push(next));

  /** Runs the timers that are due within `ms`, in order. */
  function advance(ms: number): void {
    const end = clock + ms;
    for (;;) {
      const due = timers
        .filter((timer) => timer.active && timer.at <= end)
        .sort((a, b) => a.at - b.at)[0];
      if (due === undefined) {
        break;
      }
      clock = due.at;
      due.active = false;
      due.callback();
    }
    clock = end;
  }

  function emit(next: AccountStatus): void {
    status = next;
    for (const listener of [...accountListeners]) {
      listener(next);
    }
  }

  function last(): FakeSocket {
    const socket = sockets.at(-1);
    if (socket === undefined) {
      throw new Error("No socket was opened.");
    }
    return socket;
  }

  /** Opens the last socket and answers the challenge up to `auth.ok`. */
  async function authenticate(socket: FakeSocket = last()): Promise<void> {
    socket.open();
    socket.receiveJson(CHALLENGE);
    await flush();
    socket.receiveJson(AUTH_OK);
  }

  return {
    client,
    sockets,
    statuses,
    logs,
    refusals,
    challenges,
    state,
    advance,
    emit,
    last,
    authenticate,
    states: () => statuses.map((value) => value.state),
    clock: () => clock,
    pendingTimers: () => timers.filter((timer) => timer.active).length,
  };
}

/** Lets the session's signature, a promise, settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("the gateway URL is the API origin with ws or wss and the path /ws", () => {
  expect(gatewayUrl("https://api.mymandev.example")).toBe(
    "wss://api.mymandev.example/ws",
  );
  expect(gatewayUrl("http://127.0.0.1:3000")).toBe("ws://127.0.0.1:3000/ws");
});

test("the backoff doubles from 1 second up to 60 seconds", () => {
  expect([0, 1, 2, 3, 4, 5, 6, 7, 20].map(backoffDelayMs)).toEqual([
    1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000,
  ]);
});

test("a signed-in device connects, answers the challenge with one signed frame, and is connected after auth.ok", async () => {
  const h = harness();
  const socket = h.last();
  expect(h.sockets).toHaveLength(1);
  expect(socket.url).toBe("wss://api.mymandev.example/ws");
  expect(h.client.status()).toEqual({ state: "connecting", revision: 1 });

  socket.open();
  expect(h.client.status().state).toBe("authenticating");
  // Nothing is sent before the challenge.
  expect(socket.sent).toEqual([]);
  expect(h.client.sendAs(chatSendAs)).toBe("not_connected");

  socket.receiveJson(CHALLENGE);
  await flush();
  expect(h.challenges).toEqual([CHALLENGE]);
  expect(socket.sentJson()).toEqual([RESPONSE]);
  expect(h.client.status().state).toBe("authenticating");
  expect(h.client.sendAs(chatSendAs)).toBe("not_connected");

  socket.receiveJson(AUTH_OK);
  expect(h.client.status()).toEqual({ state: "connected", revision: 3 });
  // "connecting" came before the test's listener.
  expect(h.states()).toEqual(["authenticating", "connected"]);
  expect(socket.sent).toHaveLength(1);
  expect(socket.closes).toEqual([]);
  expect(h.client.sendAs(chatSendAs)).toBe("sent");
  expect(socket.sentJson()[1]).toEqual(chatSend());
  expect(h.logs).toEqual(["The connection to the API is authenticated."]);
});

test("no socket opens without a signed-in device with a loaded key or without an API origin", () => {
  const cases: [string, AccountStatus | undefined, ApiOrigin, unknown][] = [
    [
      "signed out",
      SIGNED_OUT,
      { ok: true, origin: ORIGIN },
      { state: "offline", reason: "not_signed_in", revision: 1 },
    ],
    [
      "the key waits for its passphrase",
      accountStatus({ deviceKey: "passphrase_required" }),
      { ok: true, origin: ORIGIN },
      { state: "offline", reason: "not_signed_in", revision: 1 },
    ],
    [
      "the session starts",
      accountStatus({ device: "starting" }),
      { ok: true, origin: ORIGIN },
      { state: "offline", revision: 0 },
    ],
    [
      "the API refused the key",
      accountStatus({ device: "auth_failed" }),
      { ok: true, origin: ORIGIN },
      { state: "offline", reason: "not_signed_in", revision: 1 },
    ],
    [
      "no API origin",
      accountStatus(),
      { ok: false, reason: "api_origin_unset" },
      { state: "offline", reason: "no_api_origin", revision: 1 },
    ],
    [
      "the account has no API origin",
      accountStatus({ apiOrigin: "unset" }),
      { ok: true, origin: ORIGIN },
      { state: "offline", reason: "no_api_origin", revision: 1 },
    ],
  ];
  for (const [name, status, apiOrigin, expected] of cases) {
    const h = harness({
      apiOrigin,
      ...(status === undefined ? {} : { status }),
    });
    expect(h.sockets, name).toEqual([]);
    expect(h.client.status(), name).toEqual(expected);
    expect(h.client.reconnect(), name).toEqual({
      outcome: "refused",
      reason: "not_signed_in",
    });
  }
});

test("the client starts when the account signs in and closes with 1000 on sign-out, removal, and revocation", async () => {
  for (const device of ["signed_out", "removal_pending", "revoked"] as const) {
    const h = harness({ status: SIGNED_OUT });
    expect(h.sockets).toHaveLength(0);
    h.emit(accountStatus());
    expect(h.sockets).toHaveLength(1);
    await h.authenticate();
    expect(h.client.status().state).toBe("connected");

    h.emit(
      accountStatus({ device, account: Object.freeze({ kind: "signed_out" }) }),
    );
    expect(h.last().closes, device).toEqual([1000]);
    expect(h.client.status(), device).toMatchObject({
      state: "offline",
      reason: "not_signed_in",
    });
    h.last().closed(1000);
    h.advance(10 * 60_000);
    expect(h.sockets, device).toHaveLength(1);
  }
});

test("quit closes the socket with 1000 and stops for good", async () => {
  const h = harness();
  await h.authenticate();
  h.client.close();
  expect(h.last().closes).toEqual([1000]);
  expect(h.client.status().state).toBe("offline");
  h.last().closed(1000);
  h.emit(accountStatus({ revision: 2 }));
  h.advance(10 * 60_000);
  expect(h.sockets).toHaveLength(1);
  expect(h.pendingTimers()).toBe(0);
  expect(h.client.reconnect()).toEqual({
    outcome: "refused",
    reason: "not_signed_in",
  });
});

test("an account change of the same device opens no second socket", async () => {
  const h = harness();
  await h.authenticate();
  h.emit(accountStatus({ revision: 2, replacementPending: true }));
  h.emit(accountStatus({ revision: 3, signIn: { kind: "starting" } }));
  expect(h.sockets).toHaveLength(1);
  expect(h.client.status().state).toBe("connected");
});

test("another device closes the socket first and opens the next one only after its close event", async () => {
  const h = harness();
  await h.authenticate();
  const first = h.last();

  h.emit(accountStatus({ revision: 2 }, OTHER_DEVICE_ID));
  expect(first.closes).toEqual([1000]);
  expect(h.sockets).toHaveLength(1);
  expect(h.client.status().state).toBe("connecting");
  // A late message of the closed socket changes nothing.
  first.receiveJson(PRESENCE);

  first.closed(1000);
  expect(h.sockets).toHaveLength(2);

  // Without a close event, the next socket opens after CLOSE_WAIT_MS.
  h.emit(accountStatus({ revision: 3 }, DEVICE_ID));
  expect(h.sockets).toHaveLength(2);
  h.advance(CLOSE_WAIT_MS - 1);
  expect(h.sockets).toHaveLength(2);
  h.advance(1);
  expect(h.sockets).toHaveLength(3);
});

test("a challenge of another protocol version stops the client with update required", async () => {
  const h = harness();
  const socket = h.last();
  socket.open();
  socket.receiveJson({ ...CHALLENGE, protocolVersion: 1 });
  await flush();

  expect(socket.sent).toEqual([]);
  expect(socket.closes).toEqual([1000]);
  expect(h.client.status()).toMatchObject({
    state: "stopped",
    reason: "update_required",
  });
  socket.closed(1000);
  h.advance(10 * 60_000);
  expect(h.sockets).toHaveLength(1);
  expect(h.client.reconnect()).toEqual({
    outcome: "refused",
    reason: "update_required",
  });
  // A new sign-in does not end it either.
  h.emit(SIGNED_OUT);
  h.emit(accountStatus({ revision: 3 }));
  expect(h.sockets).toHaveLength(1);
  expect(h.client.status()).toMatchObject({ reason: "update_required" });
});

test("the opening handshake and the time from open to auth.ok each time out after 15 seconds", async () => {
  const h = harness();
  h.advance(HANDSHAKE_TIMEOUT_MS - 1);
  expect(h.last().closes).toEqual([]);
  h.advance(1);
  expect(h.last().closes).toEqual([1000]);
  expect(h.client.status()).toMatchObject({
    state: "waiting",
    reason: "timeout",
  });
  expect(h.logs).toContain("The connection to the API timed out.");
  h.last().closed(1006);

  h.advance(backoffDelayMs(0));
  expect(h.sockets).toHaveLength(2);
  const second = h.last();
  second.open();
  second.receiveJson(CHALLENGE);
  await flush();
  h.advance(AUTH_OK_TIMEOUT_MS - 1);
  expect(second.closes).toEqual([]);
  h.advance(1);
  expect(second.closes).toEqual([1000]);
  expect(h.client.status()).toMatchObject({
    state: "waiting",
    reason: "timeout",
  });

  // auth.ok in time cancels the timer.
  second.closed(1000);
  h.advance(backoffDelayMs(1));
  await h.authenticate();
  h.advance(AUTH_OK_TIMEOUT_MS * 2);
  expect(h.last().closes).toEqual([]);
  expect(h.client.status().state).toBe("connected");
});

test("the close reasons that refuse the device stop the client and reach the session with the connection's device ID", async () => {
  const cases: [number, string, DeviceRefusalCode | null][] = [
    [4000, "auth_failed", "auth_failed"],
    [4002, "device_revoked", "device_revoked"],
    [4003, "sign_in_required", "sign_in_required"],
    [4004, "connection_replaced", null],
    [4005, "protocol_violation", null],
  ];
  for (const [code, reason, refusal] of cases) {
    // The account names another device than the signed frame: the
    // refusal is for the device that the session signed for.
    const h = harness({ status: accountStatus({}, OTHER_DEVICE_ID) });
    await h.authenticate();
    h.last().closed(code, reason);
    await flush();

    expect(h.client.status(), reason).toMatchObject({
      state: "stopped",
      reason,
    });
    expect(h.refusals, reason).toEqual(
      refusal === null ? [] : [[refusal, DEVICE_ID]],
    );
    h.advance(10 * 60_000);
    h.client.systemResumed();
    expect(h.sockets, reason).toHaveLength(1);
    expect(h.logs, reason).toContain(
      `The connection to the API closed with code ${String(code)}.`,
    );
  }
});

test("a refusal before auth.ok also reaches the session, and a close before the response does not", async () => {
  const h = harness();
  const socket = h.last();
  socket.open();
  socket.receiveJson(CHALLENGE);
  await flush();
  socket.closed(4002, "device_revoked");
  await flush();
  expect(h.refusals).toEqual([["device_revoked", DEVICE_ID]]);

  const other = harness();
  other.last().open();
  other.last().closed(4000, "auth_failed");
  await flush();
  expect(other.refusals).toEqual([]);
  expect(other.client.status()).toMatchObject({ reason: "auth_failed" });
});

test("after a refusal the client stays stopped until a new sign-in of the device", async () => {
  const h = harness();
  await h.authenticate();
  h.last().closed(4003, "sign_in_required");
  // The session moves to sign_in_required; the status keeps the reason.
  h.emit(accountStatus({ revision: 2, device: "sign_in_required" }));
  expect(h.client.status()).toMatchObject({
    state: "stopped",
    reason: "sign_in_required",
  });
  expect(h.client.reconnect()).toEqual({
    outcome: "refused",
    reason: "not_signed_in",
  });

  h.emit(accountStatus({ revision: 3 }));
  expect(h.sockets).toHaveLength(2);
  expect(h.client.status().state).toBe("connecting");
});

test("connection_replaced offers one reconnect at a time, and a reconnect waits for the cooldown", async () => {
  const h = harness();
  await h.authenticate();
  h.last().closed(4004, "connection_replaced");
  expect(h.client.status()).toMatchObject({
    state: "stopped",
    reason: "connection_replaced",
  });

  expect(h.client.reconnect()).toEqual({ outcome: "reconnecting" });
  expect(h.sockets).toHaveLength(2);
  expect(h.client.reconnect()).toEqual({
    outcome: "refused",
    reason: "already_open",
  });
  await h.authenticate();
  h.last().closed(4004, "connection_replaced");
  expect(h.client.reconnect()).toEqual({
    outcome: "refused",
    reason: "too_soon",
  });
  h.advance(RECONNECT_COOLDOWN_MS);
  expect(h.sockets).toHaveLength(2);
  expect(h.client.reconnect()).toEqual({ outcome: "reconnecting" });
  expect(h.sockets).toHaveLength(3);
});

/** The stops that offer a reconnect, and that end with the device. */
const RECONNECTABLE_CLOSES = [
  [4004, "connection_replaced"],
  [4005, "protocol_violation"],
] as const;

/** Account statuses without a device to connect as. */
const NO_DEVICE: readonly [string, AccountStatus][] = [
  [
    "a removal that waits for the API",
    accountStatus({ revision: 2, device: "removal_pending" }),
  ],
  [
    "a confirmed removal",
    accountStatus({
      revision: 2,
      account: Object.freeze({ kind: "signed_out" }),
      device: "removed",
    }),
  ],
  ["a sign-out", accountStatus({ ...SIGNED_OUT, revision: 2 })],
  [
    "a sign-out that the API has not learned yet",
    accountStatus({
      revision: 2,
      account: Object.freeze({ kind: "signed_out" }),
      device: "sign_out_report_pending",
    }),
  ],
  [
    "no device any more, as after This is not me",
    accountStatus({
      revision: 2,
      account: Object.freeze({ kind: "signed_out" }),
      device: "no_device",
    }),
  ],
  [
    "a key that waits for its passphrase",
    accountStatus({ revision: 2, deviceKey: "passphrase_required" }),
  ],
  ["no API origin", accountStatus({ revision: 2, apiOrigin: "unset" })],
];

/** A status without its revision, to compare the statuses of two clients. */
function withoutRevision(status: ConnectionStatus): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...status };
  delete copy["revision"];
  return copy;
}

test("connection_replaced and protocol_violation end when the device is removed or signs out, and the new status reaches the listeners", async () => {
  for (const [code, reason] of RECONNECTABLE_CLOSES) {
    const h = harness();
    await h.authenticate();
    h.last().closed(code, reason);
    expect(h.client.status(), reason).toMatchObject({
      state: "stopped",
      reason,
    });
    const before = h.statuses.length;

    // The removal was confirmed in the dialog and waits for the API.
    h.emit(accountStatus({ revision: 2, device: "removal_pending" }));
    const offline = { state: "offline", reason: "not_signed_in" };
    expect(h.client.status(), reason).toMatchObject(offline);
    expect(h.statuses.slice(before), reason).toEqual([h.client.status()]);
    expect(h.client.reconnect(), reason).toEqual({
      outcome: "refused",
      reason: "not_signed_in",
    });

    // The API confirmed the removal, and then the account signed out.
    h.emit(
      accountStatus({
        revision: 3,
        account: Object.freeze({ kind: "signed_out" }),
        device: "removed",
      }),
    );
    h.emit(accountStatus({ ...SIGNED_OUT, revision: 4 }));
    expect(h.client.status(), reason).toMatchObject(offline);
    expect(h.statuses.slice(before), reason).toHaveLength(1);
    h.advance(10 * 60_000);
    expect(h.sockets, reason).toHaveLength(1);
  }
});

test("each way of losing the device ends connection_replaced and protocol_violation with the status of no device", async () => {
  for (const [code, reason] of RECONNECTABLE_CLOSES) {
    for (const [name, status] of NO_DEVICE) {
      const h = harness();
      await h.authenticate();
      h.last().closed(code, reason);
      const before = h.statuses.length;

      h.emit(status);
      const label = `${reason}, ${name}`;
      // The same status as a client that never had a device.
      expect(withoutRevision(h.client.status()), label).toEqual(
        withoutRevision(harness({ status }).client.status()),
      );
      expect(h.client.status().state, label).toBe("offline");
      expect(h.statuses.slice(before), label).toEqual([h.client.status()]);
      expect(h.client.reconnect(), label).toEqual({
        outcome: "refused",
        reason: "not_signed_in",
      });
    }
  }
});

/** The outcome of a sign-in that succeeded. */
const SIGNED_IN_OUTCOME: AccountStatus["lastOutcome"] = Object.freeze({
  code: "signed_in",
});

/**
 * The account statuses of a GitHub sign-in that starts from `from`, from
 * revision `revision` on, as the account service publishes them:
 * `starting`, `waiting`, and `completing`; with `deviceFirst`, the device
 * signed in while the sign-in still runs, as the session reports it before
 * the service ends the sign-in; and last the device signed in with the
 * sign-in `idle` again and the outcome `signed_in`.
 */
function signInStatuses(
  from: AccountStatus,
  revision: number,
  deviceId: string,
  deviceFirst: boolean,
): AccountStatus[] {
  const running = (
    signIn: AccountStatus["signIn"],
    at: number,
  ): AccountStatus =>
    accountStatus({ ...from, revision: at, signIn, lastOutcome: null });
  const statuses = [
    running({ kind: "starting" }, revision),
    running(
      { kind: "waiting", pairingCode: "123456", opened: true },
      revision + 1,
    ),
    running({ kind: "completing" }, revision + 2),
  ];
  if (deviceFirst) {
    statuses.push(
      accountStatus(
        { revision: revision + 3, signIn: { kind: "completing" } },
        deviceId,
      ),
    );
  }
  statuses.push(
    accountStatus(
      { revision: revision + 4, lastOutcome: SIGNED_IN_OUTCOME },
      deviceId,
    ),
  );
  return statuses;
}

/**
 * Ways in which a device stops being eligible that a sign-in ends. Only a
 * sign-out passes through `signed_out`: a sign-in also ends a pending
 * removal and a refusal, for example when the token request of the removal
 * got `sign_in_required`.
 */
const BEFORE_SIGN_IN: readonly [string, AccountStatus][] = [
  ["a sign-out", accountStatus({ ...SIGNED_OUT, revision: 2 })],
  [
    "a removal that waits for the API",
    accountStatus({
      revision: 2,
      device: "removal_pending",
      lastOutcome: SIGNED_IN_OUTCOME,
    }),
  ],
  [
    "a removal whose token request needs a sign-in",
    accountStatus({
      revision: 2,
      device: "sign_in_required",
      lastOutcome: SIGNED_IN_OUTCOME,
    }),
  ],
];

test("after connection_replaced or protocol_violation, a new sign-in of the same or another device connects", async () => {
  for (const [code, reason] of RECONNECTABLE_CLOSES) {
    for (const [name, from] of BEFORE_SIGN_IN) {
      for (const deviceId of [DEVICE_ID, OTHER_DEVICE_ID]) {
        for (const deviceFirst of [true, false]) {
          const label = `${reason}, ${name}, ${deviceId}, ${String(deviceFirst)}`;
          // The person signed in earlier, so the last outcome may already
          // be `signed_in` before this sign-in.
          const h = harness({
            status: accountStatus({ lastOutcome: SIGNED_IN_OUTCOME }),
          });
          await h.authenticate();
          h.last().closed(code, reason);
          h.emit(from);
          const before = h.statuses.length;

          for (const status of signInStatuses(from, 3, deviceId, deviceFirst)) {
            h.emit(status);
          }
          expect(h.sockets, label).toHaveLength(2);
          // The stop never comes back on the way.
          expect(h.states().slice(before), label).toEqual(["connecting"]);
          expect(h.client.reconnect(), label).toEqual({
            outcome: "refused",
            reason: "already_open",
          });
          await h.authenticate();
          expect(h.client.status().state, label).toBe("connected");
        }
      }
    }
  }
});

test("an account change of the same device keeps connection_replaced and protocol_violation", async () => {
  for (const [code, reason] of RECONNECTABLE_CLOSES) {
    const h = harness();
    await h.authenticate();
    h.last().closed(code, reason);
    const stopped = h.client.status();

    h.emit(accountStatus({ revision: 2, replacementPending: true }));
    h.emit(accountStatus({ revision: 3, signIn: { kind: "starting" } }));
    expect(h.client.status(), reason).toBe(stopped);
    expect(h.sockets, reason).toHaveLength(1);
  }
});

test("another device that signs in while connection_replaced or protocol_violation holds still connects at once", async () => {
  for (const [code, reason] of RECONNECTABLE_CLOSES) {
    const h = harness();
    await h.authenticate();
    h.last().closed(code, reason);

    h.emit(accountStatus({ revision: 2 }, OTHER_DEVICE_ID));
    expect(h.sockets, reason).toHaveLength(2);
    expect(h.client.status().state, reason).toBe("connecting");
  }
});

test("after connection_replaced or protocol_violation, a removal that the API refuses brings the stop back and opens no socket", async () => {
  for (const [code, reason] of RECONNECTABLE_CLOSES) {
    // The person signed in earlier, so the last outcome is `signed_in`
    // throughout; it is not a new sign-in.
    const signedIn = accountStatus({ lastOutcome: SIGNED_IN_OUTCOME });
    const h = harness({ status: signedIn });
    await h.authenticate();
    h.last().closed(code, reason);
    const stopped = { state: "stopped", reason };
    const offline = { state: "offline", reason: "not_signed_in" };
    expect(h.client.status(), reason).toMatchObject(stopped);
    const before = h.statuses.length;

    for (const revision of [2, 4]) {
      // "Remove this device and register again": the session notes the
      // removal, and the stop ends (#215).
      h.emit(
        accountStatus({ ...signedIn, revision, device: "removal_pending" }),
      );
      expect(h.client.status(), reason).toMatchObject(offline);
      // The API refused the revoke, for example with `conflict`: the
      // session ends the removal, and the device is signed in again with
      // the same ID.
      h.emit(accountStatus({ ...signedIn, revision: revision + 1 }));
      expect(h.client.status(), reason).toMatchObject(stopped);
      expect(h.sockets, reason).toHaveLength(1);
    }
    // One status per change, and each fits the contract.
    expect(h.statuses.slice(before).map(withoutRevision), reason).toEqual([
      offline,
      stopped,
      offline,
      stopped,
    ]);
    for (const status of h.statuses) {
      expect(ConnectionStatusSchema.parse(status), reason).toEqual(status);
    }
    h.advance(10 * 60_000);
    h.client.systemResumed();
    expect(h.sockets, reason).toHaveLength(1);
    expect(h.client.status(), reason).toMatchObject(stopped);

    // The header's actions work again: "Reconnect here once" (or "Retry
    // now") connects.
    expect(h.client.reconnect(), reason).toEqual({ outcome: "reconnecting" });
    expect(h.sockets, reason).toHaveLength(2);
    await h.authenticate();
    expect(h.client.status().state, reason).toBe("connected");
  }
});

test("the same device that becomes eligible again without a sign-in brings connection_replaced or protocol_violation back, whichever way it left", async () => {
  for (const [code, reason] of RECONNECTABLE_CLOSES) {
    for (const [name, status] of NO_DEVICE) {
      const label = `${reason}, ${name}`;
      const h = harness();
      await h.authenticate();
      h.last().closed(code, reason);
      h.emit(status);
      expect(h.client.status().state, label).toBe("offline");

      h.emit(accountStatus({ revision: 3 }));
      expect(h.client.status(), label).toMatchObject({
        state: "stopped",
        reason,
      });
      expect(h.sockets, label).toHaveLength(1);
    }
  }
});

test("a sign-in that was cancelled or failed while the device was not eligible does not count as a new sign-in", async () => {
  for (const [code, reason] of RECONNECTABLE_CLOSES) {
    for (const outcome of ["cancelled", "sign_in_failed"] as const) {
      const label = `${reason}, ${outcome}`;
      const h = harness({
        status: accountStatus({ lastOutcome: SIGNED_IN_OUTCOME }),
      });
      await h.authenticate();
      h.last().closed(code, reason);
      const pending = accountStatus({
        revision: 2,
        device: "removal_pending",
        lastOutcome: SIGNED_IN_OUTCOME,
      });
      h.emit(pending);
      h.emit(
        accountStatus({
          ...pending,
          revision: 3,
          signIn: { kind: "starting" },
          lastOutcome: null,
        }),
      );
      h.emit(
        accountStatus({
          ...pending,
          revision: 4,
          lastOutcome: { code: outcome },
        }),
      );

      // The removal is tried again, and the API refuses it.
      h.emit(accountStatus({ revision: 5, lastOutcome: { code: outcome } }));
      expect(h.client.status(), label).toMatchObject({
        state: "stopped",
        reason,
      });
      expect(h.sockets, label).toHaveLength(1);
    }
  }
});

test("the remembered connection_replaced or protocol_violation is forgotten after a reconnect, a new sign-in, or another device", async () => {
  /** A removal that the API refuses: the device leaves and comes back. */
  const refusedRemoval = (
    h: ReturnType<typeof harness>,
    revision: number,
    deviceId: string = DEVICE_ID,
  ): void => {
    h.emit(accountStatus({ revision, device: "removal_pending" }, deviceId));
    // The client closed its socket; its close event arrives.
    const socket = h.sockets.at(-1);
    if (socket !== undefined && socket.closes.length > 0) {
      socket.closed(1000);
    }
    h.emit(accountStatus({ revision: revision + 1 }, deviceId));
  };

  for (const [code, reason] of RECONNECTABLE_CLOSES) {
    // A reconnect from the stop that came back.
    const reconnected = harness();
    await reconnected.authenticate();
    reconnected.last().closed(code, reason);
    refusedRemoval(reconnected, 2);
    expect(reconnected.client.status(), reason).toMatchObject({
      state: "stopped",
      reason,
    });
    expect(reconnected.client.reconnect(), reason).toEqual({
      outcome: "reconnecting",
    });
    await reconnected.authenticate();
    refusedRemoval(reconnected, 4);
    expect(reconnected.sockets, reason).toHaveLength(3);
    expect(reconnected.client.status().state, reason).toBe("connecting");

    // A new sign-in after a sign-out.
    const signedIn = harness();
    await signedIn.authenticate();
    signedIn.last().closed(code, reason);
    signedIn.emit(accountStatus({ ...SIGNED_OUT, revision: 2 }));
    for (const status of signInStatuses(SIGNED_OUT, 3, DEVICE_ID, true)) {
      signedIn.emit(status);
    }
    await signedIn.authenticate();
    refusedRemoval(signedIn, 8);
    expect(signedIn.sockets, reason).toHaveLength(3);
    expect(signedIn.client.status().state, reason).toBe("connecting");

    // Another device, and then the first device again.
    const other = harness();
    await other.authenticate();
    other.last().closed(code, reason);
    other.emit(accountStatus({ revision: 2, device: "removal_pending" }));
    other.emit(accountStatus({ revision: 3 }, OTHER_DEVICE_ID));
    expect(other.sockets, reason).toHaveLength(2);
    await other.authenticate();
    refusedRemoval(other, 4, OTHER_DEVICE_ID);
    expect(other.sockets, reason).toHaveLength(3);
    other.emit(accountStatus({ ...SIGNED_OUT, revision: 6 }));
    other.last().closed(1000);
    other.emit(accountStatus({ revision: 7 }));
    expect(other.sockets, reason).toHaveLength(4);
    expect(other.client.status().state, reason).toBe("connecting");
  }
});

test("a sign-in that succeeds while connection_replaced or protocol_violation holds and the device stays signed in ends the stop and connects", async () => {
  for (const [code, reason] of RECONNECTABLE_CLOSES) {
    for (const deviceFirst of [true, false]) {
      const label = `${reason}, ${String(deviceFirst)}`;
      // The last outcome is `signed_in` from an earlier sign-in.
      const signedIn = accountStatus({ lastOutcome: SIGNED_IN_OUTCOME });
      const h = harness({ status: signedIn });
      await h.authenticate();
      h.last().closed(code, reason);
      const before = h.statuses.length;

      // The sign-in replaces the key, so the copy of the other
      // installation stops working.
      const statuses = signInStatuses(signedIn, 2, DEVICE_ID, deviceFirst);
      for (const status of statuses.slice(0, -1)) {
        h.emit(status);
        expect(h.client.status(), label).toMatchObject({
          state: "stopped",
          reason,
        });
      }
      h.emit(statuses.at(-1) ?? signedIn);
      expect(h.states().slice(before), label).toEqual(["connecting"]);
      expect(h.sockets, label).toHaveLength(2);
      await h.authenticate();
      expect(h.client.status().state, label).toBe("connected");
    }
  }
});

test("a sign-in that was cancelled or failed, or an earlier signed_in outcome, keeps connection_replaced or protocol_violation while the device stays signed in", async () => {
  for (const [code, reason] of RECONNECTABLE_CLOSES) {
    for (const outcome of ["cancelled", "sign_in_failed"] as const) {
      const label = `${reason}, ${outcome}`;
      const signedIn = accountStatus({ lastOutcome: SIGNED_IN_OUTCOME });
      const h = harness({ status: signedIn });
      await h.authenticate();
      h.last().closed(code, reason);
      const stopped = h.client.status();

      // The earlier outcome alone, also across another change of the device.
      h.emit(accountStatus({ ...signedIn, revision: 2 }));
      h.emit(
        accountStatus({ ...signedIn, revision: 3, replacementPending: true }),
      );
      expect(h.client.status(), label).toBe(stopped);

      h.emit(
        accountStatus({
          ...signedIn,
          revision: 4,
          signIn: { kind: "starting" },
          lastOutcome: null,
        }),
      );
      h.emit(
        accountStatus({
          ...signedIn,
          revision: 5,
          lastOutcome: { code: outcome },
        }),
      );
      h.emit(
        accountStatus({
          ...signedIn,
          revision: 6,
          replacementPending: true,
          lastOutcome: { code: outcome },
        }),
      );
      expect(h.client.status(), label).toBe(stopped);
      expect(h.sockets, label).toHaveLength(1);
    }
  }
});

test("a sign-in that already ran when connection_replaced or protocol_violation came counts, also when the device leaves during it and comes back after it", async () => {
  for (const [code, reason] of RECONNECTABLE_CLOSES) {
    // The sign-in started before the close, which arrives while it
    // completes; the next status ends it.
    const early = harness();
    await early.authenticate();
    early.emit(accountStatus({ revision: 2, signIn: { kind: "starting" } }));
    early.emit(accountStatus({ revision: 3, signIn: { kind: "completing" } }));
    early.last().closed(code, reason);
    expect(early.client.status(), reason).toMatchObject({
      state: "stopped",
      reason,
    });
    early.emit(accountStatus({ revision: 4, lastOutcome: SIGNED_IN_OUTCOME }));
    expect(early.sockets, reason).toHaveLength(2);
    expect(early.client.status().state, reason).toBe("connecting");

    // The sign-in starts while the stop holds and the device is signed in.
    // The device is not eligible for a while during it, for example while
    // the session cannot read the record, and comes back only once the
    // sign-in ended with `signed_in`.
    const left = harness();
    await left.authenticate();
    left.last().closed(code, reason);
    left.emit(accountStatus({ revision: 2, signIn: { kind: "starting" } }));
    expect(left.client.status(), reason).toMatchObject({
      state: "stopped",
      reason,
    });
    left.emit(
      accountStatus({
        revision: 3,
        signIn: { kind: "completing" },
        device: "unavailable",
      }),
    );
    expect(left.client.status(), reason).toMatchObject({
      state: "offline",
      reason: "not_signed_in",
    });
    left.emit(accountStatus({ revision: 4, lastOutcome: SIGNED_IN_OUTCOME }));
    expect(left.sockets, reason).toHaveLength(2);
    expect(left.client.status().state, reason).toBe("connecting");
  }
});

test("a sign-in that ended one connection_replaced or protocol_violation does not count for the next one", async () => {
  for (const [code, reason] of RECONNECTABLE_CLOSES) {
    const h = harness();
    await h.authenticate();
    h.last().closed(code, reason);

    // A sign-in succeeds while the first stop holds: the client connects.
    const statuses = signInStatuses(accountStatus(), 2, DEVICE_ID, true);
    for (const status of statuses) {
      h.emit(status);
    }
    expect(h.sockets, reason).toHaveLength(2);
    await h.authenticate();
    expect(h.client.status().state, reason).toBe("connected");

    // A second stop, while the last outcome is still `signed_in`.
    h.last().closed(code, reason);
    const stopped = { state: "stopped", reason };
    expect(h.client.status(), reason).toMatchObject(stopped);
    const signedIn = accountStatus({ lastOutcome: SIGNED_IN_OUTCOME });

    // Any other account status keeps it.
    h.emit(
      accountStatus({ ...signedIn, revision: 7, replacementPending: true }),
    );
    expect(h.client.status(), reason).toMatchObject(stopped);
    // A removal that the API refuses brings it back.
    h.emit(
      accountStatus({ ...signedIn, revision: 8, device: "removal_pending" }),
    );
    h.emit(accountStatus({ ...signedIn, revision: 9 }));
    expect(h.client.status(), reason).toMatchObject(stopped);
    expect(h.sockets, reason).toHaveLength(2);
  }
});

test("the refusals and update_required stay when the device signs out, and a sign-in ends all but update_required", async () => {
  const cases: [number, string, AccountStatus["device"] | null][] = [
    [4000, "auth_failed", "auth_failed"],
    [4002, "device_revoked", "revoked"],
    [4003, "sign_in_required", "sign_in_required"],
    [1008, "unsupported_version", null],
  ];
  for (const [code, closeReason, refusedState] of cases) {
    const reason =
      closeReason === "unsupported_version" ? "update_required" : closeReason;
    const h = harness();
    await h.authenticate();
    h.last().closed(code, closeReason);
    const stopped = h.client.status();
    expect(stopped, reason).toMatchObject({ state: "stopped", reason });

    // The session notes the refusal, and then the account signs out.
    if (refusedState !== null) {
      h.emit(accountStatus({ revision: 2, device: refusedState }));
    }
    h.emit(accountStatus({ ...SIGNED_OUT, revision: 3 }));
    expect(h.client.status(), reason).toBe(stopped);
    h.emit(
      accountStatus({
        revision: 4,
        account: Object.freeze({ kind: "signed_out" }),
        device: "removed",
      }),
    );
    expect(h.client.status(), reason).toBe(stopped);

    h.emit(accountStatus({ revision: 5 }));
    if (reason === "update_required") {
      expect(h.sockets, reason).toHaveLength(1);
      expect(h.client.status(), reason).toBe(stopped);
    } else {
      expect(h.sockets, reason).toHaveLength(2);
      expect(h.client.status().state, reason).toBe("connecting");
    }
  }
});

test("key_replaced reconnects at once one time, and backs off when it repeats", async () => {
  const h = harness();
  await h.authenticate();
  h.last().closed(4006, "key_replaced");
  expect(h.sockets).toHaveLength(2);
  expect(h.client.status().state).toBe("connecting");

  await h.authenticate();
  h.last().closed(4006, "key_replaced");
  expect(h.sockets).toHaveLength(2);
  expect(h.client.status()).toMatchObject({
    state: "waiting",
    reason: "key_replaced",
  });

  // After a stable connection, the next one reconnects at once again.
  h.advance(backoffDelayMs(0));
  await h.authenticate();
  h.advance(STABLE_CONNECTION_MS);
  h.last().closed(4006, "key_replaced");
  expect(h.sockets).toHaveLength(4);
});

test("every other close reason backs off with its reason", async () => {
  const cases: [number, string, boolean, string][] = [
    [4001, "auth_timeout", true, "timeout"],
    [1001, "", true, "connection_lost"],
    [1006, "", true, "connection_lost"],
    [1006, "net::ERR_CONNECTION_REFUSED", false, "connection_failed"],
    [1011, "internal_error", true, "server_error"],
    [1013, "backpressure", true, "server_busy"],
    [1003, "binary_not_supported", true, "message_refused"],
    [1007, "invalid_json", true, "message_refused"],
    [1008, "invalid_payload", true, "message_refused"],
    [1009, "", true, "message_refused"],
    [4999, "", true, "connection_lost"],
    [1000, "", true, "connection_lost"],
  ];
  for (const [code, reason, opened, expected] of cases) {
    const h = harness();
    if (opened) {
      await h.authenticate();
    }
    h.last().closed(code, reason);
    expect(h.client.status(), `${String(code)} ${reason}`).toEqual({
      state: "waiting",
      reason: expected,
      retryAt: new Date(WALL_START + backoffDelayMs(0) / 2).toISOString(),
      revision: h.client.status().revision,
    });
    expect(h.refusals).toEqual([]);
    h.advance(backoffDelayMs(0) / 2);
    expect(h.sockets, `${String(code)} ${reason}`).toHaveLength(2);
  }
});

test("1008 unsupported_version stops the client with update required", async () => {
  const h = harness();
  await h.authenticate();
  h.last().closed(1008, "unsupported_version");
  expect(h.client.status()).toMatchObject({
    state: "stopped",
    reason: "update_required",
  });
  h.advance(10 * 60_000);
  expect(h.sockets).toHaveLength(1);
});

test("the backoff waits between half and all of min(60 s, 1 s x 2^n), and resets after 60 seconds connected", async () => {
  for (const random of [0, 0.999_999]) {
    const h = harness({ random });
    const waits: number[] = [];
    for (let attempt = 0; attempt < 9; attempt += 1) {
      h.last().closed(1006);
      const status = h.client.status();
      if (status.state !== "waiting") {
        throw new Error("Expected waiting.");
      }
      const wait = Date.parse(status.retryAt) - WALL_START - h.clock();
      waits.push(wait);
      h.advance(wait - 1);
      expect(h.sockets).toHaveLength(attempt + 1);
      h.advance(1);
      expect(h.sockets).toHaveLength(attempt + 2);
    }
    const delays = waits.map((_, attempt) => backoffDelayMs(attempt));
    for (const [index, wait] of waits.entries()) {
      const delay = delays[index] ?? 0;
      expect(wait).toBeGreaterThanOrEqual(delay / 2);
      expect(wait).toBeLessThanOrEqual(delay);
    }
    expect(waits.at(-1)).toBe(random === 0 ? 30_000 : 60_000);

    // A connection that drops before 60 seconds keeps the count.
    await h.authenticate();
    h.advance(STABLE_CONNECTION_MS - 1);
    h.last().closed(1006);
    expect(waitOf(h)).toBe(random === 0 ? 30_000 : 60_000);
    h.advance(waitOf(h));
    // After 60 seconds connected, the count starts again.
    await h.authenticate();
    h.advance(STABLE_CONNECTION_MS);
    h.last().closed(1006);
    expect(waitOf(h)).toBe(random === 0 ? 500 : 1_000);
  }
});

/** The time from now until the retry, read from the status. */
function waitOf(h: ReturnType<typeof harness>): number {
  const status = h.client.status();
  if (status.state !== "waiting") {
    throw new Error("Expected waiting.");
  }
  return Date.parse(status.retryAt) - WALL_START - h.clock();
}

test("a resumed system starts a waiting connection at once and replaces an open one", async () => {
  const h = harness();
  h.last().closed(1006);
  expect(h.client.status().state).toBe("waiting");
  h.client.systemResumed();
  expect(h.sockets).toHaveLength(2);
  expect(h.client.status().state).toBe("connecting");

  await h.authenticate();
  h.client.systemResumed();
  expect(h.last().closes).toEqual([1000]);
  expect(h.sockets).toHaveLength(2);
  h.last().closed(1000);
  expect(h.sockets).toHaveLength(3);
  expect(h.logs).toContain(
    "The system resumed; the connection to the API starts again.",
  );
});

test("a binary message, invalid JSON, a message the protocol refuses, or one over 1 MiB closes with 1000 and backs off", async () => {
  const big = JSON.stringify({
    ...PRESENCE,
    padding: "x".repeat(RECEIVE_LIMIT_BYTES),
  });
  // Under the limit in UTF-16 code units, over it in UTF-8 bytes.
  const wide = JSON.stringify({
    ...PRESENCE,
    padding: String.fromCharCode(0xe9).repeat(RECEIVE_LIMIT_BYTES / 2 + 1),
  });
  const cases: [string, unknown][] = [
    ["binary", Buffer.from(JSON.stringify(PRESENCE))],
    ["array buffer", new ArrayBuffer(8)],
    ["invalid JSON", "{"],
    ["unknown frame", JSON.stringify({ protocolVersion: 0, type: "x.y" })],
    ["client frame", JSON.stringify(RESPONSE)],
    ["over the limit", big],
    ["over the limit in bytes", wide],
    ["a second auth.ok", JSON.stringify(AUTH_OK)],
    ["a second challenge", JSON.stringify(CHALLENGE)],
  ];
  for (const [name, data] of cases) {
    const h = harness();
    await h.authenticate();
    const received: ServerMessage[] = [];
    h.client.onMessage((message) => received.push(message));
    h.last().receive(data);
    expect(h.last().closes, name).toEqual([1000]);
    expect(h.client.status(), name).toMatchObject({
      state: "waiting",
      reason: "invalid_message",
    });
    expect(received, name).toEqual([]);
  }
  // A message within the limit is delivered.
  const h = harness();
  await h.authenticate();
  const received: ServerMessage[] = [];
  h.client.onMessage((message) => received.push(message));
  const fits = JSON.stringify(PRESENCE);
  h.last().receive(fits);
  expect(received).toEqual([{ kind: "frame", frame: PRESENCE }]);
  expect(h.last().closes).toEqual([]);
});

test("before auth.ok only the challenge and then auth.ok of the signed device are accepted", async () => {
  const cases: [string, (socket: FakeSocket) => Promise<void>][] = [
    [
      "a frame before the challenge",
      async (socket) => {
        socket.receiveJson(PRESENCE);
      },
    ],
    [
      "auth.ok before the challenge",
      async (socket) => {
        socket.receiveJson(AUTH_OK);
      },
    ],
    [
      "a message while signing",
      async (socket) => {
        socket.receiveJson(CHALLENGE);
        socket.receiveJson(AUTH_OK);
      },
    ],
    [
      "auth.ok of another device",
      async (socket) => {
        socket.receiveJson(CHALLENGE);
        await flush();
        socket.receiveJson({ ...AUTH_OK, deviceId: OTHER_DEVICE_ID });
      },
    ],
    [
      "a second challenge",
      async (socket) => {
        socket.receiveJson(CHALLENGE);
        await flush();
        socket.receiveJson(CHALLENGE);
      },
    ],
    [
      "a frame instead of auth.ok",
      async (socket) => {
        socket.receiveJson(CHALLENGE);
        await flush();
        socket.receiveJson(PRESENCE);
      },
    ],
  ];
  for (const [name, run] of cases) {
    const h = harness();
    h.last().open();
    await run(h.last());
    await flush();
    expect(h.last().closes, name).toEqual([1000]);
    expect(h.client.status(), name).toMatchObject({
      state: "waiting",
      reason: "invalid_message",
    });
    expect(h.last().sent.length, name).toBeLessThanOrEqual(1);
  }
});

test("a challenge that the session cannot sign closes the socket and backs off", async () => {
  const h = harness();
  h.state.sign = async () => ({ ok: false });
  h.last().open();
  h.last().receiveJson(CHALLENGE);
  await flush();
  expect(h.last().sent).toEqual([]);
  expect(h.last().closes).toEqual([1000]);
  expect(h.client.status()).toMatchObject({
    state: "waiting",
    reason: "signature_failed",
  });
});

test("a socket that cannot be opened backs off", () => {
  const h = harness({ status: SIGNED_OUT });
  h.state.openFails = true;
  h.emit(accountStatus());
  expect(h.client.status()).toMatchObject({
    state: "waiting",
    reason: "connection_failed",
  });
  h.state.openFails = false;
  h.advance(backoffDelayMs(0));
  expect(h.sockets).toHaveLength(1);
});

test("workspace subscriptions are sent after each auth.ok, and unsubscribing ends them", async () => {
  const h = harness();
  h.client.subscribeWorkspace(WORKSPACE_ID);
  h.client.subscribeWorkspace(OTHER_WORKSPACE_ID);
  h.client.subscribeWorkspace(WORKSPACE_ID);
  expect(h.client.workspaces()).toEqual([WORKSPACE_ID, OTHER_WORKSPACE_ID]);
  await h.authenticate();
  const subscribe = (workspaceId: WorkspaceId) => ({
    protocolVersion: 0,
    type: "workspace.subscribe",
    workspaceId,
  });
  expect(h.last().sentJson()).toEqual([
    RESPONSE,
    subscribe(WORKSPACE_ID),
    subscribe(OTHER_WORKSPACE_ID),
  ]);

  h.client.unsubscribeWorkspace(OTHER_WORKSPACE_ID);
  h.client.unsubscribeWorkspace(OTHER_WORKSPACE_ID);
  expect(h.last().sentJson().slice(3)).toEqual([
    {
      protocolVersion: 0,
      type: "workspace.unsubscribe",
      workspaceId: OTHER_WORKSPACE_ID,
    },
  ]);

  h.last().closed(1006);
  h.advance(backoffDelayMs(0));
  await h.authenticate();
  expect(h.last().sentJson()).toEqual([RESPONSE, subscribe(WORKSPACE_ID)]);

  h.client.subscribeWorkspace(OTHER_WORKSPACE_ID);
  expect(h.last().sentJson().at(-1)).toEqual(subscribe(OTHER_WORKSPACE_ID));
});

test("messages reach the listeners only after auth.ok, and a failing listener stops nothing", async () => {
  const h = harness();
  const received: ServerMessage[] = [];
  h.client.onMessage(() => {
    throw new Error("broken");
  });
  const stop = h.client.onMessage((message) => received.push(message));
  await h.authenticate();
  expect(received).toEqual([]);
  h.last().receiveJson(PRESENCE);
  expect(received).toEqual([{ kind: "frame", frame: PRESENCE }]);
  expect(h.logs).toContain("A connection message listener failed.");
  stop();
  h.last().receiveJson(PRESENCE);
  expect(received).toHaveLength(1);
});

test("a waiting connection retries now on request, within the cooldown only once", () => {
  const h = harness();
  h.last().closed(1006);
  expect(h.client.reconnect()).toEqual({ outcome: "reconnecting" });
  expect(h.sockets).toHaveLength(2);
  h.last().closed(1006);
  expect(h.client.reconnect()).toEqual({
    outcome: "refused",
    reason: "too_soon",
  });
  expect(h.sockets).toHaveLength(2);
});

test("every status fits the contract, and no status or log holds a nonce, a signature, a connection ID, or a frame", async () => {
  const h = harness();
  h.client.subscribeWorkspace(WORKSPACE_ID);
  await h.authenticate();
  h.last().receiveJson(PRESENCE);
  h.last().closed(4004, "connection_replaced");
  h.client.reconnect();
  h.last().open();
  h.last().receiveJson(CHALLENGE);
  await flush();
  h.last().receive("{");
  h.last().closed(1000);
  h.advance(60_000);
  h.last().closed(1006, "net::ERR_PROXY_CONNECTION_FAILED");

  expect(h.statuses.length).toBeGreaterThan(5);
  for (const status of h.statuses) {
    expect(ConnectionStatusSchema.parse(status)).toEqual(status);
  }
  const text = JSON.stringify([h.statuses, h.logs]);
  for (const secret of [
    NONCE,
    SIGNATURE,
    CONNECTION_ID,
    USER_ID,
    DEVICE_ID,
    WORKSPACE_ID,
    "auth.response",
    "auth.challenge",
    "ERR_PROXY",
  ]) {
    expect(text).not.toContain(secret);
  }
});

test("a status listener that throws is reported and stops nothing", () => {
  const h = harness({ status: SIGNED_OUT });
  h.client.onStatusChange(() => {
    throw new Error("broken");
  });
  h.emit(accountStatus());
  expect(h.client.status().state).toBe("connecting");
  expect(h.logs).toEqual(["A connection status listener failed."]);
});

const moduleFolder = path.dirname(fileURLToPath(import.meta.url));

test("no file of the connection client logs with console", () => {
  const names = readdirSync(moduleFolder)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .sort();
  expect(names).toEqual(["client.ts", "system.ts"]);
  for (const name of names) {
    const text = readFileSync(path.join(moduleFolder, name), "utf8");
    expect(text, name).not.toMatch(/\bconsole\./);
  }
});

test("a reconnect is refused after the server refused the device, also before the account status follows, and allowed after connection_replaced and protocol_violation", async () => {
  const cases: [number, string, string][] = [
    [4000, "auth_failed", "refused"],
    [4002, "device_revoked", "refused"],
    [4003, "sign_in_required", "refused"],
    [4004, "connection_replaced", "reconnecting"],
    [4005, "protocol_violation", "reconnecting"],
  ];
  for (const [code, reason, outcome] of cases) {
    const h = harness();
    await h.authenticate();
    // The account status still names the signed-in device.
    h.last().closed(code, reason);
    const result = h.client.reconnect();
    expect(result.outcome, reason).toBe(outcome);
    if (result.outcome === "refused") {
      expect(result.reason, reason).toBe("not_signed_in");
      expect(h.sockets, reason).toHaveLength(1);
      expect(h.client.status(), reason).toMatchObject({
        state: "stopped",
        reason,
      });
    } else {
      expect(h.sockets, reason).toHaveLength(2);
    }
  }
});

test("a reconnect is refused while a socket is open, opening, or closing before the next one", async () => {
  const h = harness();
  expect(h.client.reconnect()).toEqual({
    outcome: "refused",
    reason: "already_open",
  });
  await h.authenticate();
  expect(h.client.reconnect()).toEqual({
    outcome: "refused",
    reason: "already_open",
  });
  // The system resumed: the open socket closes, and the next one waits for it.
  h.client.systemResumed();
  expect(h.client.status().state).toBe("connecting");
  expect(h.client.reconnect()).toEqual({
    outcome: "refused",
    reason: "already_open",
  });
  expect(h.sockets).toHaveLength(1);
});

test("at most 10 reconnects within 10 minutes are accepted, so a renderer cannot exceed the API's handshake limit", () => {
  expect(RECONNECT_BUDGET).toBe(10);
  expect(RECONNECT_BUDGET_WINDOW_MS).toBe(10 * 60_000);
  const h = harness();
  const toWaiting = () => {
    if (h.client.status().state !== "waiting") {
      h.last().closed(1006);
    }
    expect(h.client.status().state).toBe("waiting");
  };
  for (let index = 0; index < RECONNECT_BUDGET; index += 1) {
    toWaiting();
    expect(h.client.reconnect(), String(index)).toEqual({
      outcome: "reconnecting",
    });
    h.advance(RECONNECT_COOLDOWN_MS);
  }
  toWaiting();
  expect(h.client.reconnect()).toEqual({
    outcome: "refused",
    reason: "too_soon",
  });
  const handshakes = h.sockets.length;

  // The first reconnect leaves the window at 10 minutes.
  h.advance(
    RECONNECT_BUDGET_WINDOW_MS - RECONNECT_BUDGET * RECONNECT_COOLDOWN_MS - 1,
  );
  toWaiting();
  expect(h.client.reconnect()).toEqual({
    outcome: "refused",
    reason: "too_soon",
  });
  h.advance(1);
  toWaiting();
  expect(h.client.reconnect()).toEqual({ outcome: "reconnecting" });
  // The backoff and the budget together stay below the API's 60 handshakes
  // per address in 10 minutes.
  expect(handshakes).toBeLessThanOrEqual(1 + RECONNECT_BUDGET + 25);
  expect(h.sockets.length).toBeLessThan(60);
});

/** A build function that records each identity it is called with. */
function recordingBuild(): {
  readonly build: (identity: ConnectionIdentity) => ClientEvent;
  readonly seen: ConnectionIdentity[];
} {
  const seen: ConnectionIdentity[] = [];
  return {
    seen,
    build: (identity) => {
      seen.push(identity);
      return chatSendAs(identity);
    },
  };
}

/**
 * Moves the harness to another device of another account, up to its auth.ok.
 * `between` runs at each step before that auth.ok: after the account change,
 * after the previous socket's close event, and while the client waits for
 * auth.ok.
 */
async function switchToOtherAccount(
  h: ReturnType<typeof harness>,
  revision: number,
  between: () => void = () => {},
): Promise<FakeSocket> {
  h.state.sign = async () => ({
    ok: true,
    frame: { ...RESPONSE, deviceId: OTHER_DEVICE_ID },
  });
  const previous = h.last();
  h.emit(accountStatus({ revision }, OTHER_DEVICE_ID));
  between();
  previous.closed(1000);
  between();
  const next = h.last();
  expect(next).not.toBe(previous);
  next.open();
  next.receiveJson(CHALLENGE);
  await flush();
  between();
  next.receiveJson({
    ...AUTH_OK,
    userId: OTHER_USER_ID,
    deviceId: OTHER_DEVICE_ID,
  });
  expect(h.client.status().state).toBe("connected");
  return next;
}

test("sendAs calls build only after auth.ok of the signed device, with that account and device", async () => {
  const h = harness();
  const { build, seen } = recordingBuild();
  const socket = h.last();
  expect(h.client.sendAs(build)).toBe("not_connected");
  socket.open();
  expect(h.client.sendAs(build)).toBe("not_connected");
  socket.receiveJson(CHALLENGE);
  // While the session signs.
  expect(h.client.sendAs(build)).toBe("not_connected");
  await flush();
  // While the client waits for auth.ok.
  expect(h.client.sendAs(build)).toBe("not_connected");
  expect(h.client.identity()).toBeNull();
  expect(seen).toEqual([]);
  expect(socket.sentJson()).toEqual([RESPONSE]);

  socket.receiveJson(AUTH_OK);
  expect(h.client.sendAs(build)).toBe("sent");
  expect(seen).toEqual([{ userId: USER_ID, deviceId: DEVICE_ID }]);
  expect(Object.isFrozen(seen[0])).toBe(true);
  // The getter gives the same frozen identity.
  expect(h.client.identity()).toBe(seen[0]);
  expect(socket.sentJson()).toEqual([RESPONSE, chatSend()]);
  // The identity reaches no status and no log.
  expect(JSON.stringify([h.statuses, h.logs])).not.toContain(USER_ID);
});

test("auth.ok of another device gives sendAs no identity", async () => {
  const h = harness();
  const { build, seen } = recordingBuild();
  const socket = h.last();
  socket.open();
  socket.receiveJson(CHALLENGE);
  await flush();
  socket.receiveJson({ ...AUTH_OK, deviceId: OTHER_DEVICE_ID });
  expect(socket.closes).toEqual([1000]);
  expect(h.client.sendAs(build)).toBe("not_connected");
  expect(h.client.identity()).toBeNull();
  expect(seen).toEqual([]);
});

test("the identity is cleared when the socket closes or is replaced, and the next auth.ok sets it again", async () => {
  const h = harness();
  const { build, seen } = recordingBuild();
  await h.authenticate();
  expect(h.client.sendAs(build)).toBe("sent");

  // The server closes the socket.
  h.last().closed(1006);
  expect(h.client.sendAs(build)).toBe("not_connected");
  expect(h.client.identity()).toBeNull();
  h.advance(backoffDelayMs(0));
  expect(h.sockets).toHaveLength(2);
  expect(h.client.sendAs(build)).toBe("not_connected");
  await h.authenticate();
  expect(h.client.sendAs(build)).toBe("sent");

  // The client replaces the socket after a resume, before and after its close event.
  h.client.systemResumed();
  expect(h.sockets[1]?.closes).toEqual([1000]);
  expect(h.client.sendAs(build)).toBe("not_connected");
  expect(h.client.identity()).toBeNull();
  h.last().closed(1000);
  expect(h.sockets).toHaveLength(3);
  expect(h.client.sendAs(build)).toBe("not_connected");
  await h.authenticate();
  expect(h.client.sendAs(build)).toBe("sent");

  // Another device of another account, from the authenticated socket: the
  // identity is cleared at the change, and only the new auth.ok sets it.
  const authenticated = h.last();
  let checks = 0;
  const other = await switchToOtherAccount(h, 2, () => {
    checks += 1;
    expect(h.client.sendAs(build)).toBe("not_connected");
    expect(h.client.identity()).toBeNull();
  });
  expect(checks).toBe(3);
  expect(authenticated.closes).toEqual([1000]);
  expect(authenticated.sent).toHaveLength(2);
  expect(h.client.sendAs(build)).toBe("sent");
  expect(h.client.identity()).toEqual({
    userId: OTHER_USER_ID,
    deviceId: OTHER_DEVICE_ID,
  });
  expect(other.sentJson().at(-1)).toMatchObject({
    actor: { kind: "user", userId: OTHER_USER_ID },
    deviceId: OTHER_DEVICE_ID,
  });
  expect(seen).toEqual([
    { userId: USER_ID, deviceId: DEVICE_ID },
    { userId: USER_ID, deviceId: DEVICE_ID },
    { userId: USER_ID, deviceId: DEVICE_ID },
    { userId: OTHER_USER_ID, deviceId: OTHER_DEVICE_ID },
  ]);
});

test("a sign-out and the quit clear the identity of an authenticated socket", async () => {
  const h = harness();
  const { build, seen } = recordingBuild();
  await h.authenticate();
  expect(h.client.sendAs(build)).toBe("sent");

  // Sign-out, before and after the socket's close event.
  h.emit(SIGNED_OUT);
  expect(h.sockets[0]?.closes).toEqual([1000]);
  expect(h.client.sendAs(build)).toBe("not_connected");
  expect(h.client.identity()).toBeNull();
  h.last().closed(1000);
  expect(h.client.sendAs(build)).toBe("not_connected");

  // Signed in again, the next auth.ok sets the identity, and the quit
  // clears it, before and after the socket's close event.
  h.emit(accountStatus({ revision: 2 }));
  expect(h.sockets).toHaveLength(2);
  await h.authenticate();
  expect(h.client.sendAs(build)).toBe("sent");
  h.client.close();
  expect(h.last().closes).toEqual([1000]);
  expect(h.client.sendAs(build)).toBe("not_connected");
  expect(h.client.identity()).toBeNull();
  h.last().closed(1000);
  expect(h.client.sendAs(build)).toBe("not_connected");
  expect(h.sockets.map((socket) => socket.sent.length)).toEqual([2, 2]);
  expect(seen).toEqual([
    { userId: USER_ID, deviceId: DEVICE_ID },
    { userId: USER_ID, deviceId: DEVICE_ID },
  ]);
});

test("a send after the socket changed uses the new identity, and an event built for the old one is refused", async () => {
  const h = harness();
  await h.authenticate();
  const kept: ConnectionIdentity[] = [];
  expect(
    h.client.sendAs((identity) => {
      kept.push(identity);
      return chatSendAs(identity);
    }),
  ).toBe("sent");
  const old = kept[0];
  if (old === undefined) {
    throw new Error("build was not called");
  }

  const other = await switchToOtherAccount(h, 2);
  // A caller that kept the old identity across the change sends nothing,
  // and the connection stays open.
  expect(h.client.sendAs(() => chatSendAs(old))).toBe("invalid");
  expect(other.sent).toHaveLength(1);
  expect(h.client.status().state).toBe("connected");

  // A build that replaces the socket itself sends on neither socket.
  expect(
    h.client.sendAs((identity) => {
      h.client.systemResumed();
      return chatSendAs(identity);
    }),
  ).toBe("not_connected");
  expect(other.sent).toHaveLength(1);
  expect(other.closes).toEqual([1000]);
});

test("events go only through sendAs, which refuses buffered data, oversized and unknown messages, and events that the server would not bind", async () => {
  const h = harness();
  await h.authenticate();
  const socket = h.last();
  const asIs = (identity: ConnectionIdentity) => chatSendAs(identity);
  // No other member sends an event.
  expect("send" in h.client).toBe(false);

  socket.buffered = MAX_BUFFERED_SEND_BYTES + 1;
  expect(h.client.sendAs(asIs)).toBe("backpressure");
  socket.buffered = MAX_BUFFERED_SEND_BYTES;
  expect(h.client.sendAs(asIs)).toBe("sent");

  expect(
    h.client.sendAs((identity) => chatSendAs(identity, "x".repeat(70_000))),
  ).toBe("too_large");
  expect(
    h.client.sendAs(
      (identity) =>
        ({ ...chatSendAs(identity), deviceId: null }) as unknown as ClientEvent,
    ),
  ).toBe("invalid");
  // A valid client frame is not an event.
  expect(
    h.client.sendAs(
      () =>
        ({
          protocolVersion: PROTOCOL_VERSION,
          type: "workspace.subscribe",
          workspaceId: WORKSPACE_ID,
        }) as unknown as ClientEvent,
    ),
  ).toBe("invalid");
  // An event of another protocol version.
  expect(
    h.client.sendAs(
      (identity) =>
        ({
          ...chatSendAs(identity),
          protocolVersion: PROTOCOL_VERSION + 1,
        }) as unknown as ClientEvent,
    ),
  ).toBe("invalid");
  // Something that JSON cannot carry.
  for (const value of [undefined, () => undefined, 1n]) {
    expect(h.client.sendAs(() => value as unknown as ClientEvent)).toBe(
      "invalid",
    );
  }
  expect(
    h.client.sendAs(
      (identity) =>
        ({
          ...chatSendAs(identity),
          payload: { projectId: PROJECT_ID, body: 1n },
        }) as unknown as ClientEvent,
    ),
  ).toBe("invalid");
  // Another device, or another account as the actor: the server would close
  // the connection with identity_mismatch.
  expect(
    h.client.sendAs(
      (identity) =>
        ({
          ...chatSendAs(identity),
          deviceId: OTHER_DEVICE_ID,
        }) as unknown as ClientEvent,
    ),
  ).toBe("invalid");
  expect(
    h.client.sendAs(
      (identity) =>
        ({
          ...chatSendAs(identity),
          actor: { kind: "user", userId: OTHER_USER_ID },
        }) as unknown as ClientEvent,
    ),
  ).toBe("invalid");
  expect(
    h.client.sendAs(() => {
      throw new Error("no event");
    }),
  ).toBe("invalid");

  // Only what the protocol knows is sent, not the caller's extra fields.
  expect(
    h.client.sendAs((identity) => {
      const event = chatSendAs(identity) as unknown as Record<string, unknown>;
      return {
        ...event,
        secret: "kept local",
        payload: {
          ...(event["payload"] as Record<string, unknown>),
          secret: "kept local",
        },
      } as unknown as ClientEvent;
    }),
  ).toBe("sent");
  expect(socket.sent).toHaveLength(3);
  expect(socket.sent.at(-1)).not.toContain("kept local");
  expect(socket.sentJson().at(-1)).toEqual(chatSend());
  expect(socket.closes).toEqual([]);
  expect(h.client.status().state).toBe("connected");
});

test("sendAs sends an event of an agent actor from the identity's device, and refuses it from another device", async () => {
  const h = harness();
  await h.authenticate();
  const socket = h.last();
  /** A run transition that the agent's host device reports. */
  const runStarted = (deviceId: DeviceId): ClientEvent =>
    ({
      protocolVersion: PROTOCOL_VERSION,
      id: EVENT_ID,
      type: "agent.run.state_changed",
      occurredAt: "2026-11-03T10:00:00.000Z",
      workspaceId: WORKSPACE_ID,
      actor: { kind: "agent", agentId: AGENT_ID },
      deviceId,
      payload: {
        runId: RUN_ID,
        agentId: AGENT_ID,
        previousState: "queued",
        state: "running",
      },
    }) as unknown as ClientEvent;

  // The account binds no agent actor; the device does.
  expect(
    h.client.sendAs((identity) => ({
      ...runStarted(identity.deviceId),
      secret: "kept local",
    })),
  ).toBe("sent");
  expect(socket.sent.at(-1)).not.toContain("kept local");
  expect(socket.sentJson().at(-1)).toEqual(runStarted(DEVICE_ID));
  expect(h.client.sendAs(() => runStarted(OTHER_DEVICE_ID))).toBe("invalid");
  expect(socket.sent).toHaveLength(2);
  expect(socket.closes).toEqual([]);
});
