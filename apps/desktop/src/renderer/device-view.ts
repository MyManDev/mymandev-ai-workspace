import type { DeviceListBridge } from "../shared/desktop-bridge.ts";
import type {
  DeviceListActionFailure,
  DeviceListProblem,
  DeviceListView,
  DevicePlatformView,
  DeviceView,
  LiftRegistrationLockResult,
  NewDeviceNoticeView,
  OtherDeviceRevocation,
  RevokeOtherDeviceResult,
} from "../shared/ipc-contract.ts";
import { DEVICE_ACTION_FAILURE_MESSAGES } from "./account-view.ts";

/** What the devices section knows about the account's devices. */
export type DeviceSectionView =
  /** Outside Electron, or the main process refused the subscription. */
  | { readonly kind: "unavailable" }
  /** Waiting for the first state. */
  | { readonly kind: "pending" }
  | { readonly kind: "known"; readonly state: DeviceListView };

export function initialDeviceSectionView(
  bridgeAvailable: boolean,
): DeviceSectionView {
  return bridgeAvailable ? { kind: "pending" } : { kind: "unavailable" };
}

/**
 * Subscribes to the device list, reports every state as the view, and asks
 * the main process to load the list, as the Account screen does when it
 * opens. A refused subscription makes the view unavailable. The load's
 * answer shows in the states that follow, so a refusal (`too_soon`, or no
 * signed-in device) changes nothing here. Returns the function that ends
 * the subscription.
 */
export function followDeviceList(
  devices: Pick<DeviceListBridge, "subscribeState" | "load">,
  onView: (view: DeviceSectionView) => void,
): () => void {
  const stop = devices.subscribeState(
    (state) => onView({ kind: "known", state }),
    () => onView({ kind: "unavailable" }),
  );
  devices.load().catch(() => undefined);
  return stop;
}

/** The fixed texts of the devices section. */
export const DEVICE_LIST_MESSAGES = Object.freeze({
  unavailable: "Devices are not available.",
  pending: "Checking the devices.",
  signedOut: "The devices appear once this device is signed in.",
  loading: "Loading the devices.",
  empty: "No devices are listed.",
  noActiveDevices: "No active devices.",
  thisDevice: "This device",
  newDevice: "New",
  neverConnected: "Never connected",
  /** The name of the region that holds the notices of new devices. */
  newDevicesLabel: "New devices",
  /** The button that ends the notices that are shown. */
  dismiss: "Dismiss the notices",
});

/** The labels of the device actions (#95). */
export const DEVICE_ACTION_LABELS = Object.freeze({
  /** On each other active device: revoke it as removed, without a lock. */
  remove: "Remove",
  /** On each other active device: revoke it as lost, with the lock. */
  revokeAsLost: "Revoke as lost",
  /** On each notice of a new device (the Project Manager's decision of 2026-11-09). */
  notMe: "This was not me: revoke as lost",
  /** On the line of the registration lock, while it is in force (D5b). */
  liftLock: "Lift the registration lock",
  /** Ends the advice after a revocation as lost. */
  dismissAdvice: "Dismiss the advice",
});

/**
 * The advice after a revocation as lost (ADR 0014, "Revocation, sign-out,
 * and recovery"): fixed sentences, with the address of GitHub's sessions as
 * text, never as a link that opens on its own.
 */
export const LOST_DEVICE_ADVICE = Object.freeze({
  title: "After a lost device",
  steps: Object.freeze([
    "End that device's GitHub sessions: open github.com/settings/sessions in your browser and revoke them.",
    "If the device was unlocked, change your GitHub password.",
    "Rotate the AI provider credentials that are stored on that device. The server cannot reach them.",
  ]),
});

/** The sentences after a device action of the devices section. */
export const DEVICE_ACTION_RESULT_MESSAGES = Object.freeze({
  removed: "The device was removed from the account.",
  revokedAsLost:
    "The device was revoked as lost, and no new device can register on this account for 7 days unless you lift the registration lock. Follow the advice below.",
  revokeUnknown:
    "The server's answer did not show whether the device was revoked. The device list shows it once it loads again; the request is not sent again on its own.",
  /** Added after `revokeUnknown` for a revocation as lost. */
  adviceFollows: "Follow the advice below for the lost device.",
  lifted:
    "The registration lock was lifted. New devices can register on this account again.",
  liftUnknown:
    "The server's answer did not show whether the registration lock was lifted. The device list shows it once it loads again; the request is not sent again on its own.",
  /** The start of a refusal or a failure of a revocation. */
  revokeNotDone: "The device could not be revoked.",
  /** The start of a refusal or a failure of a lift. */
  liftNotDone: "The registration lock could not be lifted.",
  /** A call that failed in the renderer or on its way. */
  tryAgain: "Try again.",
});

/** Why the main process refused a device action before it asked the person. */
export const DEVICE_ACTION_REFUSAL_MESSAGES = Object.freeze({
  unavailable:
    "Wait until the sign-in or the current change of the account is finished, then try again.",
  not_signed_in:
    "This device is not signed in, so it cannot change the account's devices.",
  current_device:
    'It is this device: use "Remove this device" in the panel instead.',
  not_listed:
    "It is not an active device of the current list. Wait until the list has loaded, then try again.",
  no_lock: "No registration lock is in force.",
});

/** Why a device action failed after the person confirmed it. */
export const DEVICE_LIST_ACTION_FAILURE_MESSAGES: Readonly<
  Record<DeviceListActionFailure, string>
> = Object.freeze({
  api_origin_unset: DEVICE_ACTION_FAILURE_MESSAGES.api_origin_unset,
  api_origin_invalid: DEVICE_ACTION_FAILURE_MESSAGES.api_origin_invalid,
  no_device: DEVICE_ACTION_FAILURE_MESSAGES.no_device,
  key_lost: DEVICE_ACTION_FAILURE_MESSAGES.key_lost,
  key_not_loaded: DEVICE_ACTION_FAILURE_MESSAGES.key_not_loaded,
  record_unreadable: DEVICE_ACTION_FAILURE_MESSAGES.record_unreadable,
  key_store_failed: DEVICE_ACTION_FAILURE_MESSAGES.key_store_failed,
  signed_out: DEVICE_ACTION_FAILURE_MESSAGES.signed_out,
  sign_in_running: DEVICE_ACTION_FAILURE_MESSAGES.sign_in_running,
  replacement_pending: DEVICE_ACTION_FAILURE_MESSAGES.replacement_pending,
  removal_pending: DEVICE_ACTION_FAILURE_MESSAGES.removal_pending,
  record_not_saved: DEVICE_ACTION_FAILURE_MESSAGES.record_not_saved,
  sign_in_required: DEVICE_ACTION_FAILURE_MESSAGES.sign_in_required,
  auth_failed: DEVICE_ACTION_FAILURE_MESSAGES.auth_failed,
  device_revoked: DEVICE_ACTION_FAILURE_MESSAGES.device_revoked,
  device_account_mismatch:
    DEVICE_ACTION_FAILURE_MESSAGES.device_account_mismatch,
  rate_limited: DEVICE_ACTION_FAILURE_MESSAGES.rate_limited,
  not_found: "The server does not list that device for this account.",
  conflict: "The device was revoked already.",
  refused: DEVICE_ACTION_FAILURE_MESSAGES.refused,
  failed: DEVICE_ACTION_FAILURE_MESSAGES.failed,
});

/** What the section says after a device action. */
export interface DeviceActionOutcome {
  /** A fixed sentence, or undefined after a kept confirmation. */
  readonly message: string | undefined;
  /**
   * Whether the action's button leaves the page with the next list: the
   * device was revoked, or the lock lifted.
   */
  readonly done: boolean;
}

/**
 * The section's answer to a revocation of `reason`: a sentence for every
 * result. After a revocation as lost that the server confirmed, or whose
 * answer does not show whether it acted, the main process shows the advice
 * of ADR 0014 (`lostDeviceAdvice`), and the sentence points to it.
 */
export function revokeDeviceOutcome(
  result: RevokeOtherDeviceResult,
  reason: OtherDeviceRevocation,
): DeviceActionOutcome {
  switch (result.outcome) {
    case "revoked":
      return {
        message:
          result.reason === "lost"
            ? DEVICE_ACTION_RESULT_MESSAGES.revokedAsLost
            : DEVICE_ACTION_RESULT_MESSAGES.removed,
        done: true,
      };
    case "cancelled":
      return { message: undefined, done: false };
    case "unknown":
      return {
        message:
          reason === "lost"
            ? `${DEVICE_ACTION_RESULT_MESSAGES.revokeUnknown} ${DEVICE_ACTION_RESULT_MESSAGES.adviceFollows}`
            : DEVICE_ACTION_RESULT_MESSAGES.revokeUnknown,
        done: false,
      };
    case "refused":
      return {
        message: `${DEVICE_ACTION_RESULT_MESSAGES.revokeNotDone} ${DEVICE_ACTION_REFUSAL_MESSAGES[result.reason]}`,
        done: false,
      };
    case "failed":
      return {
        message: `${DEVICE_ACTION_RESULT_MESSAGES.revokeNotDone} ${DEVICE_LIST_ACTION_FAILURE_MESSAGES[result.reason]}`,
        done: false,
      };
  }
}

/**
 * The section's answer to a lift of the registration lock. The API answers
 * the same whether it lifted a lock in force or the lock had ended already,
 * so `lifted` says that the lock was lifted.
 */
export function liftRegistrationLockOutcome(
  result: LiftRegistrationLockResult,
): DeviceActionOutcome {
  switch (result.outcome) {
    case "lifted":
      return { message: DEVICE_ACTION_RESULT_MESSAGES.lifted, done: true };
    case "cancelled":
      return { message: undefined, done: false };
    case "unknown":
      return {
        message: DEVICE_ACTION_RESULT_MESSAGES.liftUnknown,
        done: false,
      };
    case "refused":
      return {
        message: `${DEVICE_ACTION_RESULT_MESSAGES.liftNotDone} ${DEVICE_ACTION_REFUSAL_MESSAGES[result.reason]}`,
        done: false,
      };
    case "failed":
      return {
        message: `${DEVICE_ACTION_RESULT_MESSAGES.liftNotDone} ${DEVICE_LIST_ACTION_FAILURE_MESSAGES[result.reason]}`,
        done: false,
      };
  }
}

/** What the section shows of its device actions. */
export interface DeviceActionsView {
  /**
   * True while the main process asks the person in its native dialog and
   * the server: every device action's button stays focusable and does
   * nothing (`aria-disabled`).
   */
  readonly running: boolean;
  /** A fixed sentence about the last action, or undefined. */
  readonly message: string | undefined;
}

export const IDLE_DEVICE_ACTIONS: DeviceActionsView = Object.freeze({
  running: false,
  message: undefined,
});

export interface DeviceActions {
  /**
   * Revokes another device as removed or lost, once: a call while an
   * action runs changes nothing and resolves to false. Resolves to true
   * when the device was revoked, so that its button leaves the page.
   */
  readonly revoke: (
    deviceId: string,
    reason: OtherDeviceRevocation,
  ) => Promise<boolean>;
  /** Lifts the registration lock, by the same rules; true when it was lifted. */
  readonly lift: () => Promise<boolean>;
  /**
   * Follows the section's view: the sentence of the last action belongs to
   * the account and the device that it was about, so it goes when the list
   * shows no signed-in device (`signed_out`), when it loads for a device
   * again after a drop (`loading`), and when the list names another device
   * as this one.
   */
  readonly listChanged: (view: DeviceSectionView) => void;
}

/**
 * The device actions of the devices section, through the device list
 * bridge; `onView` gets every change of what the section shows. One action
 * runs at a time, and a new action clears the last sentence. The advice
 * after a revocation as lost is part of the device list instead
 * (`lostDeviceAdvice`).
 */
export function createDeviceActions(
  devices: Pick<DeviceListBridge, "revokeDevice" | "liftRegistrationLock">,
  onView: (view: DeviceActionsView) => void,
): DeviceActions {
  let running = false;
  let message: string | undefined;
  /** The device of this installation in the last list, or undefined. */
  let thisDevice: string | undefined;
  const show = () => onView(Object.freeze({ running, message }));

  async function act(
    call: () => Promise<DeviceActionOutcome>,
    failed: string,
  ): Promise<boolean> {
    if (running) {
      return false;
    }
    running = true;
    message = undefined;
    show();
    let done = false;
    try {
      const outcome = await call();
      message = outcome.message;
      done = outcome.done;
    } catch {
      message = `${failed} ${DEVICE_ACTION_RESULT_MESSAGES.tryAgain}`;
    }
    running = false;
    show();
    return done;
  }

  return Object.freeze({
    revoke: (deviceId: string, reason: OtherDeviceRevocation) =>
      act(
        async () =>
          revokeDeviceOutcome(
            await devices.revokeDevice(deviceId, reason),
            reason,
          ),
        DEVICE_ACTION_RESULT_MESSAGES.revokeNotDone,
      ),
    lift: () =>
      act(
        async () =>
          liftRegistrationLockOutcome(await devices.liftRegistrationLock()),
        DEVICE_ACTION_RESULT_MESSAGES.liftNotDone,
      ),
    listChanged: (view: DeviceSectionView) => {
      if (view.kind !== "known") {
        return;
      }
      const { state } = view;
      const named = state.devices.find((device) => device.current)?.id;
      const other =
        named !== undefined && thisDevice !== undefined && named !== thisDevice;
      if (named !== undefined) {
        thisDevice = named;
      }
      if (
        message !== undefined &&
        (state.status === "signed_out" || state.status === "loading" || other)
      ) {
        message = undefined;
        show();
      }
    },
  });
}

/**
 * Whether the focus moves to the section's title after an action whose
 * button leaves the page with the next list (`done`): only while the focus
 * is still on that button or on the page, so that a person who moved on
 * keeps their place. The title is not a live region, so the action's
 * sentence in its status paragraph is read once.
 */
export function focusesTitleAfterAction(
  done: boolean,
  focusOnButtonOrPage: boolean,
): boolean {
  return done && focusOnButtonOrPage;
}

/**
 * Why the device list is `unavailable`. What was loaded before stays shown,
 * and the main process loads again by itself.
 */
export const DEVICE_LIST_PROBLEM_MESSAGES: Readonly<
  Record<DeviceListProblem, string>
> = Object.freeze({
  not_signed_in: "The server did not accept this device's sign-in.",
  rate_limited: "The server asked to wait. Trying again in a minute.",
  unavailable: "The devices cannot be loaded right now. Trying again later.",
  failed: "The devices could not be loaded. Trying again later.",
});

/** The name of each platform. */
export const PLATFORM_NAMES: Readonly<Record<DevicePlatformView, string>> =
  Object.freeze({
    windows: "Windows",
    macos: "macOS",
    linux: "Linux",
  });

/** How long a device counts as new after it was created (D4): 7 days. */
export const NEW_DEVICE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The longest wait of one timer: `setTimeout` runs a longer delay at once.
 * A later change of the section is read again after it.
 */
export const MAX_CLOCK_WAIT_MS = 2_147_483_647;

/**
 * Whether a device created at `createdAt` was created in the last 7 days,
 * by the clock `now` in milliseconds. A creation time later than the clock
 * counts as new.
 */
export function isNewDevice(createdAt: string, now: number): boolean {
  const created = Date.parse(createdAt);
  return !Number.isNaN(created) && now - created < NEW_DEVICE_WINDOW_MS;
}

/**
 * Whether the registration lock that the list reported is still in force
 * by the clock `now`: its end is later than now, as the API checks it.
 */
export function registrationLockInForce(
  until: string | null,
  now: number,
): boolean {
  if (until === null) {
    return false;
  }
  const end = Date.parse(until);
  return !Number.isNaN(end) && end > now;
}

/** A device as the section shows it. */
export interface DeviceRow {
  readonly id: string;
  readonly label: string;
  readonly platformName: string;
  /** The device of this installation. */
  readonly current: boolean;
  /** Created in the last 7 days. */
  readonly isNew: boolean;
  readonly createdAt: string;
  readonly lastSeenAt: string | null;
  readonly lastSignInAt: string;
  readonly signInExpiresAt: string;
  readonly revokedAt: string | null;
}

/** A notice of a new device as the section shows it. */
export interface NewDeviceRow {
  readonly id: string;
  readonly label: string;
  readonly platformName: string;
  readonly createdAt: string;
}

export interface DeviceSectionLists {
  /** The devices that are not revoked, in the main process's order. */
  readonly active: readonly DeviceRow[];
  /** The revoked devices, in the main process's order. */
  readonly revoked: readonly DeviceRow[];
}

export interface DeviceSectionModel {
  /** The text of the section's status paragraph; empty when there is none. */
  readonly status: string;
  /** The notices of new devices, the oldest first. */
  readonly newDevices: readonly NewDeviceRow[];
  /** The end of the registration lock while it is in force, or null. */
  readonly lockedUntil: string | null;
  /** The devices, or null when there is nothing to list. */
  readonly lists: DeviceSectionLists | null;
  /**
   * Whether the advice after a revocation as lost shows, which the main
   * process holds until the person dismisses it.
   */
  readonly lostDeviceAdvice: boolean;
}

function deviceRow(device: DeviceView, now: number): DeviceRow {
  return {
    id: device.id,
    label: device.label,
    platformName: PLATFORM_NAMES[device.platform],
    current: device.current,
    isNew: isNewDevice(device.createdAt, now),
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt,
    lastSignInAt: device.lastSignInAt,
    signInExpiresAt: device.signInExpiresAt,
    revokedAt: device.revokedAt,
  };
}

function newDeviceRow(notice: NewDeviceNoticeView): NewDeviceRow {
  return {
    id: notice.id,
    label: notice.label,
    platformName: PLATFORM_NAMES[notice.platform],
    createdAt: notice.createdAt,
  };
}

function listsOf(state: DeviceListView, now: number): DeviceSectionLists {
  return {
    active: state.devices
      .filter((device) => device.revokedAt === null)
      .map((device) => deviceRow(device, now)),
    revoked: state.devices
      .filter((device) => device.revokedAt !== null)
      .map((device) => deviceRow(device, now)),
  };
}

const NOTHING: Omit<DeviceSectionModel, "status"> = Object.freeze({
  newDevices: Object.freeze([]),
  lockedUntil: null,
  lists: null,
  lostDeviceAdvice: false,
});

/**
 * What the section shows, by the clock `now` in milliseconds:
 *
 * - a fixed text without the bridge, before the first state, without a
 *   signed-in device, and while the list loads;
 * - when `ready`, the active devices and then the revoked ones apart, in the
 *   main process's order (the most recently created first), or a fixed text
 *   when the list is empty;
 * - when `unavailable`, the problem as a fixed text, with what was loaded
 *   before. Without any of it, only the problem shows, because an empty list
 *   would claim what was never loaded;
 * - the notices of new devices whenever a device is signed in, and the end
 *   of the registration lock while it is in force and a list is shown.
 */
export function describeDeviceList(
  view: DeviceSectionView,
  now: number,
): DeviceSectionModel {
  switch (view.kind) {
    case "unavailable":
      return { status: DEVICE_LIST_MESSAGES.unavailable, ...NOTHING };
    case "pending":
      return { status: DEVICE_LIST_MESSAGES.pending, ...NOTHING };
    case "known":
      break;
  }
  const { state } = view;
  if (state.status === "signed_out") {
    return { status: DEVICE_LIST_MESSAGES.signedOut, ...NOTHING };
  }
  const newDevices = state.newDevices.map(newDeviceRow);
  const lists = state.devices.length === 0 ? null : listsOf(state, now);
  const lockedUntil =
    lists !== null &&
    registrationLockInForce(state.registrationLockedUntil, now)
      ? state.registrationLockedUntil
      : null;
  let status: string;
  switch (state.status) {
    case "loading":
      status = DEVICE_LIST_MESSAGES.loading;
      break;
    case "unavailable":
      status = DEVICE_LIST_PROBLEM_MESSAGES[state.problem];
      break;
    case "ready":
      status = lists === null ? DEVICE_LIST_MESSAGES.empty : "";
      break;
  }
  return {
    status,
    newDevices,
    lockedUntil,
    lists,
    lostDeviceAdvice: state.lostDeviceAdvice,
  };
}

/**
 * The next time after `now`, in milliseconds, at which the section shows
 * something else by the clock alone: a device that stops counting as new,
 * or the end of the registration lock. Undefined when nothing changes.
 */
export function nextDeviceListChange(
  view: DeviceSectionView,
  now: number,
): number | undefined {
  if (view.kind !== "known") {
    return undefined;
  }
  const { state } = view;
  const times = state.devices
    .map((device) => Date.parse(device.createdAt) + NEW_DEVICE_WINDOW_MS)
    .concat(
      state.registrationLockedUntil === null
        ? []
        : [Date.parse(state.registrationLockedUntil)],
    )
    .filter((time) => !Number.isNaN(time) && time > now);
  return times.length === 0 ? undefined : Math.min(...times);
}

/** The options of `deviceTimeFormat`; the tests fix them. */
export interface DeviceTimeFormatOptions {
  /** Defaults to the person's locale. */
  readonly locale?: string;
  /** An IANA time zone such as "Europe/Istanbul"; defaults to the system's. */
  readonly timeZone?: string;
}

/**
 * The format of the section's times, as the chat screen formats them: the
 * date and the time, for example "Nov 6, 2026, 9:30 AM", in the person's
 * locale and time zone. The section makes a new one for each render, so
 * that a changed time zone of the system shows at the next change.
 */
export function deviceTimeFormat(
  options: DeviceTimeFormatOptions = {},
): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(options.locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: options.timeZone,
  });
}

/** A time of the device list in `format`. A timestamp that is not a date stays as it is. */
export function formatDeviceTime(
  timestamp: string,
  format: Intl.DateTimeFormat,
): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? timestamp : format.format(date);
}
