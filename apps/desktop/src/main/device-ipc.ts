import type { DeviceListItem } from "@mymandev/protocol";
import { EVENT_CHANNELS, INVOKE_CHANNELS } from "../shared/ipc-channels.ts";
import {
  DEVICE_LIST_LIMITS,
  type DeviceListLoadResult,
  type DeviceListProblem,
  type DeviceListStatusView,
  type DeviceListView,
  type DeviceView,
  type LiftRegistrationLockResult,
  type NewDeviceNoticeView,
  type RevokeOtherDeviceResult,
} from "../shared/ipc-contract.ts";
import type { WorkspaceReadFailure } from "./api-reads.ts";
import type {
  DeviceListService,
  DeviceListState,
  DeviceListStatus,
  NewDeviceNotice,
} from "./devices/service.ts";
import {
  createEventPublisher,
  createInvokeHandler,
  type IpcRegistry,
} from "./ipc.ts";
import type { ScheduleTimer } from "./runtime.ts";

/**
 * The shortest time between two publishes of the device list. A burst of
 * changes sends the latest view once at the end of it.
 */
export const DEVICE_PUBLISH_INTERVAL_MS = 50;

/**
 * Each status of the service and its status in the contract. `satisfies`
 * checks the fresh literal, so the record fails to compile when the service
 * gains or loses a status.
 */
const STATUS_VIEWS = {
  signed_out: "signed_out",
  loading: "loading",
  ready: "ready",
  unavailable: "unavailable",
} satisfies Record<DeviceListStatus, DeviceListStatusView>;
Object.freeze(STATUS_VIEWS);

/**
 * Each failure of a read and the problem that the renderer shows. The API
 * answers `GET /devices` without `not_found`, so it would be a refusal that
 * the desktop does not expect, `failed`.
 */
const PROBLEM_VIEWS = {
  not_signed_in: "not_signed_in",
  not_found: "failed",
  rate_limited: "rate_limited",
  unavailable: "unavailable",
  failed: "failed",
} satisfies Record<WorkspaceReadFailure, DeviceListProblem>;
Object.freeze(PROBLEM_VIEWS);

/** `text`, cut to `maxLength` characters (code points), as zod counts them. */
function cut(text: string, maxLength: number): string {
  const characters = Array.from(text);
  return characters.length > maxLength
    ? characters.slice(0, maxLength).join("")
    : text;
}

function deviceView(item: DeviceListItem): DeviceView {
  return Object.freeze({
    id: item.id,
    label: cut(item.label, DEVICE_LIST_LIMITS.label),
    platform: item.platform,
    createdAt: item.createdAt,
    lastSeenAt: item.lastSeenAt,
    lastSignInAt: item.lastSignInAt,
    signInExpiresAt: item.signInExpiresAt,
    revokedAt: item.revokedAt,
    current: item.current,
  });
}

function noticeView(notice: NewDeviceNotice): NewDeviceNoticeView {
  return Object.freeze({
    id: notice.id,
    label: cut(notice.label, DEVICE_LIST_LIMITS.label),
    platform: notice.platform,
    createdAt: notice.createdAt,
  });
}

/**
 * The frozen copy of the service's state that crosses IPC, with `revision`
 * as its revision. Each device keeps only the fields that the screen shows
 * and the ID that the device actions name; no user ID, key, or token
 * crosses, and neither does a field that the protocol adds later. The lists
 * keep the service's order and are cut to `DEVICE_LIST_LIMITS`: the devices
 * from the most recently created, and the newest notices. Labels are cut to
 * their limit.
 */
export function deviceListView(
  state: DeviceListState,
  revision: number,
): DeviceListView {
  const fields = {
    revision,
    devices: Object.freeze(
      state.devices.slice(0, DEVICE_LIST_LIMITS.devices).map(deviceView),
    ),
    registrationLockedUntil: state.registrationLockedUntil,
    newDevices: Object.freeze(
      state.newDevices.slice(-DEVICE_LIST_LIMITS.newDevices).map(noticeView),
    ),
  };
  const status = STATUS_VIEWS[state.status];
  if (status === "unavailable") {
    return Object.freeze({
      status,
      problem: PROBLEM_VIEWS[state.problem ?? "failed"],
      ...fields,
    });
  }
  return Object.freeze({ status, ...fields });
}

function scheduleWithSetTimeout(
  callback: () => void,
  delayMs: number,
): () => void {
  const handle = setTimeout(callback, delayMs);
  return () => clearTimeout(handle);
}

export interface DeviceIpcOptions {
  readonly devices: Pick<
    DeviceListService,
    | "state"
    | "onChange"
    | "load"
    | "dismissNewDevices"
    | "revokeDevice"
    | "liftRegistrationLock"
  >;
  /** Defaults to `setTimeout`. */
  readonly scheduleTimer?: ScheduleTimer;
  /** Defaults to `console.error`. */
  readonly onError?: (message: string, error: unknown) => void;
}

export interface DeviceIpc {
  /** Stops listening and cancels a publish that waits, for the quit. */
  readonly close: () => void;
}

/**
 * Registers the handlers of the device list channels and sends the device
 * list to the frames that subscribed (#95, D4 and D5b). Every handler
 * checks the sender and the arguments first (`createInvokeHandler`) and
 * answers with a value parsed by the contract (`deviceListView`), so only
 * device IDs, labels, platforms, times, and fixed codes reach the renderer,
 * never a user ID or a token.
 *
 * `devices:load` takes no argument and asks the service to load the list;
 * the service refuses it within a few seconds of the last request.
 * `devices:dismiss-new-devices` takes the device IDs of the notices that the
 * renderer showed, 1 to 10 lowercase UUIDv7s, and ends only those, so that
 * a notice that arrived after the last published view stays (the Project
 * Manager's decision of 2026-11-09). `devices:revoke` takes one device ID,
 * a lowercase UUIDv7, and the reason `removed` or `lost`, and
 * `devices:lift-lock` takes nothing; the service accepts only
 * an active device of its list and a lock in force, the account service
 * asks the person in a native dialog, and the result is a fixed code. A
 * change of the service raises the
 * view's revision at once and publishes the latest view after
 * `DEVICE_PUBLISH_INTERVAL_MS`, so at most one view goes out in each
 * interval and the last change of a burst is always sent. Call it before
 * the first window loads.
 */
export function registerDeviceIpc(
  ipc: IpcRegistry,
  appUrl: string,
  options: DeviceIpcOptions,
): DeviceIpc {
  const { devices } = options;
  const schedule = options.scheduleTimer ?? scheduleWithSetTimeout;
  const onError =
    options.onError ??
    ((message: string, error: unknown) => console.error(message, error));
  const publisher = createEventPublisher(
    EVENT_CHANNELS.deviceListChanged,
    appUrl,
  );

  let closed = false;
  let revision = 0;
  let cancelPublish: (() => void) | null = null;

  function view(): DeviceListView {
    return deviceListView(devices.state(), revision);
  }

  function publish(): void {
    cancelPublish = null;
    if (closed) {
      return;
    }
    try {
      publisher.publish(view());
    } catch (error) {
      onError("Sending the device list failed.", error);
    }
  }

  function changed(): void {
    if (closed) {
      return;
    }
    revision += 1;
    // A publish that waits sends the latest view when its time comes.
    cancelPublish ??= schedule(publish, DEVICE_PUBLISH_INTERVAL_MS);
  }

  ipc.handle(
    INVOKE_CHANNELS.getDeviceList,
    createInvokeHandler(INVOKE_CHANNELS.getDeviceList, appUrl, () => view()),
  );
  ipc.handle(
    INVOKE_CHANNELS.subscribeDeviceList,
    createInvokeHandler(
      INVOKE_CHANNELS.subscribeDeviceList,
      appUrl,
      (event) => {
        publisher.add(event.sender);
        return view();
      },
    ),
  );
  ipc.handle(
    INVOKE_CHANNELS.loadDeviceList,
    createInvokeHandler(
      INVOKE_CHANNELS.loadDeviceList,
      appUrl,
      (): DeviceListLoadResult => devices.load(),
    ),
  );
  ipc.handle(
    INVOKE_CHANNELS.dismissNewDevices,
    createInvokeHandler(
      INVOKE_CHANNELS.dismissNewDevices,
      appUrl,
      // The contract checked each ID as a lowercase UUIDv7; the service
      // ends only the notices that they name.
      (_event, [deviceIds]) => devices.dismissNewDevices(deviceIds),
    ),
  );
  ipc.handle(
    INVOKE_CHANNELS.revokeDevice,
    createInvokeHandler(
      INVOKE_CHANNELS.revokeDevice,
      appUrl,
      // The contract checked the ID as a lowercase UUIDv7 and the reason;
      // the service accepts only an active device of its list.
      (_event, [deviceId, reason]): Promise<RevokeOtherDeviceResult> =>
        devices.revokeDevice(deviceId, reason),
    ),
  );
  ipc.handle(
    INVOKE_CHANNELS.liftRegistrationLock,
    createInvokeHandler(
      INVOKE_CHANNELS.liftRegistrationLock,
      appUrl,
      (): Promise<LiftRegistrationLockResult> => devices.liftRegistrationLock(),
    ),
  );
  const remove = devices.onChange(changed);

  return Object.freeze({
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      remove();
      cancelPublish?.();
      cancelPublish = null;
    },
  });
}
