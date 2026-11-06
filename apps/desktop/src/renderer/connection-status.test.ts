import { expect, test } from "vitest";
import {
  CONNECTION_OFFLINE_REASONS,
  CONNECTION_STOP_REASONS,
  CONNECTION_WAITING_REASONS,
  type ConnectionStatus,
} from "../shared/ipc-contract.ts";
import {
  describeConnectionView,
  initialConnectionView,
} from "./connection-status.ts";

const RETRY_AT = "2026-11-03T10:00:01.000Z";

function known(status: ConnectionStatus) {
  return describeConnectionView({ kind: "known", status });
}

test("the view starts pending with the bridge and unavailable without it", () => {
  expect(initialConnectionView(true)).toEqual({ kind: "pending" });
  expect(initialConnectionView(false)).toEqual({ kind: "unavailable" });
  expect(describeConnectionView({ kind: "pending" })).toEqual({
    tone: "unknown",
    label: "Cloud: Checking",
    detail: null,
    action: null,
  });
  expect(describeConnectionView({ kind: "unavailable" })).toEqual({
    tone: "unknown",
    label: "Cloud: Unavailable",
    detail: null,
    action: null,
  });
});

test("the states without a reason have their own label and no action", () => {
  expect(
    (["connecting", "authenticating", "connected"] as const).map((state) =>
      known({ state, revision: 1 }),
    ),
  ).toEqual([
    {
      tone: "connecting",
      label: "Cloud: Connecting",
      detail: null,
      action: null,
    },
    {
      tone: "authenticating",
      label: "Cloud: Authenticating",
      detail: null,
      action: null,
    },
    {
      tone: "connected",
      label: "Cloud: Connected",
      detail: null,
      action: null,
    },
  ]);
  expect(known({ state: "offline", revision: 1 })).toEqual({
    tone: "offline",
    label: "Cloud: Offline",
    detail: null,
    action: null,
  });
});

test("every reason has its own fixed sentence", () => {
  const details = [
    ...CONNECTION_OFFLINE_REASONS.map(
      (reason) => known({ state: "offline", reason, revision: 1 }).detail,
    ),
    ...CONNECTION_WAITING_REASONS.map(
      (reason) =>
        known({ state: "waiting", reason, retryAt: RETRY_AT, revision: 1 })
          .detail,
    ),
    ...CONNECTION_STOP_REASONS.map(
      (reason) => known({ state: "stopped", reason, revision: 1 }).detail,
    ),
  ];
  for (const detail of details) {
    expect(detail).toMatch(/^[A-Z].*\.$/);
  }
  expect(new Set(details).size).toBe(details.length);
});

test("waiting offers Retry now, and only connection_replaced offers Reconnect here once", () => {
  for (const reason of CONNECTION_WAITING_REASONS) {
    expect(
      known({ state: "waiting", reason, retryAt: RETRY_AT, revision: 1 }),
    ).toMatchObject({
      tone: "waiting",
      label: "Cloud: Waiting to reconnect",
      action: "retry_now",
    });
  }
  const actions = Object.fromEntries(
    CONNECTION_STOP_REASONS.map((reason) => [
      reason,
      known({ state: "stopped", reason, revision: 1 }).action,
    ]),
  );
  expect(actions).toEqual({
    auth_failed: null,
    device_revoked: null,
    sign_in_required: null,
    connection_replaced: "reconnect_here",
    protocol_violation: "retry_now",
    update_required: null,
  });
  expect(
    known({ state: "stopped", reason: "sign_in_required", revision: 1 }),
  ).toEqual({
    tone: "stopped",
    label: "Cloud: Stopped",
    detail: "Sign in with GitHub on the Account screen to connect again.",
    action: null,
  });
});
