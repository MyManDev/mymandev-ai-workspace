// The grant store behind the real connection client (#316): a connection
// that stops carrying messages closes within the liveness bound, and the
// store, which follows the client's status, becomes unusable at the same
// moment. The socket, the account service, and the workspace service are
// fakes; the timers are injected.
import {
  CONNECTION_HEARTBEAT_INTERVAL_MS,
  CONNECTION_LIVENESS_BOUND_MS,
  GrantRecordListResponseSchema,
  type AuthResponseFrame,
  type DeviceId,
  type GrantRecordListResponse,
  type WorkspaceId,
} from "@mymandev/protocol";
import { GrantRecordSchema } from "@mymandev/permissions";
import { expect, test } from "vitest";
import type { AccountStatus } from "../../shared/ipc-contract.ts";
import type { WorkspaceReadResult } from "../api-reads.ts";
import {
  createConnectionClient,
  type SocketEvents,
} from "../connection/client.ts";
import type { WorkspaceState } from "../workspace/service.ts";
import { createGrantStore, type GrantStoreOptions } from "./grant-store.ts";

function id(n: number): string {
  return `0192f0a0-7b3c-7d4e-8f50-${n.toString(16).padStart(12, "0")}`;
}

const WORKSPACE = id(0xa1) as WorkspaceId;
const DEVICE = id(0xb1) as DeviceId;
const USER = id(0xc1);
const PROJECT = id(0xd1);
const AGENT = id(0xe1);
const REPOSITORY = id(0xf1);
const T0 = "2026-11-23T10:00:00.000Z";

const RECORDS: GrantRecordListResponse = GrantRecordListResponseSchema.parse({
  records: [
    GrantRecordSchema.parse({
      grant: {
        id: id(0x101),
        projectId: PROJECT,
        granteeAgentId: AGENT,
        capability: "repo.read",
        repositoryId: REPOSITORY,
        grantedByUserId: USER,
        createdAt: T0,
        expiresAt: null,
        revokedAt: null,
        revokedByUserId: null,
      },
      facts: {
        agent: { id: AGENT, hostDeviceId: DEVICE, disabledAt: null },
        hostDevice: { id: DEVICE, revokedAt: null },
        project: { id: PROJECT, workspaceId: WORKSPACE },
        grantorMembership: {
          workspaceId: WORKSPACE,
          userId: USER,
          removedAt: null,
        },
        providerConnection: null,
      },
    }),
  ],
});

const STATUS = Object.freeze({
  revision: 1,
  account: Object.freeze({
    kind: "signed_in",
    login: "octocat",
    displayName: "The Octocat",
    deviceId: DEVICE,
    signInExpiresAt: "2026-12-23T10:00:00.000Z",
  }),
  signIn: Object.freeze({ kind: "idle" }),
  lastOutcome: null,
  deviceKey: "ready",
  replacementPending: false,
  apiOrigin: "set",
  device: "signed_in",
}) as AccountStatus;

const RESPONSE = Object.freeze({
  protocolVersion: 0,
  type: "auth.response",
  deviceId: DEVICE,
  signature: Buffer.alloc(64, 9).toString("base64url"),
}) as AuthResponseFrame;

function setup() {
  let clock = 0;
  const timers: { at: number; callback: () => void; active: boolean }[] = [];
  const sockets: { events: SocketEvents; closes: number[] }[] = [];
  const reads: ((result: WorkspaceReadResult<unknown>) => void)[] = [];
  const schedule = (callback: () => void, delayMs: number) => {
    const timer = { at: clock + delayMs, callback, active: true };
    timers.push(timer);
    return () => {
      timer.active = false;
    };
  };
  const account = {
    status: () => STATUS,
    onStatusChange: () => () => undefined,
    signWebSocketChallenge: async () => ({ ok: true, frame: RESPONSE }),
    deviceRefused: async () => undefined,
    readWorkspaceData: (() =>
      new Promise((resolve) => {
        reads.push(resolve);
      })) as unknown as GrantStoreOptions["account"]["readWorkspaceData"],
    onReadsResumed: () => () => undefined,
  };
  const client = createConnectionClient({
    apiOrigin: { ok: true, origin: "https://api.mymandev.example" },
    account: account as unknown as Parameters<
      typeof createConnectionClient
    >[0]["account"],
    openSocket: (_url, events) => {
      const socket = { events, closes: [] as number[] };
      sockets.push(socket);
      return {
        bufferedAmount: () => 0,
        send: () => undefined,
        close: (code) => {
          socket.closes.push(code);
        },
      };
    },
    scheduleTimer: schedule,
    now: () => clock,
    wallClock: () => Date.parse(T0) + clock,
    random: () => 0,
  });
  const store = createGrantStore({
    account,
    connection: client,
    workspaces: {
      state: () =>
        ({
          revision: 0,
          status: "ready",
          workspaces: [],
          selectedWorkspaceId: WORKSPACE,
          projects: [],
          openProjectId: null,
        }) as WorkspaceState,
      onChange: () => () => undefined,
    },
    scheduleTimer: schedule,
    wallClock: () => Date.parse(T0) + clock,
  });

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

  function receive(value: unknown): void {
    const socket = sockets.at(-1);
    if (socket === undefined) {
      throw new Error("No socket was opened.");
    }
    socket.events.message(JSON.stringify(value));
  }

  return { client, store, sockets, reads, advance, receive };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 3; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("a connection that stops carrying messages closes within 45 seconds, and the grant store is unusable at that moment", async () => {
  const h = setup();
  h.sockets[0]?.events.open();
  h.receive({
    protocolVersion: 0,
    type: "auth.challenge",
    nonce: Buffer.alloc(32, 7).toString("base64url"),
    connectionId: id(0x0b),
  });
  await settle();
  h.receive({
    protocolVersion: 0,
    type: "auth.ok",
    userId: USER,
    deviceId: DEVICE,
    signInExpiresAt: "2026-12-23T10:00:00.000Z",
  });
  expect(h.client.status().state).toBe("connected");
  h.receive({
    protocolVersion: 0,
    type: "workspace.subscribed",
    workspaceId: WORKSPACE,
    onlineMemberIds: [],
  });
  expect(h.reads).toHaveLength(1);
  h.reads[0]?.({ ok: true, value: RECORDS });
  await settle();
  expect(h.store.read()).toEqual({ usable: true, records: RECORDS.records });

  // Heartbeats keep the connection, and with it the store.
  for (let beat = 0; beat < 6; beat += 1) {
    h.advance(CONNECTION_HEARTBEAT_INTERVAL_MS);
    h.receive({ protocolVersion: 0, type: "connection.heartbeat" });
  }
  expect(h.store.read().usable).toBe(true);
  let signals = 0;
  h.store.onGrantsChanged(() => {
    signals += 1;
  });

  // Then the network goes silent.
  h.advance(CONNECTION_LIVENESS_BOUND_MS - 1);
  expect(h.store.read().usable).toBe(true);
  expect(h.sockets[0]?.closes).toEqual([]);
  h.advance(1);
  expect(h.sockets[0]?.closes).toEqual([1000]);
  expect(h.client.status()).toMatchObject({
    state: "waiting",
    reason: "connection_lost",
  });
  expect(h.store.read()).toEqual({ usable: false, records: [] });
  expect(signals).toBe(1);
  h.client.close();
  h.store.close();
});
