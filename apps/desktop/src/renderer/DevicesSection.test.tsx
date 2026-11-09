import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";
import type { DeviceListView, DeviceView } from "../shared/ipc-contract.ts";
import {
  DevicesSectionContent,
  type DevicesSectionContentProps,
} from "./DevicesSection.tsx";
import {
  DEVICE_LIST_MESSAGES,
  DEVICE_LIST_PROBLEM_MESSAGES,
  deviceTimeFormat,
  type DeviceSectionView,
} from "./device-view.ts";

const NOW = Date.parse("2026-11-09T12:00:00.000Z");
const UTC_TIME = deviceTimeFormat({ locale: "en-GB", timeZone: "UTC" });

const THIS_DEVICE: DeviceView = {
  id: "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3",
  label: "Mac",
  platform: "macos",
  createdAt: "2026-10-01T10:00:00.000Z",
  lastSeenAt: "2026-11-09T11:59:00.000Z",
  lastSignInAt: "2026-11-07T10:00:00.000Z",
  signInExpiresAt: "2026-12-07T10:00:00.000Z",
  revokedAt: null,
  current: true,
};

/** A label that a person typed as markup, and that must stay text. */
const MARKUP_LABEL = "<b>Work</b> laptop";

const NEW_LAPTOP: DeviceView = {
  ...THIS_DEVICE,
  id: "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a4",
  label: MARKUP_LABEL,
  platform: "windows",
  createdAt: "2026-11-08T09:00:00.000Z",
  lastSeenAt: null,
  current: false,
};

const LOST_LAPTOP: DeviceView = {
  ...THIS_DEVICE,
  id: "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a5",
  label: "Lost laptop",
  platform: "linux",
  createdAt: "2026-09-01T09:00:00.000Z",
  revokedAt: "2026-11-08T08:00:00.000Z",
  current: false,
};

function known(state: Partial<DeviceListView> = {}): DeviceSectionView {
  return {
    kind: "known",
    state: {
      status: "ready",
      revision: 1,
      devices: [NEW_LAPTOP, THIS_DEVICE, LOST_LAPTOP],
      registrationLockedUntil: null,
      newDevices: [],
      ...state,
    } as DeviceListView,
  };
}

function props(
  overrides: Partial<DevicesSectionContentProps> = {},
): DevicesSectionContentProps {
  return {
    view: known(),
    now: NOW,
    timeFormat: UTC_TIME,
    ...overrides,
  };
}

function render(overrides: Partial<DevicesSectionContentProps> = {}): string {
  return renderToString(<DevicesSectionContent {...props(overrides)} />);
}

interface HostProps {
  readonly children?: ReactNode;
  readonly onClick?: () => void;
  readonly style?: unknown;
  readonly [key: string]: unknown;
}

/** The host elements of a tree, with function components called. */
function elementsOf(node: ReactNode): ReactElement<HostProps>[] {
  if (Array.isArray(node)) {
    return node.flatMap((child: ReactNode) => elementsOf(child));
  }
  if (!isValidElement<HostProps>(node)) {
    return [];
  }
  if (typeof node.type === "function") {
    return elementsOf(
      (node.type as (props: HostProps) => ReactNode)(node.props),
    );
  }
  return [node, ...elementsOf(node.props.children)];
}

test("each state of the section has its fixed text in one status paragraph", () => {
  const status = (text: string) =>
    `<p class="account-message" role="status">${text}</p>`;
  // The log region of the notices is always there, also empty, so that a
  // screen reader announces the first notice that is added.
  expect(render({ view: { kind: "unavailable" } })).toBe(
    `<section class="account-panel" aria-labelledby="devices-title"><h3 id="devices-title">Devices</h3>${status(DEVICE_LIST_MESSAGES.unavailable)}<div class="device-notices" role="log" aria-label="New devices"></div></section>`,
  );
  for (const [view, text] of [
    [{ kind: "pending" }, DEVICE_LIST_MESSAGES.pending],
    [
      known({ status: "signed_out", devices: [] }),
      DEVICE_LIST_MESSAGES.signedOut,
    ],
    [known({ status: "loading", devices: [] }), DEVICE_LIST_MESSAGES.loading],
    [known({ devices: [] }), DEVICE_LIST_MESSAGES.empty],
  ] as const) {
    const html = render({ view });
    expect(html).toContain(status(text));
    expect(html).not.toContain("<ul");
  }
  // Ready with devices: the paragraph stays, empty.
  expect(render()).toContain(status(""));
  expect(DEVICE_LIST_MESSAGES).toMatchObject({
    unavailable: "Devices are not available.",
    pending: "Checking the devices.",
    signedOut: "The devices appear once this device is signed in.",
    loading: "Loading the devices.",
    empty: "No devices are listed.",
  });
});

test("an unavailable list shows its problem with what was loaded before", () => {
  const html = render({
    view: known({
      status: "unavailable",
      problem: "rate_limited",
    } as Partial<DeviceListView>),
  });
  expect(html).toContain(
    `<p class="account-message" role="status">${DEVICE_LIST_PROBLEM_MESSAGES.rate_limited}</p>`,
  );
  expect(html).toContain("Active devices");
  expect(html).toContain("Mac");
});

test("the active devices come first with this device marked, each with its platform and times, and the revoked ones apart", () => {
  const html = render();

  expect(html).toContain(
    '<h4 id="active-devices-title">Active devices</h4><ul class="device-list" aria-labelledby="active-devices-title">',
  );
  // The new laptop: created yesterday, never connected.
  expect(html).toContain(
    '<li><p class="device-name"><span class="device-label" dir="auto">&lt;b&gt;Work&lt;/b&gt; laptop</span> <span class="device-mark">New</span></p><dl class="account-facts"><dt>Platform</dt><dd>Windows</dd><dt>Created</dt><dd><time dateTime="2026-11-08T09:00:00.000Z">8 Nov 2026, 09:00</time></dd><dt>Last seen</dt><dd>Never connected</dd><dt>Last sign-in</dt><dd><time dateTime="2026-11-07T10:00:00.000Z">7 Nov 2026, 10:00</time></dd><dt>Sign-in expires</dt><dd><time dateTime="2026-12-07T10:00:00.000Z">7 Dec 2026, 10:00</time></dd></dl></li>',
  );
  // This device: marked, not new.
  expect(html).toContain(
    '<li aria-current="true"><p class="device-name"><span class="device-label" dir="auto">Mac</span> <span class="device-mark">This device</span></p><dl class="account-facts"><dt>Platform</dt><dd>macOS</dd><dt>Created</dt><dd><time dateTime="2026-10-01T10:00:00.000Z">1 Oct 2026, 10:00</time></dd><dt>Last seen</dt><dd><time dateTime="2026-11-09T11:59:00.000Z">9 Nov 2026, 11:59</time></dd>',
  );
  // The revoked laptop: in its own group, with its revocation time instead
  // of the sign-in expiry.
  expect(html).toContain(
    '<h4 id="revoked-devices-title">Revoked devices</h4><ul class="device-list" aria-labelledby="revoked-devices-title"><li><p class="device-name"><span class="device-label" dir="auto">Lost laptop</span></p><dl class="account-facts"><dt>Platform</dt><dd>Linux</dd>',
  );
  expect(html).toContain(
    '<dt>Revoked</dt><dd><time dateTime="2026-11-08T08:00:00.000Z">8 Nov 2026, 08:00</time></dd></dl></li></ul>',
  );
  expect(html.indexOf("Active devices")).toBeLessThan(
    html.indexOf("Revoked devices"),
  );
  expect(html.indexOf("Work&lt;/b&gt;")).toBeLessThan(html.indexOf(">Mac<"));
  // No ID shows, and no label becomes markup.
  expect(html).not.toContain("0192f2a0");
  expect(html).not.toContain("<b>");
  expect(
    elementsOf(DevicesSectionContent(props())).every(
      (element) => element.props.style === undefined,
    ),
  ).toBe(true);
});

test("without active devices it says so, and without revoked ones it shows no group for them", () => {
  const onlyRevoked = render({ view: known({ devices: [LOST_LAPTOP] }) });
  expect(onlyRevoked).toContain(
    `<h4 id="active-devices-title">Active devices</h4><p class="account-message">${DEVICE_LIST_MESSAGES.noActiveDevices}</p><h4 id="revoked-devices-title">`,
  );
  const onlyActive = render({ view: known({ devices: [THIS_DEVICE] }) });
  expect(onlyActive).not.toContain("Revoked devices");
});

test("a device stops being new 7 days after it was created, by the clock it is given", () => {
  const week = 7 * 24 * 60 * 60 * 1000;
  const created = Date.parse(NEW_LAPTOP.createdAt);
  const newMark = '<span class="device-mark">New</span>';
  expect(
    render({ view: known({ devices: [NEW_LAPTOP] }), now: created + week - 1 }),
  ).toContain(newMark);
  expect(
    render({ view: known({ devices: [NEW_LAPTOP] }), now: created + week }),
  ).not.toContain(newMark);
});

test("while the registration lock is in force, a line says until when new devices cannot register", () => {
  const html = render({
    view: known({ registrationLockedUntil: "2026-11-15T08:00:00.000Z" }),
  });
  expect(html).toContain(
    '<p class="account-warning">New devices cannot be registered on this account until <time dateTime="2026-11-15T08:00:00.000Z">15 Nov 2026, 08:00</time>.</p>',
  );
  // Once its end has passed by the clock, the line goes.
  expect(
    render({
      view: known({ registrationLockedUntil: "2026-11-09T11:00:00.000Z" }),
    }),
  ).not.toContain("cannot be registered");
  expect(render()).not.toContain("cannot be registered");
  // The lift itself is not offered yet.
  expect(html).not.toContain("<button");
});

test("the notices of new devices name each label as text and its platform in one log region, and the button dismisses the notices that are shown", () => {
  const second = {
    id: "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a6",
    label: "Second laptop",
    platform: "linux" as const,
    createdAt: "2026-11-09T09:00:00.000Z",
  };
  const view = known({
    newDevices: [
      {
        id: NEW_LAPTOP.id,
        label: MARKUP_LABEL,
        platform: "windows",
        createdAt: NEW_LAPTOP.createdAt,
      },
      second,
    ],
  });
  const html = render({ view, onDismissNewDevices: () => undefined });
  // One polite log region announces a notice that is added; no notice is an
  // alert of its own, so the notices held when the screen opens are not all
  // read out. The button stays outside the region and names what it ends.
  expect(html).toContain(
    '<div class="device-notices" role="log" aria-label="New devices"><p class="account-warning">A new device was registered on this account: <span dir="auto">&lt;b&gt;Work&lt;/b&gt; laptop</span> (Windows), <time dateTime="2026-11-08T09:00:00.000Z">8 Nov 2026, 09:00</time>.</p><p class="account-warning">A new device was registered on this account: <span dir="auto">Second laptop</span> (Linux), <time dateTime="2026-11-09T09:00:00.000Z">9 Nov 2026, 09:00</time>.</p></div><div class="account-actions"><button type="button" class="panel-action">Dismiss the notices</button></div>',
  );
  expect(html).not.toContain('role="alert"');
  expect(html.match(/role="log"/g)).toHaveLength(1);

  const dismissed: (readonly string[])[] = [];
  const buttons = elementsOf(
    DevicesSectionContent(
      props({
        view,
        onDismissNewDevices: (deviceIds) => {
          dismissed.push(deviceIds);
        },
      }),
    ),
  ).filter((element) => element.type === "button");
  expect(buttons).toHaveLength(1);
  buttons[0]?.props.onClick?.();
  // The IDs of the notices that the section shows, and no other.
  expect(dismissed).toEqual([[NEW_LAPTOP.id, second.id]]);

  // Without the bridge, no button; without a notice, an empty region and no
  // button.
  expect(render({ view })).not.toContain("<button");
  const none = render({ onDismissNewDevices: () => undefined });
  expect(none).toContain(
    '<div class="device-notices" role="log" aria-label="New devices"></div>',
  );
  expect(none).not.toContain("<button");
});
