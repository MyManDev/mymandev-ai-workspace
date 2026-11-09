import { useCallback, useEffect, useState } from "react";
import type { DeviceListBridge } from "../shared/desktop-bridge.ts";
import {
  DEVICE_LIST_MESSAGES,
  describeDeviceList,
  deviceTimeFormat,
  followDeviceList,
  formatDeviceTime,
  initialDeviceSectionView,
  MAX_CLOCK_WAIT_MS,
  nextDeviceListChange,
  type DeviceRow,
  type DeviceSectionView,
  type NewDeviceRow,
} from "./device-view.ts";

/** The ID of the section's title. */
export const DEVICES_TITLE_ID = "devices-title";

/**
 * The account's devices on the Account screen (#95, D4 and D5b): the active
 * devices with this one marked, the revoked ones apart, the devices created
 * in the last 7 days marked as new, the end of a registration lock in
 * force, and the notices of new devices. The main process holds the list
 * and keeps it current; the section asks it to load the list when it opens.
 * It changes no device: the device actions follow in later pull requests.
 */
export function DevicesSection({
  devices,
}: {
  /** The device list functions from the preload script; undefined outside Electron. */
  readonly devices: DeviceListBridge | undefined;
}) {
  const view = useDeviceSection(devices);
  const now = useDeviceListClock(view);
  const onDismissNewDevices = useCallback(() => {
    // The next state shows what changed; a failed call changes nothing.
    devices?.dismissNewDevices().catch(() => undefined);
  }, [devices]);
  return (
    <DevicesSectionContent
      view={view}
      now={now}
      onDismissNewDevices={
        devices === undefined ? undefined : onDismissNewDevices
      }
    />
  );
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
  /** Ends the notices of new devices; undefined without the bridge. */
  readonly onDismissNewDevices?: (() => void) | undefined;
}

/**
 * The section for a view, without state. The status paragraph is always
 * rendered, empty when there is nothing to say, so that a screen reader
 * announces a new text. Labels are text that people entered, so each one
 * is rendered as text and takes its direction from its own content
 * (`dir="auto"`). The marks of this device and of a new device are text.
 */
export function DevicesSectionContent({
  view,
  now,
  timeFormat,
  onDismissNewDevices,
}: DevicesSectionContentProps) {
  const model = describeDeviceList(view, now);
  const format = timeFormat ?? deviceTimeFormat();
  const { lists } = model;
  return (
    <section className="account-panel" aria-labelledby={DEVICES_TITLE_ID}>
      <h3 id={DEVICES_TITLE_ID}>Devices</h3>
      <p className="account-message" role="status">
        {model.status}
      </p>
      {model.newDevices.length === 0 ? null : (
        <NewDeviceNotices
          notices={model.newDevices}
          format={format}
          onDismiss={onDismissNewDevices}
        />
      )}
      {model.lockedUntil === null ? null : (
        <p className="account-warning">
          {"New devices cannot be registered on this account until "}
          <Time timestamp={model.lockedUntil} format={format} />.
        </p>
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
            />
          )}
          {lists.revoked.length === 0 ? null : (
            <>
              <h4 id="revoked-devices-title">Revoked devices</h4>
              <DeviceItems
                rows={lists.revoked}
                labelledBy="revoked-devices-title"
                format={format}
              />
            </>
          )}
        </>
      )}
    </section>
  );
}

function NewDeviceNotices({
  notices,
  format,
  onDismiss,
}: {
  readonly notices: readonly NewDeviceRow[];
  readonly format: Intl.DateTimeFormat;
  readonly onDismiss: (() => void) | undefined;
}) {
  return (
    <div className="device-notices">
      {notices.map((notice) => (
        <p key={notice.id} className="account-warning" role="alert">
          {"A new device was registered on this account: "}
          <span dir="auto">{notice.label}</span>
          {` (${notice.platformName}), `}
          <Time timestamp={notice.createdAt} format={format} />.
        </p>
      ))}
      {onDismiss === undefined ? null : (
        <div className="account-actions">
          <button type="button" className="panel-action" onClick={onDismiss}>
            {DEVICE_LIST_MESSAGES.dismiss}
          </button>
        </div>
      )}
    </div>
  );
}

function DeviceItems({
  rows,
  labelledBy,
  format,
}: {
  readonly rows: readonly DeviceRow[];
  readonly labelledBy: string;
  readonly format: Intl.DateTimeFormat;
}) {
  return (
    <ul className="device-list" aria-labelledby={labelledBy}>
      {rows.map((row) => (
        <li key={row.id} aria-current={row.current ? "true" : undefined}>
          <p className="device-name">
            <span className="device-label" dir="auto">
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
        </li>
      ))}
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
 * The renderer's clock for the section: read again for every new view, which
 * is stored during the render so that React renders again at once with it,
 * and when a device stops counting as new or the registration lock ends
 * (`nextDeviceListChange`).
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
  return now;
}
