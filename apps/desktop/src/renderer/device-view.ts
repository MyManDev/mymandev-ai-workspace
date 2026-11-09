import type { DeviceListBridge } from "../shared/desktop-bridge.ts";
import type {
  DeviceListProblem,
  DeviceListView,
  DevicePlatformView,
  DeviceView,
  NewDeviceNoticeView,
} from "../shared/ipc-contract.ts";

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
  return { status, newDevices, lockedUntil, lists };
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
