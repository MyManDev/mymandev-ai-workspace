import { useCallback, useEffect, useMemo, useState } from "react";
import type { DeviceListBridge } from "../shared/desktop-bridge.ts";
import type { OtherDeviceRevocation } from "../shared/ipc-contract.ts";
import {
  createDeviceActions,
  DEVICE_ACTION_LABELS,
  DEVICE_LIST_MESSAGES,
  describeDeviceList,
  deviceTimeFormat,
  focusesActionMessage,
  followDeviceList,
  formatDeviceTime,
  IDLE_DEVICE_ACTIONS,
  initialDeviceSectionView,
  LOST_DEVICE_ADVICE,
  MAX_CLOCK_WAIT_MS,
  nextDeviceListChange,
  type DeviceActions,
  type DeviceActionsView,
  type DeviceRow,
  type DeviceSectionView,
  type NewDeviceRow,
} from "./device-view.ts";

/** The ID of the section's title. */
export const DEVICES_TITLE_ID = "devices-title";

/**
 * The ID of the paragraph with the sentence of the last device action. It
 * takes the focus without a tab stop once an action's button leaves the
 * page with the list.
 */
export const DEVICE_ACTION_MESSAGE_ID = "device-action-message";

/** The ID of the line of the registration lock, which describes its button. */
const LOCK_LINE_ID = "registration-lock-line";

/** The ID of the advice's title. */
const ADVICE_TITLE_ID = "lost-device-advice-title";

/**
 * The account's devices on the Account screen (#95, D4 and D5b): the active
 * devices with this one marked, the revoked ones apart, the devices created
 * in the last 7 days marked as new, the end of a registration lock in
 * force, and the notices of new devices. The main process holds the list
 * and keeps it current; the section asks it to load the list when it opens.
 * The section offers the device actions (#95, D1): it revokes another
 * active device as removed or as lost, revokes the device of a notice as
 * lost, and lifts the registration lock; the main process confirms each in
 * a native dialog.
 */
export function DevicesSection({
  devices,
}: {
  /** The device list functions from the preload script; undefined outside Electron. */
  readonly devices: DeviceListBridge | undefined;
}) {
  const view = useDeviceSection(devices);
  const now = useDeviceListClock(view);
  const { actions, controller } = useDeviceActions(devices);
  const onDismissNewDevices = useCallback(
    (deviceIds: readonly string[]): Promise<boolean> =>
      // The next state shows what changed; a failed call ends nothing.
      devices === undefined
        ? Promise.resolve(false)
        : devices.dismissNewDevices(deviceIds).catch(() => false),
    [devices],
  );
  const onRevokeDevice = useCallback(
    (
      deviceId: string,
      reason: OtherDeviceRevocation,
      button: Element | null,
    ) => {
      void controller
        ?.revoke(deviceId, reason)
        .then((done) => focusAfterAction(done, button));
    },
    [controller],
  );
  const onLiftRegistrationLock = useCallback(
    (button: Element | null) => {
      void controller?.lift().then((done) => focusAfterAction(done, button));
    },
    [controller],
  );
  return (
    <DevicesSectionContent
      view={view}
      now={now}
      actions={actions}
      onDismissNewDevices={
        devices === undefined ? undefined : onDismissNewDevices
      }
      onRevokeDevice={controller === undefined ? undefined : onRevokeDevice}
      onLiftRegistrationLock={
        controller === undefined ? undefined : onLiftRegistrationLock
      }
      onDismissAdvice={controller?.dismissAdvice}
      onFocusTitle={focusTitle}
    />
  );
}

/** Moves the focus to the section's title, which takes it without a tab stop. */
function focusTitle(): void {
  document.getElementById(DEVICES_TITLE_ID)?.focus();
}

/**
 * Moves the focus to the action's sentence once the action's button leaves
 * the page with the next list (`focusesActionMessage`), while the focus is
 * still on that button or on the page.
 */
function focusAfterAction(done: boolean, button: Element | null): void {
  const active = document.activeElement;
  if (
    focusesActionMessage(
      done,
      active === null || active === document.body || active === button,
    )
  ) {
    document.getElementById(DEVICE_ACTION_MESSAGE_ID)?.focus();
  }
}

export interface DevicesSectionContentProps {
  readonly view: DeviceSectionView;
  /**
   * The renderer's clock in milliseconds, for the devices that count as new
   * and the end of the registration lock.
   */
  readonly now: number;
  /**
   * The format of the times, for tests. By default, a new `deviceTimeFormat`
   * for each render, in the person's locale and the system's time zone.
   */
  readonly timeFormat?: Intl.DateTimeFormat | undefined;
  /** What the section shows of its device actions; idle by default. */
  readonly actions?: DeviceActionsView | undefined;
  /**
   * Ends the notices of new devices that the section shows, by their device
   * IDs, and resolves to true when the main process ended one; undefined
   * without the bridge.
   */
  readonly onDismissNewDevices?:
    ((deviceIds: readonly string[]) => Promise<boolean>) | undefined;
  /**
   * Revokes another active device, or the device of a notice, as removed or
   * lost; gets the button that was clicked. Undefined without the bridge.
   */
  readonly onRevokeDevice?:
    | ((
        deviceId: string,
        reason: OtherDeviceRevocation,
        button: Element | null,
      ) => void)
    | undefined;
  /** Lifts the registration lock; gets the button. Undefined without the bridge. */
  readonly onLiftRegistrationLock?:
    ((button: Element | null) => void) | undefined;
  /** Ends the advice after a revocation as lost. */
  readonly onDismissAdvice?: (() => void) | undefined;
  /**
   * Moves the focus to the section's title. "Dismiss the notices" calls it
   * once the main process ended a notice, and "Dismiss the advice" at once,
   * because each button goes away and the focus would drop to the page.
   */
  readonly onFocusTitle?: (() => void) | undefined;
}

/**
 * The section for a view, without state. The status paragraph is always
 * rendered, empty when there is nothing to say, so that a screen reader
 * announces a new text; so is the paragraph of the device actions'
 * sentence, with the bridge. The notices of new devices sit in one polite
 * log region (`role="log"`), each with its action. The region is rendered
 * only once the section has the first state of the main process, so it
 * enters the page together with the notices that the state holds then: a
 * live region announces changes to its content after it is in the page,
 * not the content that it enters with, so those notices are not read out
 * when the screen opens, and a notice that a later state adds is. Labels
 * are text that people entered, so each one is rendered as text and takes
 * its direction from its own content (`dir="auto"`). The marks of this
 * device and of a new device are text. While a device action runs, its
 * buttons stay focusable and do nothing (`aria-disabled`), so that the
 * native dialog gives the focus back to the button. The title takes the
 * focus without a tab stop (`tabIndex={-1}`).
 */
export function DevicesSectionContent({
  view,
  now,
  timeFormat,
  actions = IDLE_DEVICE_ACTIONS,
  onDismissNewDevices,
  onRevokeDevice,
  onLiftRegistrationLock,
  onDismissAdvice,
  onFocusTitle,
}: DevicesSectionContentProps) {
  const model = describeDeviceList(view, now);
  const format = timeFormat ?? deviceTimeFormat();
  const { lists } = model;
  const acts =
    onRevokeDevice !== undefined || onLiftRegistrationLock !== undefined;
  const inert = actions.running;
  return (
    <section className="account-panel" aria-labelledby={DEVICES_TITLE_ID}>
      <h3 id={DEVICES_TITLE_ID} tabIndex={-1}>
        Devices
      </h3>
      <p className="account-message" role="status">
        {model.status}
      </p>
      {acts ? (
        <p
          className="account-message"
          id={DEVICE_ACTION_MESSAGE_ID}
          role="status"
          tabIndex={-1}
        >
          {actions.message ?? ""}
        </p>
      ) : null}
      {actions.advice ? (
        <LostDeviceAdvice
          onDismiss={onDismissAdvice}
          onFocusTitle={onFocusTitle}
        />
      ) : null}
      {view.kind === "known" ? (
        <NewDeviceNotices
          notices={model.newDevices}
          format={format}
          inert={inert}
          onDismiss={onDismissNewDevices}
          onRevoke={onRevokeDevice}
          onFocusTitle={onFocusTitle}
        />
      ) : null}
      {model.lockedUntil === null ? null : (
        <>
          <p className="account-warning" id={LOCK_LINE_ID}>
            {"New devices cannot be registered on this account until "}
            <Time timestamp={model.lockedUntil} format={format} />.
          </p>
          {onLiftRegistrationLock === undefined ? null : (
            <div className="account-actions">
              <ActionButton
                label={DEVICE_ACTION_LABELS.liftLock}
                describedBy={LOCK_LINE_ID}
                inert={inert}
                onClick={onLiftRegistrationLock}
              />
            </div>
          )}
        </>
      )}
      {lists === null ? null : (
        <>
          <h4 id="active-devices-title">Active devices</h4>
          {lists.active.length === 0 ? (
            <p className="account-message">
              {DEVICE_LIST_MESSAGES.noActiveDevices}
            </p>
          ) : (
            <DeviceItems
              rows={lists.active}
              labelledBy="active-devices-title"
              format={format}
              inert={inert}
              onRevoke={onRevokeDevice}
            />
          )}
          {lists.revoked.length === 0 ? null : (
            <>
              <h4 id="revoked-devices-title">Revoked devices</h4>
              <DeviceItems
                rows={lists.revoked}
                labelledBy="revoked-devices-title"
                format={format}
                inert={inert}
                onRevoke={undefined}
              />
            </>
          )}
        </>
      )}
    </section>
  );
}

/**
 * A button of a device action. While an action runs it stays focusable and
 * does nothing (`aria-disabled`), like the buttons of the connection
 * indicator (#211).
 */
function ActionButton({
  label,
  describedBy,
  inert,
  onClick,
}: {
  readonly label: string;
  readonly describedBy: string;
  readonly inert: boolean;
  readonly onClick: (button: Element | null) => void;
}) {
  return (
    <button
      type="button"
      className="panel-action"
      aria-describedby={describedBy}
      aria-disabled={inert ? "true" : undefined}
      onClick={
        inert
          ? undefined
          : (event: { readonly currentTarget: Element | null }) =>
              onClick(event.currentTarget)
      }
    >
      {label}
    </button>
  );
}

/**
 * The advice after a revocation as lost (ADR 0014): fixed sentences under a
 * heading, until the person dismisses it. The address of GitHub's sessions
 * is text, not a link.
 */
function LostDeviceAdvice({
  onDismiss,
  onFocusTitle,
}: {
  readonly onDismiss: (() => void) | undefined;
  readonly onFocusTitle: (() => void) | undefined;
}) {
  return (
    <div className="device-advice">
      <h4 id={ADVICE_TITLE_ID}>{LOST_DEVICE_ADVICE.title}</h4>
      <ul aria-labelledby={ADVICE_TITLE_ID}>
        {LOST_DEVICE_ADVICE.steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ul>
      {onDismiss === undefined ? null : (
        <div className="account-actions">
          <button
            type="button"
            className="panel-action"
            onClick={() => {
              onDismiss();
              // The button goes away with the advice.
              onFocusTitle?.();
            }}
          >
            {DEVICE_ACTION_LABELS.dismissAdvice}
          </button>
        </div>
      )}
    </div>
  );
}

function NewDeviceNotices({
  notices,
  format,
  inert,
  onDismiss,
  onRevoke,
  onFocusTitle,
}: {
  readonly notices: readonly NewDeviceRow[];
  readonly format: Intl.DateTimeFormat;
  readonly inert: boolean;
  readonly onDismiss:
    ((deviceIds: readonly string[]) => Promise<boolean>) | undefined;
  readonly onRevoke: DevicesSectionContentProps["onRevokeDevice"];
  readonly onFocusTitle: (() => void) | undefined;
}) {
  // Each notice has its action, bound to its device ID and described by
  // the notice (the Project Manager's decision of 2026-11-09); it is part of
  // the entry, so a screen reader reads it with a notice that is added.
  // "Dismiss the notices" stays outside the log, so that it is not
  // announced as a new entry. It ends the notices that are shown, by their
  // device IDs, and moves the focus to the section's title once the main
  // process ended one, because the button goes away with them.
  return (
    <>
      <div
        className="device-notices"
        role="log"
        aria-label={DEVICE_LIST_MESSAGES.newDevicesLabel}
      >
        {notices.map((notice, index) => {
          const textId = `new-device-notice-${index}`;
          return (
            <div key={notice.id} className="device-notice">
              <p className="account-warning" id={textId}>
                {"A new device was registered on this account: "}
                <span dir="auto">{notice.label}</span>
                {` (${notice.platformName}), `}
                <Time timestamp={notice.createdAt} format={format} />.
              </p>
              {onRevoke === undefined ? null : (
                <ActionButton
                  label={DEVICE_ACTION_LABELS.notMe}
                  describedBy={textId}
                  inert={inert}
                  onClick={(button) => onRevoke(notice.id, "lost", button)}
                />
              )}
            </div>
          );
        })}
      </div>
      {onDismiss === undefined || notices.length === 0 ? null : (
        <div className="account-actions">
          <button
            type="button"
            className="panel-action"
            onClick={() => {
              // A call that failed ends nothing, so the focus stays.
              void onDismiss(notices.map((notice) => notice.id)).then(
                (ended) => {
                  if (ended) {
                    onFocusTitle?.();
                  }
                },
                () => undefined,
              );
            }}
          >
            {DEVICE_LIST_MESSAGES.dismiss}
          </button>
        </div>
      )}
    </>
  );
}

function DeviceItems({
  rows,
  labelledBy,
  format,
  inert,
  onRevoke,
}: {
  readonly rows: readonly DeviceRow[];
  readonly labelledBy: string;
  readonly format: Intl.DateTimeFormat;
  readonly inert: boolean;
  /** Undefined for the revoked devices, and without the bridge. */
  readonly onRevoke: DevicesSectionContentProps["onRevokeDevice"];
}) {
  return (
    <ul className="device-list" aria-labelledby={labelledBy}>
      {rows.map((row, index) => {
        // Only another active device has actions; this one has "Remove
        // this device" in the panel. Its label describes them.
        const acts =
          onRevoke !== undefined && !row.current && row.revokedAt === null;
        const labelId = acts ? `${labelledBy}-device-${index}` : undefined;
        return (
          <li key={row.id} aria-current={row.current ? "true" : undefined}>
            <p className="device-name">
              <span className="device-label" dir="auto" id={labelId}>
                {row.label}
              </span>
              {row.current ? (
                <>
                  {" "}
                  <span className="device-mark">
                    {DEVICE_LIST_MESSAGES.thisDevice}
                  </span>
                </>
              ) : null}
              {row.isNew ? (
                <>
                  {" "}
                  <span className="device-mark">
                    {DEVICE_LIST_MESSAGES.newDevice}
                  </span>
                </>
              ) : null}
            </p>
            <dl className="account-facts">
              <dt>Platform</dt>
              <dd>{row.platformName}</dd>
              <dt>Created</dt>
              <dd>
                <Time timestamp={row.createdAt} format={format} />
              </dd>
              <dt>Last seen</dt>
              <dd>
                {row.lastSeenAt === null ? (
                  DEVICE_LIST_MESSAGES.neverConnected
                ) : (
                  <Time timestamp={row.lastSeenAt} format={format} />
                )}
              </dd>
              <dt>Last sign-in</dt>
              <dd>
                <Time timestamp={row.lastSignInAt} format={format} />
              </dd>
              {row.revokedAt === null ? (
                <>
                  <dt>Sign-in expires</dt>
                  <dd>
                    <Time timestamp={row.signInExpiresAt} format={format} />
                  </dd>
                </>
              ) : (
                <>
                  <dt>Revoked</dt>
                  <dd>
                    <Time timestamp={row.revokedAt} format={format} />
                  </dd>
                </>
              )}
            </dl>
            {!acts || labelId === undefined ? null : (
              <div className="account-actions">
                <ActionButton
                  label={DEVICE_ACTION_LABELS.remove}
                  describedBy={labelId}
                  inert={inert}
                  onClick={(button) => onRevoke?.(row.id, "removed", button)}
                />
                <ActionButton
                  label={DEVICE_ACTION_LABELS.revokeAsLost}
                  describedBy={labelId}
                  inert={inert}
                  onClick={(button) => onRevoke?.(row.id, "lost", button)}
                />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Time({
  timestamp,
  format,
}: {
  readonly timestamp: string;
  readonly format: Intl.DateTimeFormat;
}) {
  return (
    <time dateTime={timestamp}>{formatDeviceTime(timestamp, format)}</time>
  );
}

/**
 * Follows the device list while the section is shown, and asks the main
 * process to load it once when the section opens (`followDeviceList`).
 */
function useDeviceSection(
  bridge: DeviceListBridge | undefined,
): DeviceSectionView {
  const [view, setView] = useState(() =>
    initialDeviceSectionView(bridge !== undefined),
  );
  useEffect(
    () =>
      bridge === undefined ? undefined : followDeviceList(bridge, setView),
    [bridge],
  );
  return view;
}

/**
 * The device actions of the section (`createDeviceActions`) while it is
 * shown; undefined without the bridge.
 */
function useDeviceActions(bridge: DeviceListBridge | undefined): {
  readonly actions: DeviceActionsView;
  readonly controller: DeviceActions | undefined;
} {
  const [actions, setActions] = useState(IDLE_DEVICE_ACTIONS);
  const controller = useMemo(
    () =>
      bridge === undefined
        ? undefined
        : createDeviceActions(bridge, setActions),
    [bridge],
  );
  return { actions, controller };
}

/**
 * The renderer's clock for the section: read again for every new view, which
 * is stored during the render so that React renders again at once with it,
 * when a device stops counting as new or the registration lock ends
 * (`nextDeviceListChange`), and when the window gets the focus or becomes
 * visible again, because a timer can fire late after the computer slept.
 */
function useDeviceListClock(view: DeviceSectionView): number {
  const [reading, setReading] = useState(() => ({ view, now: Date.now() }));
  let held = reading;
  if (held.view !== view) {
    held = { view, now: Date.now() };
    setReading(held);
  }
  const { now } = held;
  const at = nextDeviceListChange(view, now);
  useEffect(() => {
    if (at === undefined) {
      return undefined;
    }
    const timer = setTimeout(
      () => setReading((last) => ({ view: last.view, now: Date.now() })),
      Math.min(Math.max(at - Date.now(), 0), MAX_CLOCK_WAIT_MS),
    );
    return () => clearTimeout(timer);
  }, [at, now]);
  useEffect(() => {
    const readAgain = () =>
      setReading((last) => ({ view: last.view, now: Date.now() }));
    window.addEventListener("focus", readAgain);
    document.addEventListener("visibilitychange", readAgain);
    return () => {
      window.removeEventListener("focus", readAgain);
      document.removeEventListener("visibilitychange", readAgain);
    };
  }, []);
  return now;
}
