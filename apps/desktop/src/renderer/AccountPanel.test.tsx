import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";
import {
  type AccountStatus,
  SIGN_IN_OUTCOME_CODES,
} from "../shared/ipc-contract.ts";
import {
  AccountPanelContent,
  type AccountPanelContentProps,
} from "./AccountPanel.tsx";
import {
  DEVICE_KEY_PROBLEM_MESSAGES,
  SIGN_IN_OUTCOME_MESSAGES,
} from "./account-view.ts";

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
};

const SIGNED_IN: AccountStatus = {
  ...SIGNED_OUT,
  account: {
    kind: "signed_in",
    login: "octocat",
    displayName: "The Octocat",
    deviceId: "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3",
  },
};

type Handler = keyof Pick<
  AccountPanelContentProps,
  | "onStartSignIn"
  | "onCancelSignIn"
  | "onUnlock"
  | "onForget"
  | "onConfirmForget"
  | "onKeepAccount"
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
    confirmingForget: false,
    onStartSignIn: record("onStartSignIn"),
    onCancelSignIn: record("onCancelSignIn"),
    onUnlock: record("onUnlock"),
    onForget: record("onForget"),
    onConfirmForget: record("onConfirmForget"),
    onKeepAccount: record("onKeepAccount"),
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
    '<section class="account-panel" aria-labelledby="account-title"><h3 id="account-title">Account</h3><p>Sign-in is not available.</p></section>',
  );
  expect(render({ view: { kind: "pending" } })).toContain(
    "<p>Checking the sign-in.</p>",
  );
  const loading = render({ view: known({ deviceKey: "loading" }) });
  expect(loading).toContain('<p role="status">Reading the device key.</p>');
  expect(loading).not.toContain("<button");
});

test("signed out, the panel offers to sign in with GitHub", () => {
  const html = render();

  expect(html).toContain("<p>Not signed in.</p>");
  expect(html).toContain(
    '<div class="account-actions"><button type="button" class="panel-action">Sign in with GitHub</button></div>',
  );
  expect(html).not.toContain('role="alert"');
  expect(clickEveryButton({})).toEqual([
    ["Sign in with GitHub", ["onStartSignIn"]],
  ]);
});

test("the sign-in button is disabled while busy, while the key is not ready, and without a server address", () => {
  expect(render({ busy: true })).toContain(
    '<button type="button" class="panel-action" disabled="">Sign in with GitHub</button>',
  );
  expect(render({ view: known({ deviceKey: "corrupt" }) })).toContain(
    '<button type="button" class="panel-action" disabled="">Sign in with GitHub</button>',
  );
  for (const [apiOrigin, code] of [
    ["unset", "api_origin_unset"],
    ["invalid", "api_origin_invalid"],
  ] as const) {
    const html = render({ view: known({ apiOrigin }) });
    expect(html).toContain(
      '<button type="button" class="panel-action" disabled="" aria-describedby="sign-in-unavailable">Sign in with GitHub</button>',
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
  expect(clickEveryButton({ view })).toEqual([["Cancel", ["onCancelSignIn"]]]);
});

test("when the browser did not open, the URL is in a read-only field with the warning and a button that selects it", () => {
  const view = known({
    signIn: {
      kind: "waiting",
      pairingCode: "042137",
      opened: false,
      authorizeUrl: AUTHORIZE_URL,
      warning: WARNING,
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
  expect(html).toContain(
    '<button type="button" class="panel-action">Cancel</button>',
  );
});

test("signed in, the panel shows the login and the name with This is not me", () => {
  const html = render({ view: { kind: "known", status: SIGNED_IN } });

  expect(html).toContain(
    '<dl class="account-facts"><dt>GitHub login</dt><dd>octocat</dd><dt>Name</dt><dd>The Octocat</dd></dl>',
  );
  expect(html).not.toContain("0192f2a0");
  expect(html).not.toContain("Sign in with GitHub");
  expect(
    clickEveryButton({ view: { kind: "known", status: SIGNED_IN } }),
  ).toEqual([["This is not me", ["onForget"]]]);
});

test("This is not me asks for confirmation before anything is removed, with Keep focused", () => {
  const overrides = {
    view: { kind: "known", status: SIGNED_IN },
    confirmingForget: true,
  } as const;
  const html = render(overrides);

  expect(html).toContain(
    '<p id="forget-question">Remove the GitHub account <strong>octocat</strong> and the device key from this installation? You can then sign in with your own account.</p><div class="account-actions" role="group" aria-labelledby="forget-question"><button type="button" class="panel-action">Remove from this installation</button><button type="button" class="panel-action" autofocus="">Keep</button></div>',
  );
  expect(html).not.toContain(">This is not me</button>");
  expect(clickEveryButton(overrides)).toEqual([
    ["Remove from this installation", ["onConfirmForget"]],
    ["Keep", ["onKeepAccount"]],
  ]);
  expect(render({ ...overrides, busy: true })).toContain(
    '<button type="button" class="panel-action" disabled="">Remove from this installation</button>',
  );
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
  const signedIn = render({
    view: {
      kind: "known",
      status: { ...SIGNED_IN, deviceKey: "passphrase_required" },
    },
  });
  expect(signedIn).toContain('type="password"');
  expect(signedIn).toContain(">This is not me</button>");
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
        },
        signIn: {
          kind: "waiting",
          pairingCode: "042137",
          opened: false,
          authorizeUrl: 'https://x.example/"><script>x</script>',
          warning: "<img src=x>",
        },
      },
    },
  });

  expect(html).not.toMatch(/<(?:b|img|script)[\s>]/);
  expect(html).toContain("&lt;b&gt;name&lt;/b&gt;");
  expect(html).not.toMatch(/\sstyle=/);
});
