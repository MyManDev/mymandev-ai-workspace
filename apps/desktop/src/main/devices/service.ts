// The device list service (#95; decisions D4 and D5b of 2026-11-06): the
// account's devices and the end of a registration lock in force, in the
// main process, read with the account service's `readDeviceList`
// (`GET /devices`), and the notices of new devices from the live
// `account.device_registered` frame.
//
// - The list loads once the Account screen asked for it (`load`), also when
//   it asked while no device was signed in: the open screen then sees the
//   list after the sign-in. From then on, while the application runs, it
//   loads again when a device becomes signed in, when the connection reaches
//   `connected` (account frames sent while it was offline are lost), when
//   `account.device_registered` or `account.device_revoked` arrives, and
//   after a device action of the person (the account service's
//   `onDeviceAction`). The screen's request is refused within
//   `DEVICE_LIST_LOAD_COOLDOWN_MS` of the last one that loaded, so that a
//   renderer that misbehaves cannot read the API in a loop.
// - One load runs at a time, and none while a sign-in runs, which the
//   account service answers `unavailable` while the status may already show
//   the device signed in; the load waits for its end. A load asked for while
//   one is on its way drops that answer and loads again, so only an answer
//   that was asked for after the last trigger applies. A failed load is
//   retried with the workspace service's backoff while connected; offline,
//   the next `connected` loads. After `rate_limited`, also in the answer of
//   a load that a later trigger overtook, nothing loads until its wait has
//   ended: a trigger meanwhile loads at the end of the wait. An answer for
//   an earlier account or device records no wait.
// - A notice of a new device stays until the person dismisses it, the
//   device is revoked (its `account.device_revoked`, or a list that shows it
//   revoked), or the list is dropped (the Project Manager's decision of
//   2026-11-09). The reloads that the frame itself, the connection, or the
//   Account screen start do not end it, so that the person sees it also
//   when the Account screen opens later. A dismissal names the notices that
//   the screen showed, and ends only those, so that a notice that arrived
//   after the last published state is not dismissed unseen.
// - A sign-out, another account, or another device drops the list, the
//   lock, and the notices, and the answers on their way.
// - The device actions of the list (#95, D1) go to the account service,
//   which confirms each in a native dialog and holds its action lock: a
//   revocation of another device, accepted only for an active device that
//   the list holds now and that is not this installation's, and a lift of
//   the registration lock, accepted only while the list holds a lock in
//   force by the wall clock. The list loads again after each one through
//   the account service's `onDeviceAction`.
//
// The state holds no user ID or token: the API's device list has none. The
// logs are fixed text with a failure code at most, never a label or an ID.
import {
  type AccountDeviceRegisteredFrame,
  type DeviceId,
  DeviceIdSchema,
  type DeviceListItem,
} from "@mymandev/protocol";
import type {
  AccountStatus,
  LiftRegistrationLockResult,
  OtherDeviceRevocation,
  RevokeOtherDeviceResult,
} from "../../shared/ipc-contract.ts";
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
  | "status"
  | "onStatusChange"
  | "readDeviceList"
  | "onDeviceAction"
  | "revokeOtherDevice"
  | "liftRegistrationLock"
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
   * The wall clock in milliseconds, for the end of the registration lock,
   * which the API gives in UTC; defaults to `Date.now`.
   */
  readonly wallClock?: () => number;
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
   * after every trigger. Without a signed-in device it is refused as
   * `not_signed_in`, but it still counts as the screen's request, so the
   * list loads once a device is signed in; such a refusal starts no
   * cooldown. With a device, it is refused as `too_soon` within
   * `DEVICE_LIST_LOAD_COOLDOWN_MS` of the last request that loaded.
   */
  readonly load: () => DeviceListLoadOutcome;
  /**
   * Ends the notices of the devices that `deviceIds` names, the ones that
   * the screen showed; a notice of another device stays. False when none of
   * them was held.
   */
  readonly dismissNewDevices: (deviceIds: readonly string[]) => boolean;
  /**
   * Revokes another device of the account as removed or as lost, with the
   * account service's `revokeOtherDevice`, which asks the person first. Only
   * a device that the list holds now is accepted: `not_listed` for any other
   * ID and for a revoked device, `current_device` for this installation's
   * own, and `not_signed_in` while no device is signed in, each without
   * asking. Never rejects.
   */
  readonly revokeDevice: (
    deviceId: string,
    reason: OtherDeviceRevocation,
  ) => Promise<RevokeOtherDeviceResult>;
  /**
   * Lifts the registration lock with the account service's
   * `liftRegistrationLock`, which asks the person first; only while the
   * list holds a lock whose end is later than the wall clock (`no_lock`
   * otherwise), and `not_signed_in` while no device is signed in. Never
   * rejects.
   */
  readonly liftRegistrationLock: () => Promise<LiftRegistrationLockResult>;
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
const ACTION_NOT_SIGNED_IN = Object.freeze({
  outcome: "refused" as const,
  reason: "not_signed_in" as const,
});
const NOT_LISTED: RevokeOtherDeviceResult = Object.freeze({
  outcome: "refused",
  reason: "not_listed",
});
const CURRENT_DEVICE: RevokeOtherDeviceResult = Object.freeze({
  outcome: "refused",
  reason: "current_device",
});
const NO_LOCK: LiftRegistrationLockResult = Object.freeze({
  outcome: "refused",
  reason: "no_lock",
});
/** A device action whose account service rejected: whether it acted is not known. */
const ACTION_UNKNOWN = Object.freeze({ outcome: "unknown" as const });

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
  const wallClock = options.wallClock ?? (() => Date.now());

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
  /**
   * When the wait after `rate_limited` ends, on the monotonic clock, or
   * null. Until then nothing loads; a trigger loads at its end.
   */
  let rateLimitedUntil: number | null = null;

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
    rateLimitedUntil = null;
    touch();
  }

  /** How long the wait after `rate_limited` still runs; 0 when it ended. */
  function rateLimitWait(): number {
    if (rateLimitedUntil === null) {
      return 0;
    }
    const left = rateLimitedUntil - now();
    if (left <= 0) {
      rateLimitedUntil = null;
      return 0;
    }
    return left;
  }

  /**
   * Loads the list, once the Account screen asked for it, for the device
   * that is signed in. During the wait after `rate_limited`, the load goes
   * when the wait ends. While a sign-in runs, the load waits for it to end.
   * While a load is on its way, its answer is dropped and the list loads
   * again after it.
   */
  function reload(): void {
    if (closed || device === null || !requested) {
      return;
    }
    const wait = rateLimitWait();
    if (wait > 0) {
      // The server asked to wait: the retry at the end of the wait loads,
      // after every trigger that came meanwhile.
      if (cancelRetry === null) {
        scheduleRetry(wait);
      }
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
      // A sign-in that began meanwhile makes it wait. The server's wait
      // after `rate_limited` still holds for this account and device, so
      // the newer load goes at its end.
      again = false;
      if (!result.ok && result.reason === "rate_limited") {
        rateLimitedUntil =
          now() + workspaceRetryDelayMs(attempt, "rate_limited");
        if (list === null) {
          // Nothing is loaded yet, so without the problem the screen would
          // say for the whole wait that the list loads.
          problem = "rate_limited";
          touch();
        }
      }
      reload();
      return;
    }
    if (!result.ok) {
      loadFailed(result.reason);
      return;
    }
    list = result.value;
    problem = null;
    attempt = 0;
    rateLimitedUntil = null;
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
    const delayMs = workspaceRetryDelayMs(attempt, reason);
    if (reason === "rate_limited") {
      rateLimitedUntil = now() + delayMs;
    }
    // Offline, the next `connected` loads anyway, once a wait after
    // `rate_limited` has ended.
    if (connected) {
      scheduleRetry(delayMs);
    }
    attempt += 1;
  }

  function scheduleRetry(delayMs: number): void {
    stopRetry();
    cancelRetry = schedule(() => {
      run(() => {
        cancelRetry = null;
        // The only retry that runs during a wait after `rate_limited` is
        // the one at its end; a timer that fires a moment early on the
        // monotonic clock must not wait again.
        rateLimitedUntil = null;
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
    if (closed) {
      return NOT_SIGNED_IN;
    }
    // The screen asked, also when it opened before a device was signed in
    // (a first sign-in, an unlock, or the startup): the list then loads
    // once a device is. The refusal sends nothing and starts no cooldown.
    requested = true;
    if (device === null) {
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
    reload();
    return LOADING;
  }

  function dismissNewDevices(deviceIds: readonly string[]): boolean {
    if (closed) {
      return false;
    }
    const shown = new Set<string>(deviceIds);
    const before = notices;
    dropNotices((notice) => shown.has(notice.id));
    return notices !== before;
  }

  async function revokeDevice(
    deviceId: string,
    reason: OtherDeviceRevocation,
  ): Promise<RevokeOtherDeviceResult> {
    if (closed || device === null) {
      return ACTION_NOT_SIGNED_IN;
    }
    // Only a device of the list as it is now: the renderer names it by an
    // ID that crossed IPC, so it is checked with the protocol's schema too.
    const parsed = DeviceIdSchema.safeParse(deviceId);
    const target = parsed.success
      ? list?.devices.find((item) => item.id === parsed.data)
      : undefined;
    if (target === undefined || target.revokedAt !== null) {
      return NOT_LISTED;
    }
    if (target.current || target.id === device) {
      return CURRENT_DEVICE;
    }
    try {
      return await account.revokeOtherDevice(
        Object.freeze({
          id: target.id,
          label: target.label,
          platform: target.platform,
        }),
        reason,
      );
    } catch {
      // The account service never rejects; if it did, whether the server
      // acted is not known.
      log("A device could not be revoked.");
      return ACTION_UNKNOWN;
    }
  }

  async function liftRegistrationLock(): Promise<LiftRegistrationLockResult> {
    if (closed || device === null) {
      return ACTION_NOT_SIGNED_IN;
    }
    // The lock is in force while its end is later than now, as the API
    // checks it; a list without one, or one whose lock ended, holds none.
    const until = list?.registrationLockedUntil ?? null;
    if (until === null || !(Date.parse(until) > wallClock())) {
      return NO_LOCK;
    }
    try {
      return await account.liftRegistrationLock();
    } catch {
      log("The registration lock could not be lifted.");
      return ACTION_UNKNOWN;
    }
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
    dismissNewDevices: (deviceIds: readonly string[]) =>
      run(() => dismissNewDevices(deviceIds)),
    revokeDevice,
    liftRegistrationLock,
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
