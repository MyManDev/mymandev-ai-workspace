import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";
import {
  type AccountStatus,
  DEVICE_STATES,
  SIGN_IN_OUTCOME_CODES,
} from "../shared/ipc-contract.ts";
import {
  AccountPanelContent,
  type AccountPanelContentProps,
} from "./AccountPanel.tsx";
import {
  DEVICE_KEY_PROBLEM_MESSAGES,
  DEVICE_STATE_MESSAGES,
  SIGN_IN_OUTCOME_MESSAGES,
  SIGN_IN_RENEWAL_MESSAGES,
  signInEndFormat,
  signInTimeFormat,
} from "./account-view.ts";

/** The panel's clock in the tests, and time formats that do not depend on the machine. */
const NOW = Date.parse("2026-11-06T10:00:00.000Z");
const UTC_TIME = signInTimeFormat({ locale: "en-GB", timeZone: "UTC" });
const UTC_DATE = signInEndFormat({ locale: "en-GB", timeZone: "UTC" });
const DAY_MS = 24 * 60 * 60 * 1000;

const AUTHORIZE_URL =
  "https://api.mymandev.example/auth/github/authorize?code_challenge=abc&state=def";
const WARNING =
  "Open this address in your own browser. Do not share it with anyone.";

const SIGNED_OUT: AccountStatus = {
  revision: 1,
  account: { kind: "signed_out" },
  signIn: { kind: "idle" },
  lastOutcome: null,
  deviceKey: "ready",
  replacementPending: false,
  apiOrigin: "set",
  device: "no_device",
};

const SIGNED_IN: AccountStatus = {
  ...SIGNED_OUT,
  account: {
    kind: "signed_in",
    login: "octocat",
    displayName: "The Octocat",
    deviceId: "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3",
    signInExpiresAt: "2026-12-02T10:00:00.000Z",
  },
  device: "signed_in",
};

type Handler = keyof Pick<
  AccountPanelContentProps,
  | "onStartSignIn"
  | "onUseAnotherBrowser"
  | "onCancelSignIn"
  | "onUnlock"
  | "onForget"
  | "onSignOut"
  | "onRemoveDevice"
>;

function props(
  overrides: Partial<AccountPanelContentProps> = {},
  calls: string[] = [],
): AccountPanelContentProps {
  const record =
    (name: Handler) =>
    (...args: unknown[]) => {
      calls.push(args.length === 0 ? name : `${name} ${String(args[0])}`);
    };
  return {
    view: { kind: "known", status: SIGNED_OUT },
    busy: false,
    message: undefined,
    onStartSignIn: record("onStartSignIn"),
    onUseAnotherBrowser: record("onUseAnotherBrowser"),
    anotherBrowser: false,
    anotherBrowserReady: true,
    onCancelSignIn: record("onCancelSignIn"),
    onUnlock: record("onUnlock"),
    onForget: record("onForget"),
    onSignOut: record("onSignOut"),
    onRemoveDevice: record("onRemoveDevice"),
    now: NOW,
    timeFormat: UTC_TIME,
    endFormat: UTC_DATE,
    ...overrides,
  };
}

function render(overrides: Partial<AccountPanelContentProps> = {}): string {
  return renderToString(<AccountPanelContent {...props(overrides)} />);
}

function known(
  status: Partial<AccountStatus>,
): AccountPanelContentProps["view"] {
  return { kind: "known", status: { ...SIGNED_OUT, ...status } };
}

interface HostProps {
  readonly children?: ReactNode;
  readonly onClick?: () => void;
  readonly disabled?: boolean;
}

/**
 * The elements below `node`. A component without hooks is called to reach
 * its elements; one with hooks cannot run outside React and stays a leaf.
 */
function elementsOf(node: ReactNode): ReactElement<HostProps>[] {
  if (Array.isArray(node)) {
    return node.flatMap((child: ReactNode) => elementsOf(child));
  }
  if (!isValidElement<HostProps>(node)) {
    return [];
  }
  if (typeof node.type === "function") {
    try {
      return elementsOf(
        (node.type as (props: HostProps) => ReactNode)(node.props),
      );
    } catch {
      return [node];
    }
  }
  return [node, ...elementsOf(node.props.children)];
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((child: ReactNode) => textOf(child)).join("");
  }
  return isValidElement<HostProps>(node) ? textOf(node.props.children) : "";
}

/** Clicks every button and returns its label with the handlers it called. */
function clickEveryButton(
  overrides: Partial<AccountPanelContentProps>,
): [string, string[]][] {
  const calls: string[] = [];
  return elementsOf(AccountPanelContent(props(overrides, calls)))
    .filter((element) => element.type === "button")
    .map((button) => {
      button.props.onClick?.();
      return [textOf(button.props.children), calls.splice(0)];
    });
}

test("without the bridge or before the first status, the panel says so and offers nothing", () => {
  expect(render({ view: { kind: "unavailable" } })).toBe(
    '<section class="account-panel" aria-labelledby="account-title"><h3 id="account-title">This device</h3><p>Sign-in is not available.</p></section>',
  );
  expect(render({ view: { kind: "pending" } })).toContain(
    "<p>Checking the sign-in.</p>",
  );
  const loading = render({ view: known({ deviceKey: "loading" }) });
  expect(loading).toContain('<p role="status">Reading the device key.</p>');
  expect(loading).not.toContain("<button");
});

test("signed out, the panel offers to sign in with GitHub, in the default browser or in another one", () => {
  const html = render();

  expect(html).toContain("<p>Not signed in.</p>");
  expect(html).toContain(
    '<div class="account-actions"><button type="button" class="panel-action">Sign in with GitHub</button><button type="button" class="panel-action">Use another browser</button></div>',
  );
  expect(html).not.toContain('role="alert"');
  expect(clickEveryButton({})).toEqual([
    ["Sign in with GitHub", ["onStartSignIn"]],
    ["Use another browser", ["onUseAnotherBrowser"]],
  ]);
});

test("the sign-in buttons are disabled while busy, while the key is not ready, and without a server address", () => {
  for (const html of [
    render({ busy: true }),
    render({ view: known({ deviceKey: "corrupt" }) }),
  ]) {
    expect(html).toContain(
      '<button type="button" class="panel-action" disabled="">Sign in with GitHub</button><button type="button" class="panel-action" disabled="">Use another browser</button>',
    );
  }
  for (const [apiOrigin, code] of [
    ["unset", "api_origin_unset"],
    ["invalid", "api_origin_invalid"],
  ] as const) {
    const html = render({ view: known({ apiOrigin }) });
    expect(html).toContain(
      '<button type="button" class="panel-action" disabled="" aria-describedby="sign-in-unavailable">Sign in with GitHub</button><button type="button" class="panel-action" disabled="" aria-describedby="sign-in-unavailable">Use another browser</button>',
    );
    expect(html).toContain(
      `<p class="placeholder-note" id="sign-in-unavailable">${SIGN_IN_OUTCOME_MESSAGES[code]}</p>`,
    );
  }
});

test("while the sign-in starts, the panel says so and offers to cancel", () => {
  const view = known({ signIn: { kind: "starting" } });

  expect(render({ view })).toContain(
    '<p role="status">Opening the browser.</p><div class="account-actions"><button type="button" class="panel-action">Cancel</button></div>',
  );
  expect(clickEveryButton({ view })).toEqual([["Cancel", ["onCancelSignIn"]]]);
});

test("while a sign-in in another browser starts, the panel says that it prepares the address, without another browser to choose", () => {
  const view = known({ signIn: { kind: "starting" } });

  expect(render({ view, anotherBrowser: true })).toContain(
    '<p role="status">Preparing the sign-in address.</p><div class="account-actions"><button type="button" class="panel-action">Cancel</button></div>',
  );
  expect(clickEveryButton({ view, anotherBrowser: true })).toEqual([
    ["Cancel", ["onCancelSignIn"]],
  ]);
});

test("once the browser posted to the application, the panel says that the sign-in completes, without a cancel", () => {
  const view = known({ signIn: { kind: "completing" } });
  const html = render({ view });

  expect(html).toContain('<p role="status">Completing the sign-in.</p>');
  expect(html).not.toContain("pairing-code");
  expect(clickEveryButton({ view })).toEqual([]);
});

test("while the browser is open, the pairing code is shown prominently with a cancel", () => {
  const view = known({
    signIn: { kind: "waiting", pairingCode: "042137", opened: true },
  });
  const html = render({ view });

  expect(html).toContain(
    '<p role="status">Continue in your browser, and only if it shows this pairing code:</p><p class="pairing-code">042137</p>',
  );
  expect(html).not.toContain("Sign in with GitHub");
  expect(html).not.toContain("<textarea");
  expect(html).toContain(
    '<div class="account-actions"><button type="button" class="panel-action">Use another browser</button><button type="button" class="panel-action">Cancel</button></div>',
  );
  expect(clickEveryButton({ view })).toEqual([
    ["Use another browser", ["onUseAnotherBrowser"]],
    ["Cancel", ["onCancelSignIn"]],
  ]);
  expect(render({ view, busy: true })).toContain(
    '<button type="button" class="panel-action" disabled="">Use another browser</button><button type="button" class="panel-action" disabled="">Cancel</button>',
  );
});

test("another browser is offered for a waiting sign-in only once the main process accepts a new start", () => {
  const view = known({
    signIn: { kind: "waiting", pairingCode: "042137", opened: true },
  });

  expect(render({ view, anotherBrowserReady: false })).toContain(
    '<div class="account-actions"><button type="button" class="panel-action" disabled="">Use another browser</button><button type="button" class="panel-action">Cancel</button></div>',
  );
  // Without a waiting sign-in, nothing is cancelled, and it is offered at once.
  expect(render({ anotherBrowserReady: false })).toContain(
    '<div class="account-actions"><button type="button" class="panel-action">Sign in with GitHub</button><button type="button" class="panel-action">Use another browser</button></div>',
  );
});

test("when the browser did not open, the URL is in a read-only field with the warning and a button that selects it", () => {
  const view = known({
    signIn: {
      kind: "waiting",
      pairingCode: "042137",
      opened: false,
      authorizeUrl: AUTHORIZE_URL,
      warning: WARNING,
      browser: "default",
    },
  });
  const html = render({ view });

  expect(html).toContain('<p class="pairing-code">042137</p>');
  expect(html).toContain(
    '<label class="account-label" for="sign-in-url">Sign-in address</label><textarea id="sign-in-url" class="account-input account-url-text" rows="4" readOnly="" spellCheck="false" aria-describedby="sign-in-url-warning">https://api.mymandev.example/auth/github/authorize?code_challenge=abc&amp;state=def</textarea>',
  );
  expect(html).toContain(
    `<p class="account-warning" id="sign-in-url-warning">${WARNING}</p>`,
  );
  expect(html).toContain(
    '<button type="button" class="panel-action">Select the address</button>',
  );
  expect(html).toContain("Then copy it, for example with Ctrl+C");
  expect(html).toContain("<p>The browser did not open.</p>");
  expect(clickEveryButton({ view })).toEqual([["Cancel", ["onCancelSignIn"]]]);
});

test("in another browser, the URL is shown with the warning for copying, and another browser is not offered again", () => {
  const view = known({
    signIn: {
      kind: "waiting",
      pairingCode: "042137",
      opened: false,
      authorizeUrl: AUTHORIZE_URL,
      warning: WARNING,
      browser: "other",
    },
  });
  // The status words the address, also when the panel is shown again and
  // no longer knows what the person asked for.
  const html = render({ view, anotherBrowser: false });

  expect(html).toContain(
    '<p role="status">Continue in your browser, and only if it shows this pairing code:</p><p class="pairing-code">042137</p>',
  );
  expect(html).toContain(
    '<div class="account-url"><p>Copy this address into the browser that you want to sign in with.</p><label class="account-label" for="sign-in-url">Sign-in address</label>',
  );
  expect(html).toContain(
    'aria-describedby="sign-in-url-warning">https://api.mymandev.example/auth/github/authorize?code_challenge=abc&amp;state=def</textarea>',
  );
  expect(html).toContain(
    `<p class="account-warning" id="sign-in-url-warning">${WARNING}</p>`,
  );
  expect(html).not.toContain("The browser did not open.");
  expect(clickEveryButton({ view })).toEqual([["Cancel", ["onCancelSignIn"]]]);
});

const SIGNED_IN_BUTTONS = [
  ["Renew the sign-in", ["onStartSignIn"]],
  ["Sign out", ["onSignOut"]],
  ["Remove this device", ["onRemoveDevice"]],
  ["This is not me", ["onForget"]],
];

test("signed in, the panel shows the login, the name, and the end of the sign-in with the device's actions and This is not me", () => {
  const html = render({ view: { kind: "known", status: SIGNED_IN } });

  expect(html).toContain(
    '<dl class="account-facts"><dt>GitHub login</dt><dd>octocat</dd><dt>Name</dt><dd>The Octocat</dd><dt>Signed in until</dt><dd><time dateTime="2026-12-02T10:00:00.000Z">2 December 2026 at 10:00</time></dd></dl>',
  );
  expect(html).not.toContain("0192f2a0");
  expect(html).not.toContain("Sign in with GitHub");
  expect(
    clickEveryButton({ view: { kind: "known", status: SIGNED_IN } }),
  ).toEqual(SIGNED_IN_BUTTONS);
});

test("This is not me asks the main process, which confirms in a native dialog, and waits while it is open", () => {
  const view = { kind: "known", status: SIGNED_IN } as const;

  expect(clickEveryButton({ view })).toContainEqual([
    "This is not me",
    ["onForget"],
  ]);
  const busy = render({ view, busy: true });
  expect(busy).toContain(
    '<button type="button" class="panel-action" disabled="">This is not me</button>',
  );
  // The renderer has no confirmation of its own.
  expect(busy).not.toContain("Remove from this installation");
});

test("after a sign-in, the panel names the login that the device is signed in to, with the way out", () => {
  const html = render({
    view: {
      kind: "known",
      status: { ...SIGNED_IN, lastOutcome: { code: "signed_in" } },
    },
  });

  expect(html).toContain(
    '<p class="account-message" role="status">This device is now signed in to GitHub as<!-- --> <strong>octocat</strong>. If this is not your account, choose &quot;This is not me&quot;.</p>',
  );
  expect(html).toContain(">This is not me</button>");
});

test("while the device is signed out, the panel names no account and no earlier sign-in, and still offers This is not me (#195)", () => {
  for (const device of ["signed_out", "sign_out_report_pending"] as const) {
    // As the main process sends it: no account details and no outcome.
    const status: Partial<AccountStatus> = {
      account: { kind: "hidden" },
      device,
    };
    const view = known(status);
    const html = render({ view });

    expect(html, device).toContain("<p>Not signed in.</p>");
    expect(html, device).toContain(
      `<p class="account-message" role="status">${DEVICE_STATE_MESSAGES[device]}</p>`,
    );
    for (const text of [
      "account-facts",
      "GitHub login",
      "octocat",
      "The Octocat",
      "now signed in",
    ]) {
      expect(html, device).not.toContain(text);
    }
    expect(clickEveryButton({ view }), device).toEqual([
      ["Sign in with GitHub", ["onStartSignIn"]],
      ["Use another browser", ["onUseAnotherBrowser"]],
      ["This is not me", ["onForget"]],
    ]);
    // A later sign-in that did not finish still shows its outcome.
    expect(
      render({
        view: known({ ...status, lastOutcome: { code: "cancelled" } }),
      }),
      device,
    ).toContain(
      `<p class="account-message" role="status">${SIGN_IN_OUTCOME_MESSAGES.cancelled}</p>`,
    );
  }
});

test("a hidden account says nothing about the sign-in while the device is checked, and a refused sign-in after a sign-out names the login only (#195)", () => {
  const starting = known({ account: { kind: "hidden" }, device: "starting" });
  const html = render({ view: starting });

  expect(html).not.toContain("Not signed in.");
  expect(html).toContain(
    `<p class="account-message" role="status">${DEVICE_STATE_MESSAGES.starting}</p>`,
  );
  expect(clickEveryButton({ view: starting })).toEqual([
    ["This is not me", ["onForget"]],
  ]);

  // A signed-out device whose key waits for its passphrase.
  const locked = render({
    view: known({
      account: { kind: "hidden" },
      deviceKey: "passphrase_required",
      device: "key_not_loaded",
    }),
  });
  expect(locked).toContain("<p>Not signed in.</p>");
  expect(locked).toContain('type="password"');
  expect(locked).toContain(">This is not me</button>");

  // A sign-in with another GitHub account after a sign-out.
  const mismatch = render({
    view: known({
      account: { kind: "hidden" },
      device: "account_mismatch",
      lastOutcome: { code: "device_account_mismatch", deviceLogin: "octocat" },
    }),
  });
  expect(mismatch).toContain("<p>Not signed in.</p>");
  expect(mismatch).toContain(
    "This installation belongs to the GitHub account octocat. Sign in with that account.",
  );
  expect(mismatch).not.toContain("account-facts");
  expect(mismatch).not.toContain("The Octocat");
});

test("every outcome has a fixed message, announced as an alert unless it is a success or a cancel", () => {
  for (const code of SIGN_IN_OUTCOME_CODES) {
    if (code === "signed_in") {
      continue;
    }
    const html = render({ view: known({ lastOutcome: { code } }) });
    const role = code === "cancelled" ? "status" : "alert";
    const className =
      code === "cancelled" ? "account-message" : "panel-message";
    expect(html, code).toContain(
      `<p class="${className}" role="${role}">${SIGN_IN_OUTCOME_MESSAGES[code].replaceAll("'", "&#x27;")}</p>`,
    );
  }
  expect(
    render({
      view: known({
        lastOutcome: { code: "device_account_mismatch", deviceLogin: "hubot" },
      }),
    }),
  ).toContain(
    "This installation belongs to the GitHub account hubot. Sign in with that account.",
  );
});

test("an outcome is hidden while a new sign-in runs", () => {
  const html = render({
    view: known({
      lastOutcome: { code: "no_answer" },
      signIn: { kind: "starting" },
    }),
  });

  expect(html).not.toContain(SIGN_IN_OUTCOME_MESSAGES.no_answer);
});

test("a key that needs its passphrase shows a labelled password field and an unlock button", () => {
  const html = render({ view: known({ deviceKey: "passphrase_required" }) });

  expect(html).toContain(
    '<form class="account-form" aria-labelledby="unlock-title"><p id="unlock-title">The device key is protected by a passphrase. Enter it to use this device.</p><label class="account-label" for="account-passphrase">Passphrase</label><input id="account-passphrase" class="account-input" type="password" autoComplete="off" spellCheck="false" value=""/><div class="account-actions"><button type="submit" class="panel-action" disabled="">Unlock</button></div></form>',
  );
  expect(html).toContain(
    '<button type="button" class="panel-action" disabled="">Sign in with GitHub</button>',
  );
  // A signed-in account can still be removed, also without its passphrase.
  const status: AccountStatus = {
    ...SIGNED_IN,
    deviceKey: "passphrase_required",
    device: "key_not_loaded",
  };
  const signedIn = render({ view: { kind: "known", status } });
  expect(signedIn).toContain('type="password"');
  expect(signedIn).toContain(">This is not me</button>");
  // A key that is not loaded cannot sign out or remove the device.
  expect(signedIn).not.toContain(">Sign out</button>");
  expect(signedIn).not.toContain(">Remove this device</button>");
});

test("a key that cannot be used shows why", () => {
  for (const [deviceKey, text] of Object.entries(DEVICE_KEY_PROBLEM_MESSAGES)) {
    expect(
      render({
        view: known({ deviceKey: deviceKey as AccountStatus["deviceKey"] }),
      }),
    ).toContain(`<p class="panel-message" role="alert">${text}</p>`);
  }
});

test("a refused action and a pending key replacement are shown", () => {
  const html = render({
    message: "The passphrase does not open the device key.",
    view: known({ replacementPending: true }),
  });

  expect(html).toContain(
    '<p class="panel-message" role="alert">The passphrase does not open the device key.</p>',
  );
  expect(html).toContain(
    '<p class="placeholder-note">The device key of the last sign-in is not confirmed yet.</p>',
  );
});

test("a start refused during the grace period of an uncertain sign-in shows when a new sign-in can start, until then (#199)", () => {
  const refusal = `<p class="panel-message" role="alert">${SIGN_IN_OUTCOME_MESSAGES.replacement_pending}</p>`;
  const note =
    '<p class="account-message" role="status">A new sign-in can start after 10:10. Try again then.</p>';
  const graced = known({
    ...SIGNED_IN,
    replacementPending: true,
    lastOutcome: {
      code: "replacement_pending",
      retryAfter: "2026-11-06T10:09:30.000Z",
    },
  });

  // Next to the refusal, in the local time of the format.
  const html = render({ view: graced });
  expect(html).toContain(refusal + note);
  expect(
    render({
      view: graced,
      timeFormat: signInTimeFormat({ locale: "en-GB", timeZone: "Asia/Tokyo" }),
    }),
  ).toContain("A new sign-in can start after 19:10. Try again then.");
  expect(render({ view: graced, now: NOW + 9 * 60_000 + 29_999 })).toContain(
    note,
  );

  // The note goes away when the period ends; the refusal stays.
  for (const now of [Date.parse("2026-11-06T10:09:30.000Z"), NOW + 3_600_000]) {
    const ended = render({ view: graced, now });
    expect(ended).toContain(refusal);
    expect(ended).not.toContain("A new sign-in can start");
  }

  // No note without the time, or while a sign-in runs.
  const plain = render({
    view: known({
      ...SIGNED_IN,
      replacementPending: true,
      lastOutcome: { code: "replacement_pending" },
    }),
  });
  expect(plain).toContain(refusal);
  expect(plain).not.toContain("A new sign-in can start");
  // Nor once the replacement is no longer pending, for example when it was
  // resolved before that time.
  const resolved = render({
    view: known({
      ...SIGNED_IN,
      replacementPending: false,
      lastOutcome: {
        code: "replacement_pending",
        retryAfter: "2026-11-06T10:09:30.000Z",
      },
    }),
  });
  expect(resolved).toContain(refusal);
  expect(resolved).not.toContain("A new sign-in can start");
  expect(
    render({
      view: known({
        ...SIGNED_IN,
        replacementPending: true,
        signIn: { kind: "starting" },
        lastOutcome: {
          code: "replacement_pending",
          retryAfter: "2026-11-06T10:09:30.000Z",
        },
      }),
    }),
  ).not.toContain("A new sign-in can start");
});

test("logins, names, URLs, and warnings are rendered as text, not as markup, and no style attribute is used", () => {
  const html = render({
    view: {
      kind: "known",
      status: {
        ...SIGNED_IN,
        account: {
          kind: "signed_in",
          login: "octocat",
          displayName: "<b>name</b>",
          deviceId: "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3",
          signInExpiresAt: "2026-12-02T10:00:00.000Z",
        },
        signIn: {
          kind: "waiting",
          pairingCode: "042137",
          opened: false,
          authorizeUrl: 'https://x.example/"><script>x</script>',
          warning: "<img src=x>",
          browser: "default",
        },
      },
    },
  });

  expect(html).not.toMatch(/<(?:b|img|script)[\s>]/);
  expect(html).toContain("&lt;b&gt;name&lt;/b&gt;");
  expect(html).not.toMatch(/\sstyle=/);
});

test("every state of the device has its message, announced at once when the device cannot be used", () => {
  for (const device of DEVICE_STATES) {
    const html = render({
      view: { kind: "known", status: { ...SIGNED_IN, device } },
    });
    const text = DEVICE_STATE_MESSAGES[device];
    if (text === undefined) {
      expect(["no_device", "signed_in", "key_not_loaded"]).toContain(device);
      continue;
    }
    const alert = [
      "auth_failed",
      "account_mismatch",
      "key_lost",
      "unavailable",
      "revoked",
    ].includes(device);
    expect(html, device).toContain(
      `<p class="${alert ? "panel-message" : "account-message"}" role="${alert ? "alert" : "status"}">${text.replaceAll("'", "&#x27;")}</p>`,
    );
  }
  // While a sign-in runs, the panel shows the sign-in instead.
  expect(
    render({
      view: known({ device: "auth_failed", signIn: { kind: "starting" } }),
    }),
  ).not.toContain(DEVICE_STATE_MESSAGES.auth_failed?.replaceAll("'", "&#x27;"));
});

test("each state of the device offers its actions", () => {
  const labels = (status: AccountStatus) =>
    clickEveryButton({ view: { kind: "known", status } }).map(
      ([label]) => label,
    );

  // The account's devices are listed beside the panel, without a button.
  expect(labels(SIGNED_IN)).toEqual([
    "Renew the sign-in",
    "Sign out",
    "Remove this device",
    "This is not me",
  ]);
  for (const device of [
    "signed_out",
    "sign_out_report_pending",
    "sign_in_required",
    "auth_failed",
    "account_mismatch",
    "key_lost",
  ] as const) {
    expect(labels({ ...SIGNED_IN, device }), device).toEqual([
      "Sign in with GitHub",
      "Use another browser",
      "This is not me",
    ]);
  }
  expect(labels({ ...SIGNED_IN, device: "removal_pending" })).toEqual([
    "Remove this device",
    "This is not me",
  ]);
  for (const device of ["removed", "revoked", "no_device"] as const) {
    expect(labels({ ...SIGNED_OUT, device }), device).toEqual([
      "Sign in with GitHub",
      "Use another browser",
    ]);
  }
  for (const device of ["starting", "unavailable"] as const) {
    expect(labels({ ...SIGNED_IN, device }), device).toEqual([
      "This is not me",
    ]);
  }
  // Every action waits while another one runs.
  const busy = render({
    view: { kind: "known", status: SIGNED_IN },
    busy: true,
  });
  for (const label of ["Renew the sign-in", "Sign out", "Remove this device"]) {
    expect(busy).toContain(
      `<button type="button" class="panel-action" disabled="">${label}</button>`,
    );
  }
  expect(busy).not.toContain("Show devices");
  expect(busy).not.toContain("devices-title");
});

type SignedInAccount = Extract<AccountStatus["account"], { kind: "signed_in" }>;

/** The signed-in status whose sign-in ends at `endsAt`. */
function endingAt(endsAt: number, base: AccountStatus = SIGNED_IN) {
  return {
    ...base,
    account: {
      ...(base.account as SignedInAccount),
      signInExpiresAt: new Date(endsAt).toISOString(),
    },
  } satisfies AccountStatus;
}

test("before day 25 of the sign-in, the end shows and the renewal is offered without a prompt (D4)", () => {
  for (const left of [29 * DAY_MS, 7 * DAY_MS, 6 * DAY_MS + 1]) {
    const view = { kind: "known", status: endingAt(NOW + left) } as const;
    const html = render({ view });

    expect(html, String(left)).toContain("<dt>Signed in until</dt>");
    expect(html, String(left)).toContain(
      '<div class="account-actions"><button type="button" class="panel-action">Renew the sign-in</button><button type="button" class="panel-action">Sign out</button>',
    );
    expect(html, String(left)).not.toContain("sign-in-renewal");
    expect(html, String(left)).not.toContain("Renew it");
    expect(clickEveryButton({ view })[0]).toEqual([
      "Renew the sign-in",
      ["onStartSignIn"],
    ]);
  }
});

test("from day 25, 6 days before the end, a fixed sentence asks to renew the sign-in and describes its button; after the end it says that the sign-in ended (D4)", () => {
  for (const [left, sentence] of [
    [6 * DAY_MS, SIGN_IN_RENEWAL_MESSAGES.due],
    [5 * DAY_MS, SIGN_IN_RENEWAL_MESSAGES.due],
    [DAY_MS, SIGN_IN_RENEWAL_MESSAGES.due],
    [1, SIGN_IN_RENEWAL_MESSAGES.due],
    [0, SIGN_IN_RENEWAL_MESSAGES.ended],
    [-DAY_MS, SIGN_IN_RENEWAL_MESSAGES.ended],
  ] as const) {
    const view = { kind: "known", status: endingAt(NOW + left) } as const;

    expect(render({ view }), String(left)).toContain(
      `<p class="account-warning" id="sign-in-renewal">${sentence}</p><div class="account-actions"><button type="button" class="panel-action" aria-describedby="sign-in-renewal">Renew the sign-in</button>`,
    );
    expect(clickEveryButton({ view })[0]).toEqual([
      "Renew the sign-in",
      ["onStartSignIn"],
    ]);
    expect(render({ view, busy: true })).toContain(
      '<button type="button" class="panel-action" disabled="" aria-describedby="sign-in-renewal">Renew the sign-in</button>',
    );
  }
  // The date and the time in the person's locale and time zone: an end at
  // 23:30 UTC is the next day in Istanbul.
  expect(
    render({
      view: {
        kind: "known",
        status: endingAt(Date.parse("2026-12-09T23:30:00.000Z")),
      },
      endFormat: signInEndFormat({
        locale: "en-GB",
        timeZone: "Europe/Istanbul",
      }),
    }),
  ).toContain(
    '<dt>Signed in until</dt><dd><time dateTime="2026-12-09T23:30:00.000Z">10 December 2026 at 02:30</time></dd>',
  );
});

test("the end of the sign-in and its renewal show only while the device is signed in; once the server asks for a sign-in, the panel offers Sign in with GitHub instead (D4)", () => {
  const due = endingAt(NOW + 2 * DAY_MS);
  for (const device of [
    "starting",
    "signed_out",
    "sign_out_report_pending",
    "sign_in_required",
    "auth_failed",
    "account_mismatch",
    "key_lost",
    "key_not_loaded",
    "unavailable",
    "removal_pending",
  ] as const) {
    const html = render({
      view: { kind: "known", status: { ...due, device } },
    });
    expect(html, device).not.toContain("Signed in until");
    expect(html, device).not.toContain("Renew");
    expect(html, device).not.toContain("sign-in-renewal");
  }
  // After the end, the server refuses the device with sign_in_required: the
  // panel says so and offers a GitHub sign-in.
  const required = render({
    view: {
      kind: "known",
      status: { ...endingAt(NOW - DAY_MS), device: "sign_in_required" },
    },
  });
  expect(required).toContain(DEVICE_STATE_MESSAGES.sign_in_required);
  expect(required).toContain(">Sign in with GitHub</button>");
  // While a sign-in runs, a renewal too, the panel shows its progress and
  // no prompt; without a usable key or server address no renewal is
  // offered.
  for (const status of [
    { ...due, signIn: { kind: "starting" } },
    { ...due, signIn: { kind: "completing" } },
    {
      ...due,
      signIn: { kind: "waiting", pairingCode: "042137", opened: true },
    },
    { ...due, deviceKey: "corrupt" },
    { ...due, apiOrigin: "unset" },
    { ...due, apiOrigin: "invalid" },
  ] satisfies AccountStatus[]) {
    const html = render({ view: { kind: "known", status } });
    expect(html, JSON.stringify(status)).not.toContain("Renew");
    expect(html, JSON.stringify(status)).not.toContain("sign-in-renewal");
  }
  // A hidden account names no end (#195).
  expect(
    render({
      view: {
        kind: "known",
        status: { ...due, account: { kind: "hidden" }, device: "signed_out" },
      },
    }),
  ).not.toContain("Signed in until");
});

test("after a renewal that the API refused for another GitHub account, the device stays signed in, and the panel asks to sign in with the installation's account, never to remove the device (D4)", () => {
  const view = {
    kind: "known",
    status: {
      ...endingAt(NOW + 2 * DAY_MS),
      lastOutcome: { code: "device_account_mismatch", deviceLogin: "octocat" },
    },
  } as const;
  const html = render({ view });

  expect(html).toContain(
    '<p class="panel-message" role="alert">This installation belongs to the GitHub account octocat. Sign in with that account.</p>',
  );
  expect(html).not.toContain(DEVICE_STATE_MESSAGES.account_mismatch);
  expect(html).not.toMatch(/remove this device so that/i);
  expect(html).toContain("<dt>Signed in until</dt>");
  expect(clickEveryButton({ view }).map(([label]) => label)).toEqual([
    "Renew the sign-in",
    "Sign out",
    "Remove this device",
    "This is not me",
  ]);
});
