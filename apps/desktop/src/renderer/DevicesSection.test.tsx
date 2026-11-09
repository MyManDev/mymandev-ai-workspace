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
  readonly onClick?: (event?: unknown) => void;
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
  // Without a state of the main process there is no log region of notices.
  expect(render({ view: { kind: "unavailable" } })).toBe(
    `<section class="account-panel" aria-labelledby="devices-title"><h3 id="devices-title" tabindex="-1">Devices</h3>${status(DEVICE_LIST_MESSAGES.unavailable)}</section>`,
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

test("the log region of the notices enters the page with the first state, together with the notices that it holds, and stays for every later state", () => {
  const region =
    '<div class="device-notices" role="log" aria-label="New devices">';
  // Before the first state, and without the bridge, there is no region, so
  // the notices of the first state are not added to a region in the page.
  for (const view of [{ kind: "pending" }, { kind: "unavailable" }] as const) {
    expect(render({ view }), view.kind).not.toContain('role="log"');
  }
  // With the first state, the region holds its notices at once.
  const notice = {
    id: NEW_LAPTOP.id,
    label: "Work laptop",
    platform: "windows" as const,
    createdAt: NEW_LAPTOP.createdAt,
  };
  const first = render({ view: known({ newDevices: [notice] }) });
  expect(first).toContain(
    `${region}<div class="device-notice"><p class="account-warning" id="new-device-notice-0">A new device was registered on this account: <span dir="auto">Work laptop</span>`,
  );
  // Every state has the region, also empty, so that a notice that a later
  // state adds is announced.
  for (const state of [
    { status: "signed_out", devices: [] },
    { status: "loading", devices: [] },
    { status: "unavailable", problem: "failed" },
    {},
  ] as Partial<DeviceListView>[]) {
    expect(render({ view: known(state) }), JSON.stringify(state)).toContain(
      `${region}</div>`,
    );
  }
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
    '<p class="account-warning" id="registration-lock-line">New devices cannot be registered on this account until <time dateTime="2026-11-15T08:00:00.000Z">15 Nov 2026, 08:00</time>.</p>',
  );
  // Once its end has passed by the clock, the line goes.
  expect(
    render({
      view: known({ registrationLockedUntil: "2026-11-09T11:00:00.000Z" }),
    }),
  ).not.toContain("cannot be registered");
  expect(render()).not.toContain("cannot be registered");
  // Without the bridge the lift is not offered.
  expect(html).not.toContain("<button");
});

test("Lift the registration lock shows on the lock line, described by it, only while the lock is in force, and passes its button on", () => {
  const calls: unknown[] = [];
  const onLiftRegistrationLock = (button: Element | null) => {
    calls.push(button);
  };
  const locked = known({ registrationLockedUntil: "2026-11-15T08:00:00.000Z" });
  const html = render({ view: locked, onLiftRegistrationLock });
  expect(html).toContain(
    '<p class="account-warning" id="registration-lock-line">New devices cannot be registered on this account until <time dateTime="2026-11-15T08:00:00.000Z">15 Nov 2026, 08:00</time>.</p><div class="account-actions"><button type="button" class="panel-action" aria-describedby="registration-lock-line">Lift the registration lock</button></div>',
  );
  // Not after its end, and not without a lock.
  for (const view of [
    known({ registrationLockedUntil: "2026-11-09T12:00:00.000Z" }),
    known({ registrationLockedUntil: null }),
  ]) {
    expect(render({ view, onLiftRegistrationLock })).not.toContain(
      "Lift the registration lock",
    );
  }
  const button = elementsOf(
    DevicesSectionContent(props({ view: locked, onLiftRegistrationLock })),
  ).find((element) => element.props.children === "Lift the registration lock");
  const target = { name: "the button" };
  button?.props.onClick?.({ currentTarget: target });
  expect(calls).toEqual([target]);
});

/** Lets the answers of resolved promises apply. */
async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

test("the notices of new devices name each label as text and its platform in one log region, and the button dismisses the notices that are shown", async () => {
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
  const html = render({
    view,
    onDismissNewDevices: () => Promise.resolve(true),
  });
  // One polite log region announces a notice that is added; no notice is an
  // alert of its own, so the notices held when the screen opens are not all
  // read out. The button stays outside the region and names what it ends.
  expect(html).toContain(
    '<div class="device-notices" role="log" aria-label="New devices"><div class="device-notice"><p class="account-warning" id="new-device-notice-0">A new device was registered on this account: <span dir="auto">&lt;b&gt;Work&lt;/b&gt; laptop</span> (Windows), <time dateTime="2026-11-08T09:00:00.000Z">8 Nov 2026, 09:00</time>.</p></div><div class="device-notice"><p class="account-warning" id="new-device-notice-1">A new device was registered on this account: <span dir="auto">Second laptop</span> (Linux), <time dateTime="2026-11-09T09:00:00.000Z">9 Nov 2026, 09:00</time>.</p></div></div><div class="account-actions"><button type="button" class="panel-action">Dismiss the notices</button></div>',
  );
  expect(html).not.toContain('role="alert"');
  expect(html.match(/role="log"/g)).toHaveLength(1);

  // The IDs of the notices that the section shows, and no other; the focus
  // moves to the title only once the main process ended a notice, because
  // the button goes away with them.
  const dismissWith = async (answer: Promise<boolean>) => {
    const calls: string[] = [];
    const [button] = elementsOf(
      DevicesSectionContent(
        props({
          view,
          onDismissNewDevices: (deviceIds) => {
            calls.push(`dismiss ${deviceIds.join(" ")}`);
            return answer;
          },
          onFocusTitle: () => {
            calls.push("focus the title");
          },
        }),
      ),
    ).filter((element) => element.type === "button");
    button?.props.onClick?.();
    // The focus waits for the answer.
    expect(calls).toEqual([`dismiss ${NEW_LAPTOP.id} ${second.id}`]);
    await settle();
    return calls;
  };
  expect(await dismissWith(Promise.resolve(true))).toEqual([
    `dismiss ${NEW_LAPTOP.id} ${second.id}`,
    "focus the title",
  ]);
  // A call that failed, or that ended nothing, keeps the focus on the button.
  expect(await dismissWith(Promise.resolve(false))).toEqual([
    `dismiss ${NEW_LAPTOP.id} ${second.id}`,
  ]);
  expect(await dismissWith(Promise.reject(new Error("refused")))).toEqual([
    `dismiss ${NEW_LAPTOP.id} ${second.id}`,
  ]);
  // The title takes the focus without a tab stop.
  expect(html).toContain('<h3 id="devices-title" tabindex="-1">Devices</h3>');

  // Without the bridge, no button; without a notice, an empty region and no
  // button.
  expect(render({ view })).not.toContain("<button");
  const none = render({ onDismissNewDevices: () => Promise.resolve(true) });
  expect(none).toContain(
    '<div class="device-notices" role="log" aria-label="New devices"></div>',
  );
  expect(none).not.toContain("<button");
});

/** The props of every device action, which note each call in `calls`. */
function actionProps(calls: string[]): Partial<DevicesSectionContentProps> {
  return {
    onRevokeDevice: (deviceId, reason, button) => {
      calls.push(`revoke ${deviceId} ${reason} ${String(button)}`);
    },
    onLiftRegistrationLock: (button) => {
      calls.push(`lift ${String(button)}`);
    },
    onDismissAdvice: () => {
      calls.push("dismiss the advice");
    },
    onFocusTitle: () => {
      calls.push("focus the title");
    },
  };
}

/** The buttons of a section, by their text. */
function buttonsOf(
  overrides: Partial<DevicesSectionContentProps>,
): ReactElement<HostProps>[] {
  return elementsOf(DevicesSectionContent(props(overrides))).filter(
    (element) => element.type === "button",
  );
}

test("each other active device has Remove and Revoke as lost, described by its label; this device and the revoked ones have none", () => {
  const calls: string[] = [];
  const html = render(actionProps(calls));
  // The new laptop, another active device: both actions, described by its
  // label, which takes an ID by its place in the list, never the device ID.
  expect(html).toContain(
    '<li><p class="device-name"><span class="device-label" dir="auto" id="active-devices-title-device-0">&lt;b&gt;Work&lt;/b&gt; laptop</span> <span class="device-mark">New</span></p>',
  );
  expect(html).toContain(
    '<dt>Sign-in expires</dt><dd><time dateTime="2026-12-07T10:00:00.000Z">7 Dec 2026, 10:00</time></dd></dl><div class="account-actions"><button type="button" class="panel-action" aria-describedby="active-devices-title-device-0">Remove</button><button type="button" class="panel-action" aria-describedby="active-devices-title-device-0">Revoke as lost</button></div></li>',
  );
  // This device and the revoked laptop: no actions and no ID.
  expect(html.match(/>Remove</g)).toHaveLength(1);
  expect(html.match(/>Revoke as lost</g)).toHaveLength(1);
  expect(html).toContain(
    '<span class="device-label" dir="auto">Mac</span> <span class="device-mark">This device</span>',
  );
  expect(html).toContain(
    '<span class="device-label" dir="auto">Lost laptop</span>',
  );
  expect(html).not.toContain("0192f2a0");

  // Each button passes its device, its reason, and itself on.
  for (const button of buttonsOf(actionProps(calls))) {
    button.props.onClick?.({
      currentTarget: `${String(button.props.children)} button`,
    });
  }
  expect(calls).toEqual([
    `revoke ${NEW_LAPTOP.id} removed Remove button`,
    `revoke ${NEW_LAPTOP.id} lost Revoke as lost button`,
  ]);
  // Without the bridge, none.
  expect(render()).not.toContain("<button");
});

test("each notice of a new device has This was not me: revoke as lost, bound to its device and described by the notice", () => {
  const calls: string[] = [];
  const second = {
    id: "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a6",
    label: "Second laptop",
    platform: "linux" as const,
    createdAt: "2026-11-09T09:00:00.000Z",
  };
  const view = known({
    devices: [THIS_DEVICE],
    newDevices: [
      {
        id: NEW_LAPTOP.id,
        label: "Work laptop",
        platform: "windows",
        createdAt: NEW_LAPTOP.createdAt,
      },
      second,
    ],
  });
  const html = render({ view, ...actionProps(calls) });
  expect(html).toContain(
    '<div class="device-notice"><p class="account-warning" id="new-device-notice-0">A new device was registered on this account: <span dir="auto">Work laptop</span> (Windows), <time dateTime="2026-11-08T09:00:00.000Z">8 Nov 2026, 09:00</time>.</p><button type="button" class="panel-action" aria-describedby="new-device-notice-0">This was not me: revoke as lost</button></div><div class="device-notice"><p class="account-warning" id="new-device-notice-1">',
  );
  expect(html).toContain(
    '<button type="button" class="panel-action" aria-describedby="new-device-notice-1">This was not me: revoke as lost</button></div></div>',
  );
  for (const button of buttonsOf({ view, ...actionProps(calls) })) {
    if (button.props.children === "This was not me: revoke as lost") {
      button.props.onClick?.({ currentTarget: "notice button" });
    }
  }
  expect(calls).toEqual([
    `revoke ${NEW_LAPTOP.id} lost notice button`,
    `revoke ${second.id} lost notice button`,
  ]);
});

test("while a device action runs, every device action's button stays focusable and does nothing, and the other buttons still work", () => {
  const calls: string[] = [];
  const running = {
    view: known({
      registrationLockedUntil: "2026-11-15T08:00:00.000Z",
      newDevices: [
        {
          id: NEW_LAPTOP.id,
          label: "Work laptop",
          platform: "windows",
          createdAt: NEW_LAPTOP.createdAt,
        },
      ],
    }),
    actions: { running: true, message: undefined, advice: true },
    onDismissNewDevices: () => {
      calls.push("dismiss the notices");
      return Promise.resolve(true);
    },
    ...actionProps(calls),
  };
  const html = render(running);
  for (const label of [
    "Remove",
    "Revoke as lost",
    "This was not me: revoke as lost",
    "Lift the registration lock",
  ]) {
    expect(html, label).toMatch(
      new RegExp(`<button [^>]*aria-disabled="true"[^>]*>${label}</button>`),
    );
  }
  expect(html).not.toContain(" disabled");
  const buttons = buttonsOf(running);
  for (const button of buttons) {
    button.props.onClick?.({ currentTarget: "button" });
  }
  // Only the dismissals act.
  expect(calls).toEqual([
    "dismiss the advice",
    "focus the title",
    "dismiss the notices",
  ]);
  expect(
    buttons
      .filter((button) => button.props["aria-disabled"] === "true")
      .map((button) => button.props.children),
  ).toEqual([
    "This was not me: revoke as lost",
    "Lift the registration lock",
    "Remove",
    "Revoke as lost",
  ]);
  // Idle, none is inert.
  expect(render(actionProps([]))).not.toContain("aria-disabled");
});

test("the sentence of the last device action sits in its own status paragraph, which takes the focus without a tab stop, and the advice follows a revocation as lost until it is dismissed", () => {
  const calls: string[] = [];
  const idle = render(actionProps(calls));
  expect(idle).toContain(
    '<p class="account-message" role="status"></p><p class="account-message" id="device-action-message" role="status" tabindex="-1"></p>',
  );
  expect(idle).not.toContain("After a lost device");
  // Without the bridge there is no paragraph of the actions.
  expect(render()).not.toContain("device-action-message");

  const after = {
    actions: {
      running: false,
      message: "The device was revoked as lost.",
      advice: true,
    },
    ...actionProps(calls),
  };
  const html = render(after);
  expect(html).toContain(
    '<p class="account-message" id="device-action-message" role="status" tabindex="-1">The device was revoked as lost.</p><div class="device-advice"><h4 id="lost-device-advice-title">After a lost device</h4><ul aria-labelledby="lost-device-advice-title"><li>End that device&#x27;s GitHub sessions: open github.com/settings/sessions in your browser and revoke them.</li><li>If the device was unlocked, change your GitHub password.</li><li>Rotate the AI provider credentials that are stored on that device. The server cannot reach them.</li></ul><div class="account-actions"><button type="button" class="panel-action">Dismiss the advice</button></div></div>',
  );
  // The address is text: no link that opens on its own.
  expect(html).not.toContain("<a");
  expect(html).not.toContain("href");
  expect(html).not.toContain("https://");

  const dismiss = buttonsOf(after).find(
    (button) => button.props.children === "Dismiss the advice",
  );
  dismiss?.props.onClick?.();
  // The button goes away with the advice, so the focus moves to the title.
  expect(calls).toEqual(["dismiss the advice", "focus the title"]);
});
