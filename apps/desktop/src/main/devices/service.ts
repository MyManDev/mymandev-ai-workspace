// The device list service (#95; decisions D4 and D5b of 2026-11-06): the
// account's devices and the end of a registration lock in force, in the
// main process, read with the account service's `readDeviceList`
// (`GET /devices`), and the notices of new devices from the live
// `account.device_registered` frame.
//
// - The list loads once the Account screen asked for it (`load`). From then
//   on, while the application runs, it loads again when a device becomes
//   signed in, when the connection reaches `connected` (account frames sent
//   while it was offline are lost), when `account.device_registered` or
//   `account.device_revoked` arrives, and after a device action of the
//   person (the account service's `onDeviceAction`). The screen's request is
//   refused within `DEVICE_LIST_LOAD_COOLDOWN_MS` of the last one, so that a
//   renderer that misbehaves cannot read the API in a loop.
// - One load runs at a time, and none while a sign-in runs, which the
//   account service answers `unavailable` while the status may already show
//   the device signed in; the load waits for its end. A load asked for while
//   one is on its way drops that answer and loads again, so only an answer
//   that was asked for after the last trigger applies. A failed load is
//   retried with the workspace service's backoff while connected; offline,
//   the next `connected` loads.
// - A notice of a new device stays until the person dismisses it, the
//   device is revoked (its `account.device_revoked`, or a list that shows it
//   revoked), or the list is dropped. The reloads that the frame itself, the
//   connection, or the Account screen start do not end it, so that the
//   person sees it also when the Account screen opens later.
// - A sign-out, another account, or another device drops the list, the
//   lock, and the notices, and the answers on their way.
//
// The state holds no user ID or token: the API's device list has none. The
// logs are fixed text with a failure code at most, never a label or an ID.
import type {
  AccountDeviceRegisteredFrame,
  DeviceId,
  DeviceListItem,
} from "@mymandev/protocol";
import type { AccountStatus } from "../../shared/ipc-contract.ts";
import type { AccountService } from "../account.ts";
import type {
  WorkspaceReadFailure,
  WorkspaceReadResult,
} from "../api-reads.ts";
import type { ConnectionClient, ServerMessage } from "../connection/client.ts";
import type { ScheduleTimer } from "../runtime.ts";
import type { DeviceList } from "../session/session.ts";
import { workspaceRetryDelayMs } from "../workspace/service.ts";

/**
 * How long after the Account screen's last request for the list the next
 * one is refused (`too_soon`).
 */
export const DEVICE_LIST_LOAD_COOLDOWN_MS = 2_000;

/**
 * The most notices of new devices that the service keeps, the newest ones:
 * an account registers at most 10 new devices in 24 hours (ADR 0014).
 */
export const MAX_NEW_DEVICE_NOTICES = 10;

/**
 * - `signed_out`: no signed-in device with a ready key; the state is empty.
 * - `loading`: the list has not loaded yet for this device. The Account
 *   screen asks for it when it opens.
 * - `ready`: it loaded. It stays `ready` during later loads.
 * - `unavailable`: the last load failed; `problem` holds the failure until a
 *   load succeeds. What was loaded before stays.
 */
export type DeviceListStatus =
  "signed_out" | "loading" | "ready" | "unavailable";

/** A new device of the account, from `account.device_registered`. */
export interface NewDeviceNotice {
  readonly id: DeviceId;
  readonly label: string;
  readonly platform: DeviceListItem["platform"];
  readonly createdAt: string;
}

/** The service's state. Every value is frozen. */
export interface DeviceListState {
  /** Grows by one with every change. */
  readonly revision: number;
  readonly status: DeviceListStatus;
  /** Only with `unavailable`. */
  readonly problem?: WorkspaceReadFailure;
  /** The API's list, in its order: the most recently created first. */
  readonly devices: readonly DeviceListItem[];
  /** The end of a registration lock in force when the list was read, or null. */
  readonly registrationLockedUntil: string | null;
  /** The notices of new devices, the oldest first. */
  readonly newDevices: readonly NewDeviceNotice[];
}

/** The answer to the Account screen's request for the list. */
export type DeviceListLoadOutcome =
  | { readonly outcome: "loading" }
  | {
      readonly outcome: "refused";
      readonly reason: "not_signed_in" | "too_soon";
    };

/** The part of the account service that the device list service uses. */
export type DeviceListAccount = Pick<
  AccountService,
  "status" | "onStatusChange" | "readDeviceList" | "onDeviceAction"
>;

/**
 * The part of the connection client that the device list service uses. It
 * holds no way to send.
 */
export type DeviceListConnection = Pick<
  ConnectionClient,
  "status" | "onStatusChange" | "onMessage"
>;

export interface DeviceListServiceOptions {
  readonly account: DeviceListAccount;
  readonly connection: DeviceListConnection;
  /** Defaults to `setTimeout`. */
  readonly scheduleTimer?: ScheduleTimer;
  /** A monotonic clock in milliseconds; defaults to `performance.now`. */
  readonly now?: () => number;
  /**
   * Receives fixed messages with a failure code at most, never a label or
   * an ID. An error that it throws is ignored.
   */
  readonly log?: (message: string) => void;
}

export interface DeviceListService {
  /** The current state. */
  readonly state: () => DeviceListState;
  /** Calls `listener` after every change. The result removes the listener. */
  readonly onChange: (listener: (state: DeviceListState) => void) => () => void;
  /**
   * The Account screen asks for the list: it loads now, and from then on
   * after every trigger. Refused without a signed-in device, and within
   * `DEVICE_LIST_LOAD_COOLDOWN_MS` of the last accepted request.
   */
  readonly load: () => DeviceListLoadOutcome;
  /** Ends the notices of new devices; false when there was none. */
  readonly dismissNewDevices: () => boolean;
  /** Stops listening and cancels the retry, for the quit. */
  readonly close: () => void;
}

const LOADING: DeviceListLoadOutcome = Object.freeze({ outcome: "loading" });
const NOT_SIGNED_IN: DeviceListLoadOutcome = Object.freeze({
  outcome: "refused",
  reason: "not_signed_in",
});
const TOO_SOON: DeviceListLoadOutcome = Object.freeze({
  outcome: "refused",
  reason: "too_soon",
});
const NO_DEVICES: readonly DeviceListItem[] = Object.freeze([]);
const NO_NOTICES: readonly NewDeviceNotice[] = Object.freeze([]);

/**
 * The signed-in device, or null, under the same condition as the workspace
 * service. The device ID is only compared; it never reaches a log.
 */
function signedInDevice(status: AccountStatus): string | null {
  if (
    status.apiOrigin === "set" &&
    status.device === "signed_in" &&
    status.deviceKey === "ready" &&
    status.account.kind === "signed_in"
  ) {
    return status.account.deviceId;
  }
  return null;
}

function scheduleWithSetTimeout(
  callback: () => void,
  delayMs: number,
): () => void {
  const handle = setTimeout(callback, delayMs);
  return () => clearTimeout(handle);
}

function noticeOf(
  device: AccountDeviceRegisteredFrame["device"],
): NewDeviceNotice {
  return Object.freeze({
    id: device.id,
    label: device.label,
    platform: device.platform,
    createdAt: device.createdAt,
  });
}

export function createDeviceListService(
  options: DeviceListServiceOptions,
): DeviceListService {
  const { account, connection } = options;
  const schedule = options.scheduleTimer ?? scheduleWithSetTimeout;
  const now = options.now ?? (() => performance.now());

  function log(message: string): void {
    try {
      options.log?.(message);
    } catch {
      // A failing log changes nothing.
    }
  }

  let closed = false;
  /** The signed-in device, compared only; see `signedInDevice`. */
  let device: string | null = null;
  /** Changes with every reset, so that an answer for an earlier device is dropped. */
  let epoch = 0;
  let connected = false;
  /**
   * Whether the account status shows a sign-in that runs. The account
   * service answers every read `unavailable` until it ended, and it may
   * show the device signed in before that, so a load waits for it.
   */
  let signInRunning = false;
  /** A load waits for the sign-in that runs to end. */
  let loadWaiting = false;
  /**
   * Whether the Account screen asked for the list since the application
   * started. Until then nothing loads; the notices are kept all the same.
   */
  let requested = false;
  /** When the screen's last request was accepted, or null. */
  let lastRequest: number | null = null;

  let list: DeviceList | null = null;
  let problem: WorkspaceReadFailure | null = null;
  let notices: readonly NewDeviceNotice[] = NO_NOTICES;
  let inFlight = false;
  /** A load was asked for while one was on its way: its answer is dropped. */
  let again = false;
  /** The failed loads in a row, for the backoff. */
  let attempt = 0;
  let cancelRetry: (() => void) | null = null;

  let revision = 0;
  let dirty = false;
  let current = buildState();
  const listeners = new Set<(state: DeviceListState) => void>();

  function buildState(): DeviceListState {
    const base = {
      revision,
      devices: list?.devices ?? NO_DEVICES,
      registrationLockedUntil: list?.registrationLockedUntil ?? null,
      newDevices: notices,
    };
    if (device === null) {
      return Object.freeze({ ...base, status: "signed_out" });
    }
    if (problem !== null) {
      return Object.freeze({ ...base, status: "unavailable", problem });
    }
    return Object.freeze({
      ...base,
      status: list === null ? "loading" : "ready",
    });
  }

  function touch(): void {
    dirty = true;
  }

  function flush(): void {
    if (!dirty || closed) {
      return;
    }
    dirty = false;
    revision += 1;
    const state = buildState();
    current = state;
    for (const listener of [...listeners]) {
      // A listener that changed the state again has notified everyone of
      // the newer state already.
      if (current !== state) {
        return;
      }
      try {
        listener(state);
      } catch {
        log("A device list state listener failed.");
      }
    }
  }

  /** Runs one entry point and then publishes what it changed. */
  function run<T>(action: () => T): T {
    try {
      return action();
    } finally {
      flush();
    }
  }

  function stopRetry(): void {
    cancelRetry?.();
    cancelRetry = null;
  }

  /** Forgets everything: a sign-out, another account, or another device. */
  function reset(): void {
    epoch += 1;
    // The answer on its way is dropped by the epoch, so the next load need
    // not wait for it.
    inFlight = false;
    again = false;
    loadWaiting = false;
    stopRetry();
    list = null;
    problem = null;
    notices = NO_NOTICES;
    attempt = 0;
    touch();
  }

  /**
   * Loads the list, once the Account screen asked for it, for the device
   * that is signed in. While a sign-in runs, the load waits for it to end.
   * While a load is on its way, its answer is dropped and the list loads
   * again after it.
   */
  function reload(): void {
    if (closed || device === null || !requested) {
      return;
    }
    stopRetry();
    if (signInRunning) {
      loadWaiting = true;
      return;
    }
    if (inFlight) {
      again = true;
      return;
    }
    send();
  }

  function send(): void {
    inFlight = true;
    again = false;
    const sent = epoch;
    void account
      .readDeviceList()
      .catch((): WorkspaceReadResult<never> => ({
        ok: false,
        reason: "unavailable",
      }))
      .then((result) => run(() => answered(sent, result)));
  }

  function answered(
    sent: number,
    result: WorkspaceReadResult<DeviceList>,
  ): void {
    if (closed || sent !== epoch) {
      // The reset already let the next load go.
      return;
    }
    inFlight = false;
    if (again) {
      // A trigger came after this load was sent: only a newer answer counts.
      send();
      return;
    }
    if (!result.ok) {
      loadFailed(result.reason);
      return;
    }
    list = result.value;
    problem = null;
    attempt = 0;
    const revoked = new Set<string>(
      result.value.devices
        .filter((item) => item.revokedAt !== null)
        .map((item) => item.id),
    );
    dropNotices((notice) => revoked.has(notice.id));
    touch();
  }

  function loadFailed(reason: WorkspaceReadFailure): void {
    problem = reason;
    touch();
    log(`The device list did not load (${reason}).`);
    // Offline, the next `connected` loads anyway.
    if (connected) {
      scheduleRetry(workspaceRetryDelayMs(attempt, reason));
    }
    attempt += 1;
  }

  function scheduleRetry(delayMs: number): void {
    stopRetry();
    cancelRetry = schedule(() => {
      run(() => {
        cancelRetry = null;
        reload();
      });
    }, delayMs);
  }

  /** Drops the notices that `ended` names. */
  function dropNotices(ended: (notice: NewDeviceNotice) => boolean): void {
    if (notices.some(ended)) {
      notices = Object.freeze(notices.filter((notice) => !ended(notice)));
      touch();
    }
  }

  function addNotice(notice: NewDeviceNotice): void {
    notices = Object.freeze(
      [...notices.filter((held) => held.id !== notice.id), notice].slice(
        -MAX_NEW_DEVICE_NOTICES,
      ),
    );
    touch();
  }

  function messageReceived(message: ServerMessage): void {
    if (device === null || message.kind !== "frame") {
      return;
    }
    const frame = message.frame;
    switch (frame.type) {
      case "account.device_registered":
        // The frame never names the receiving device (protocol); one that
        // does makes no notice.
        if (frame.device.id !== device) {
          addNotice(noticeOf(frame.device));
        }
        reload();
        return;
      case "account.device_revoked": {
        const revokedId: string = frame.deviceId;
        dropNotices((notice) => notice.id === revokedId);
        reload();
        return;
      }
      default:
        // The workspace services follow the other frames.
        return;
    }
  }

  function accountChanged(status: AccountStatus): void {
    const next = signedInDevice(status);
    if (next !== device) {
      if (device !== null) {
        reset();
      }
      device = next;
      touch();
      // The new device's list loads once no sign-in runs.
      loadWaiting = next !== null;
    }
    signInRunning = status.signIn.kind !== "idle";
    if (loadWaiting && !signInRunning) {
      loadWaiting = false;
      reload();
    }
  }

  function connectionChanged(state: string): void {
    const isConnected = state === "connected";
    if (isConnected === connected) {
      return;
    }
    connected = isConnected;
    if (isConnected) {
      // Account frames sent while the device was offline are lost.
      reload();
      return;
    }
    // The next `connected` loads; a retry offline would wait for it anyway.
    stopRetry();
  }

  function load(): DeviceListLoadOutcome {
    if (closed || device === null) {
      return NOT_SIGNED_IN;
    }
    const at = now();
    if (
      lastRequest !== null &&
      at - lastRequest < DEVICE_LIST_LOAD_COOLDOWN_MS
    ) {
      return TOO_SOON;
    }
    lastRequest = at;
    requested = true;
    reload();
    return LOADING;
  }

  function dismissNewDevices(): boolean {
    if (closed || notices.length === 0) {
      return false;
    }
    notices = NO_NOTICES;
    touch();
    return true;
  }

  const removers = [
    account.onStatusChange((status) => run(() => accountChanged(status))),
    account.onDeviceAction(() => run(() => reload())),
    connection.onStatusChange((status) =>
      run(() => connectionChanged(status.state)),
    ),
    connection.onMessage((message) => run(() => messageReceived(message))),
  ];
  accountChanged(account.status());
  connectionChanged(connection.status().state);
  // The first state is revision 0.
  current = buildState();
  dirty = false;

  return Object.freeze({
    state: () => current,
    onChange: (listener: (state: DeviceListState) => void) => {
      const entry = (state: DeviceListState) => listener(state);
      listeners.add(entry);
      return () => {
        listeners.delete(entry);
      };
    },
    load: () => run(load),
    dismissNewDevices: () => run(dismissNewDevices),
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      for (const remove of removers) {
        remove();
      }
      listeners.clear();
      stopRetry();
    },
  });
}
