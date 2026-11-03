import {
  API_ERROR_CODES,
  type DeviceId,
  type DeviceListItem,
  type UserId,
} from "@mymandev/protocol";
import { expect, test } from "vitest";
import {
  DEVICE_ACTION_FAILURES,
  DEVICE_STATES,
  DeviceViewSchema,
} from "../shared/ipc-contract.ts";
import {
  deviceActionFailure,
  deviceStateOf,
  deviceViewOf,
  REMOVE_DEVICE_CONFIRMATION,
  removeDeviceConfirmationMessage,
  removeDeviceConfirmed,
} from "./account-session.ts";
import {
  type DeviceSessionState,
  SESSION_FAILURE_REASONS,
  type SessionAccount,
  type SessionFailure,
} from "./session/session.ts";

const ACCOUNT: SessionAccount = Object.freeze({
  deviceId: "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3" as DeviceId,
  userId: "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a4" as UserId,
  login: "octocat",
  displayName: "The Octocat",
  signInExpiresAt: "2026-12-02T10:00:00.000Z",
});

test("every state of the session has its own device state code, and an unknown one is unavailable", () => {
  const states: DeviceSessionState[] = [
    { kind: "starting" },
    { kind: "no_device" },
    { kind: "key_lost", account: ACCOUNT },
    { kind: "unavailable", reason: "key_store_failed" },
    { kind: "key_not_loaded", account: ACCOUNT },
    { kind: "signed_in", account: ACCOUNT },
    { kind: "signed_out", account: ACCOUNT, reportPending: false },
    { kind: "signed_out", account: ACCOUNT, reportPending: true },
    { kind: "sign_in_required", account: ACCOUNT },
    { kind: "auth_failed", account: ACCOUNT },
    { kind: "account_mismatch", account: ACCOUNT },
    { kind: "removal_pending", account: ACCOUNT },
    { kind: "removed" },
    { kind: "revoked" },
  ];
  const codes = states.map(deviceStateOf);

  expect(codes).toEqual([
    "starting",
    "no_device",
    "key_lost",
    "unavailable",
    "key_not_loaded",
    "signed_in",
    "signed_out",
    "sign_out_report_pending",
    "sign_in_required",
    "auth_failed",
    "account_mismatch",
    "removal_pending",
    "removed",
    "revoked",
  ]);
  expect([...codes].sort()).toEqual([...DEVICE_STATES].sort());
  expect(deviceStateOf({ kind: "paused" } as never)).toBe("unavailable");
});

test("every failure of the session maps to a fixed code, an API code the screens explain to itself, and any other to refused", () => {
  for (const reason of SESSION_FAILURE_REASONS) {
    const code = deviceActionFailure({ ok: false, reason });
    expect(DEVICE_ACTION_FAILURES).toContain(code);
    if (reason === "invalid_request") {
      expect(code).toBe("failed");
    } else if (reason === "refused") {
      expect(code).toBe("refused");
    } else {
      expect(code).toBe(reason);
    }
  }
  const explained = [
    "sign_in_required",
    "auth_failed",
    "device_revoked",
    "device_account_mismatch",
    "rate_limited",
  ];
  for (const apiCode of API_ERROR_CODES) {
    expect(
      deviceActionFailure({ ok: false, reason: "refused", code: apiCode }),
    ).toBe(explained.includes(apiCode) ? apiCode : "refused");
  }
  for (const failure of [
    { ok: false, reason: "refused", code: "toString" },
    { ok: false, reason: "refused", code: "constructor" },
    { ok: false, reason: "disk_full" },
  ]) {
    const code = deviceActionFailure(failure as unknown as SessionFailure);
    expect(["refused", "failed"]).toContain(code);
  }
});

test("a device of the list keeps only the fields that the renderer may see", () => {
  const item = {
    id: "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3",
    label: "Mac",
    platform: "macos",
    createdAt: "2026-10-01T10:00:00.000Z",
    lastSeenAt: null,
    lastSignInAt: "2026-11-01T10:00:00.000Z",
    signInExpiresAt: "2026-12-01T10:00:00.000Z",
    revokedAt: "2026-11-02T10:00:00.000Z",
    current: false,
    publicKey: "ab".repeat(32),
  } as unknown as DeviceListItem;

  const view = deviceViewOf(item);

  expect(view).toEqual({
    id: "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3",
    label: "Mac",
    platform: "macos",
    lastSeenAt: null,
    signInExpiresAt: "2026-12-01T10:00:00.000Z",
    revokedAt: "2026-11-02T10:00:00.000Z",
    current: false,
  });
  expect(Object.isFrozen(view)).toBe(true);
  expect(DeviceViewSchema.parse(view)).toEqual(view);
});

test("the confirmation of removing this device names the login, offers Keep as the default, and only the remove button confirms", () => {
  expect(REMOVE_DEVICE_CONFIRMATION).toEqual({
    type: "warning",
    buttons: ["Remove this device", "Keep"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title: "Remove this device",
    detail:
      "The device is removed from the account, and its device key is deleted on this computer once the server confirms. While offline, the removal waits. Sign in with GitHub again to add this computer as a new device.",
  });
  expect(Object.isFrozen(REMOVE_DEVICE_CONFIRMATION)).toBe(true);
  expect(Object.isFrozen(REMOVE_DEVICE_CONFIRMATION.buttons)).toBe(true);
  expect(removeDeviceConfirmationMessage("octocat")).toBe(
    "Remove this device from the GitHub account octocat?",
  );
  expect(removeDeviceConfirmed({ response: 0 })).toBe(true);
  for (const response of [1, 2, -1]) {
    expect(removeDeviceConfirmed({ response })).toBe(false);
  }
});
