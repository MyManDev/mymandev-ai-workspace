// The AI provider section of the Account screen (#32). The components
// below the section use no hooks except the dialog's box and the section
// itself, so the tests render the markup and also call the components as
// functions, walk the returned elements, and invoke their event handlers.
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";
import type { ProviderConnectionListView } from "../shared/ipc-contract.ts";
import { AccountScreen } from "./AccountScreen.tsx";
import { deviceTimeFormat } from "./device-view.ts";
import {
  PROVIDER_CONNECTION_MESSAGE_ID,
  PROVIDER_CONNECTIONS_TITLE_ID,
  PROVIDER_KEY_INPUT_ID,
  ProviderConnectionQuestionContent,
  ProviderConnectionsContent,
  ProviderConnectionsSection,
  providerConnectionHandlers,
  REMOVE_KEY_QUESTION_MESSAGES,
  REMOVE_QUESTION_MESSAGES,
  type ProviderConnectionHandlers,
} from "./ProviderConnectionsSection.tsx";
import {
  describeProviderConnections,
  IDLE_PROVIDER_CONNECTION_ACTIONS,
  PROVIDER_CONNECTION_MESSAGES,
  PROVIDER_CONNECTION_STATUS_TEXTS,
  type ProviderConnectionActions,
  type ProviderConnectionActionsView,
  type ProviderConnectionRow,
  type ProviderConnectionSectionView,
} from "./provider-connection-view.ts";

const ID_1 = "0192f0a0-7b3c-7d4e-8f50-000000000101";
const ID_2 = "0192f0a0-7b3c-7d4e-8f50-000000000102";
const AT = "2026-11-24T09:00:00.000Z";
const UTC_TIME = deviceTimeFormat({ locale: "en-GB", timeZone: "UTC" });

/** A label that a person typed as markup, and that must stay text. */
const MARKUP_LABEL = "<b>Work</b> account";

const READY: ProviderConnectionListView = {
  revision: 3,
  status: "ready",
  connections: [
    {
      id: ID_1,
      kind: "claude",
      label: MARKUP_LABEL,
      createdAt: AT,
      status: "credential_missing",
    },
    {
      id: ID_2,
      kind: "codex",
      label: "Home",
      createdAt: AT,
      status: "unknown",
    },
  ],
};

function known(
  state: ProviderConnectionListView = READY,
): ProviderConnectionSectionView {
  return { kind: "known", state };
}

interface HostProps {
  readonly children?: ReactNode;
  readonly id?: string;
  readonly type?: string;
  readonly value?: string;
  readonly role?: string;
  readonly htmlFor?: string;
  readonly "aria-describedby"?: string;
  readonly "aria-disabled"?: string;
  readonly "aria-labelledby"?: string;
  readonly onClick?: (event: { readonly currentTarget: unknown }) => void;
  readonly onSubmit?: (event: { readonly preventDefault: () => void }) => void;
  readonly onChange?: (event: {
    readonly currentTarget: { readonly value: string };
  }) => void;
  readonly onCancel?: (event: { readonly preventDefault: () => void }) => void;
  readonly onClose?: () => void;
}

/**
 * The element and every element below it. A component without hooks is
 * called to reach its elements; one with hooks stays a leaf.
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

/** A text as `renderToString` escapes it. */
function htmlText(text: string): string {
  return text.replaceAll("'", "&#x27;");
}

function recorder() {
  const calls: string[] = [];
  const handlers: ProviderConnectionHandlers = {
    onKind: (kind) => calls.push(`kind ${kind}`),
    onLabel: (text) => calls.push(`label ${text}`),
    onRegister: () => calls.push("register"),
    onRemove: (row: ProviderConnectionRow) => calls.push(`remove ${row.id}`),
    onAskKey: (row: ProviderConnectionRow) => calls.push(`askKey ${row.id}`),
    onKey: (text) => calls.push(`key ${text}`),
    onSaveKey: () => calls.push("saveKey"),
    onCancelKey: () => calls.push("cancelKey"),
    onRemoveKey: (row: ProviderConnectionRow) =>
      calls.push(`removeKey ${row.id}`),
    onConfirm: () => calls.push("confirm"),
    onCancel: () => calls.push("cancel"),
  };
  return { calls, handlers };
}

function content(
  view: ProviderConnectionSectionView,
  actions: ProviderConnectionActionsView = IDLE_PROVIDER_CONNECTION_ACTIONS,
  handlers: ProviderConnectionHandlers | undefined = recorder().handlers,
) {
  return (
    <ProviderConnectionsContent
      model={describeProviderConnections(view)}
      actions={actions}
      handlers={handlers}
      timeFormat={UTC_TIME}
    />
  );
}

test("the section lists each connection's label as text, its provider, when it was added, and its status, and shows no key field until one is asked for", () => {
  const html = renderToString(content(known()));
  expect(html).toContain(
    `<h3 id="${PROVIDER_CONNECTIONS_TITLE_ID}" tabindex="-1">AI providers</h3>`,
  );
  expect(html).toContain(
    `<ul class="device-list" aria-labelledby="${PROVIDER_CONNECTIONS_TITLE_ID}">`,
  );
  // The label stays text, takes its direction from its content, and is
  // never translated.
  expect(html).toContain(
    '<span class="device-label" id="provider-connection-label-0" dir="auto" translate="no">&lt;b&gt;Work&lt;/b&gt; account</span>',
  );
  expect(html).not.toContain("<b>Work</b>");
  expect(html).toContain('<span class="device-mark">Claude</span>');
  expect(html).toContain('<span class="device-mark">Codex</span>');
  expect(html).toContain(`<time dateTime="${AT}">24 Nov 2026, 09:00</time>`);
  expect(html).toContain(
    `No API key<!-- -->. <!-- -->${htmlText(PROVIDER_CONNECTION_STATUS_TEXTS.credential_missing.text)}`,
  );
  expect(html).toContain(
    `Unknown<!-- -->. <!-- -->${htmlText(PROVIDER_CONNECTION_STATUS_TEXTS.unknown.text)}`,
  );
  // Each button is described by its connection's label. A connection
  // without a key offers to enter one; one whose key is unknown also offers
  // to remove it.
  expect(html).toContain(
    '<button type="button" class="panel-action" aria-describedby="provider-connection-label-0">Enter an API key</button><button type="button" class="panel-action" aria-describedby="provider-connection-label-0">Remove</button>',
  );
  expect(html).toContain(
    '<button type="button" class="panel-action" aria-describedby="provider-connection-label-1">Enter an API key</button><button type="button" class="panel-action" aria-describedby="provider-connection-label-1">Remove the API key</button>',
  );
  expect(html).toContain(
    '<button type="button" class="panel-action" aria-describedby="provider-connection-label-0">Remove</button>',
  );
  expect(html).toContain(
    '<button type="button" class="panel-action" aria-describedby="provider-connection-label-1">Remove</button>',
  );
  // The form: a provider and a label, both labelled, and nothing else.
  expect(html).toContain(
    '<label class="account-label" for="provider-connection-kind">Provider</label>',
  );
  expect(html).toContain(
    '<option value="claude" selected="">Claude</option><option value="codex">Codex</option>',
  );
  expect(html).toContain(
    '<label class="account-label" for="provider-connection-label">Label</label>',
  );
  expect(html).toContain(
    'aria-describedby="provider-connection-label-hint provider-connection-label-problem"',
  );
  expect(html.match(/<input /gu)).toHaveLength(1);
  expect(html).not.toContain('type="password"');
  expect(html).not.toContain("<textarea");
  expect(html.match(/<select /gu)).toHaveLength(1);
  expect(html).toContain(htmlText(PROVIDER_CONNECTION_MESSAGES.hint));
  // Both status paragraphs are always rendered.
  expect(html).toContain(
    `<p class="account-message" id="${PROVIDER_CONNECTION_MESSAGE_ID}" role="status"></p>`,
  );
});

test("each state has its own status sentence, and the form shows only while a device is signed in", () => {
  const cases: [ProviderConnectionSectionView, string, boolean][] = [
    [{ kind: "unavailable" }, PROVIDER_CONNECTION_MESSAGES.unavailable, false],
    [{ kind: "pending" }, PROVIDER_CONNECTION_MESSAGES.pending, false],
    [
      known({ revision: 1, status: "signed_out", connections: [] }),
      PROVIDER_CONNECTION_MESSAGES.signedOut,
      false,
    ],
    [
      known({ revision: 1, status: "loading", connections: [] }),
      PROVIDER_CONNECTION_MESSAGES.loading,
      true,
    ],
    [
      known({ revision: 1, status: "ready", connections: [] }),
      PROVIDER_CONNECTION_MESSAGES.empty,
      true,
    ],
    [
      known({
        revision: 1,
        status: "unavailable",
        problem: "rate_limited",
        connections: [],
      }),
      "The server asked to wait.",
      true,
    ],
  ];
  for (const [view, status, form] of cases) {
    const html = renderToString(content(view));
    expect(html, status).toContain(status);
    expect(html.includes("<form"), status).toBe(form);
    expect(html.includes("<ul"), status).toBe(false);
  }
  // Without the bridge, nothing is offered.
  const bare = renderToString(
    <ProviderConnectionsContent
      model={describeProviderConnections(known())}
      actions={IDLE_PROVIDER_CONNECTION_ACTIONS}
      handlers={undefined}
      timeFormat={UTC_TIME}
    />,
  );
  expect(bare).not.toContain("<form");
  expect(bare).not.toContain("<button");
  expect(bare).not.toContain(PROVIDER_CONNECTION_MESSAGE_ID);
});

test("while an action runs, the buttons do nothing and the fields are read-only; a label problem shows in the alert", () => {
  const { calls, handlers } = recorder();
  const running: ProviderConnectionActionsView = {
    ...IDLE_PROVIDER_CONNECTION_ACTIONS,
    running: true,
    draftLabel: "Work",
  };
  const html = renderToString(content(known(), running, handlers));
  // Enter (2), Remove the API key (1), Remove (2), and the submit.
  expect(html.match(/aria-disabled="true"/gu)).toHaveLength(6);
  expect(html).toContain('readOnly=""');
  expect(html).toContain('<select id="provider-connection-kind"');
  expect(html).toMatch(/<select [^>]*disabled=""/u);
  const elements = elementsOf(content(known(), running, handlers));
  for (const element of elements) {
    if (element.type === "button") {
      element.props.onClick?.({ currentTarget: null });
    }
    element.props.onSubmit?.({ preventDefault: () => undefined });
  }
  expect(calls).toEqual([]);
  const problem = renderToString(
    content(known(), {
      ...IDLE_PROVIDER_CONNECTION_ACTIONS,
      draftLabel: "a",
      labelProblem: PROVIDER_CONNECTION_MESSAGES.labelUnsafe,
      message: "The connection was not added.",
    }),
  );
  expect(problem).toContain('aria-invalid="true"');
  expect(problem).toContain(
    `<p class="panel-message" id="provider-connection-label-problem" role="alert">${PROVIDER_CONNECTION_MESSAGES.labelUnsafe}</p>`,
  );
  expect(problem).toContain(
    `id="${PROVIDER_CONNECTION_MESSAGE_ID}" role="status">The connection was not added.</p>`,
  );
});

test("the controls pass the person's input on: the kind, the label, a submit, and a removal of the row", () => {
  const { calls, handlers } = recorder();
  const elements = elementsOf(content(known(), undefined, handlers));
  const select = elements.find((element) => element.type === "select");
  select?.props.onChange?.({ currentTarget: { value: "codex" } });
  const input = elements.find((element) => element.type === "input");
  input?.props.onChange?.({ currentTarget: { value: " Home " } });
  let prevented = false;
  elements
    .find((element) => element.type === "form")
    ?.props.onSubmit?.({
      preventDefault: () => {
        prevented = true;
      },
    });
  for (const element of elements) {
    if (element.type === "button") {
      element.props.onClick?.({ currentTarget: null });
    }
  }
  expect(prevented).toBe(true);
  expect(calls).toEqual([
    "kind codex",
    "label  Home ",
    "register",
    `askKey ${ID_1}`,
    `remove ${ID_1}`,
    `askKey ${ID_2}`,
    `removeKey ${ID_2}`,
    `remove ${ID_2}`,
  ]);
});

test("the question names the connection as text, puts Cancel first, and confirms, cancels, or closes", () => {
  const { calls, handlers } = recorder();
  const closed = renderToString(
    <ProviderConnectionQuestionContent
      question={undefined}
      onConfirm={handlers.onConfirm}
      onCancel={handlers.onCancel}
    />,
  );
  expect(closed).toBe('<dialog class="people-dialog"></dialog>');
  const question = (
    <ProviderConnectionQuestionContent
      question={{
        id: ID_1,
        label: MARKUP_LABEL,
        kindName: "Claude",
        action: "remove",
      }}
      onConfirm={handlers.onConfirm}
      onCancel={handlers.onCancel}
    />
  );
  const html = renderToString(question);
  expect(html).toContain(
    'aria-labelledby="provider-connection-dialog-title" aria-describedby="provider-connection-dialog-name provider-connection-dialog-text"',
  );
  expect(html).toContain(REMOVE_QUESTION_MESSAGES.title);
  expect(html).toContain(
    '<span dir="auto" translate="no">&lt;b&gt;Work&lt;/b&gt; account</span>',
  );
  expect(html).toContain("(<!-- -->Claude<!-- -->)");
  expect(html.indexOf(">Cancel<")).toBeLessThan(
    html.indexOf(`>${REMOVE_QUESTION_MESSAGES.confirm}<`),
  );
  expect(html).not.toContain(ID_1);
  const elements = elementsOf(question);
  const dialog = elements.find((element) => element.type === "dialog");
  let prevented = false;
  dialog?.props.onCancel?.({
    preventDefault: () => {
      prevented = true;
    },
  });
  dialog?.props.onClose?.();
  elements
    .find((element) => element.type === "form")
    ?.props.onSubmit?.({ preventDefault: () => undefined });
  elements
    .find(
      (element) => element.type === "button" && textOf(element) === "Cancel",
    )
    ?.props.onClick?.({ currentTarget: null });
  expect(prevented).toBe(true);
  expect(calls).toEqual(["cancel", "cancel", "confirm", "cancel"]);
});

test("a confirmed removal moves the focus to the title only once the connection was removed", async () => {
  const focused: string[] = [];
  let removed = true;
  const controller: ProviderConnectionActions = {
    editKind: () => undefined,
    editLabel: () => undefined,
    register: () => Promise.resolve(),
    askRemove: () => undefined,
    askKey: () => undefined,
    editKey: () => undefined,
    saveKey: () => Promise.resolve(),
    cancelKey: () => undefined,
    askRemoveKey: () => undefined,
    confirm: () => Promise.resolve(removed),
    cancel: () => undefined,
    follow: () => undefined,
  };
  const handlers = providerConnectionHandlers(controller, () =>
    focused.push("title"),
  );
  handlers.onConfirm();
  await Promise.resolve();
  await Promise.resolve();
  removed = false;
  handlers.onConfirm();
  await Promise.resolve();
  await Promise.resolve();
  expect(focused).toEqual(["title"]);
});

test("the Account screen shows the section after the devices, also without the bridge", () => {
  const html = renderToString(<AccountScreen />);
  expect(html).toContain(
    `<h3 id="${PROVIDER_CONNECTIONS_TITLE_ID}" tabindex="-1">AI providers</h3>`,
  );
  expect(html.indexOf("Devices")).toBeLessThan(html.indexOf("AI providers"));
  expect(html).toContain(PROVIDER_CONNECTION_MESSAGES.unavailable);
  // With a bridge, the section waits for the first state, and offers the
  // question's dialog closed.
  const withBridge = renderToString(
    <ProviderConnectionsSection
      providerConnections={{
        getState: () => new Promise(() => undefined),
        subscribeState: () => () => undefined,
        register: () => new Promise(() => undefined),
        remove: () => new Promise(() => undefined),
        saveKey: () => new Promise(() => undefined),
        removeKey: () => new Promise(() => undefined),
      }}
    />,
  );
  expect(withBridge).toContain(PROVIDER_CONNECTION_MESSAGES.pending);
  expect(withBridge).toContain('<dialog class="people-dialog"></dialog>');
});

/** An obvious fake key that the markup may hold only while it is typed. */
const SENTINEL_KEY = "FAKE-PROVIDER-KEY-SENTINEL-0123456789";

test("the key form is one password field, never prefilled, under its connection, with its hint and alert", () => {
  const { calls, handlers } = recorder();
  const open: ProviderConnectionActionsView = {
    ...IDLE_PROVIDER_CONNECTION_ACTIONS,
    keyFor: { id: ID_1, label: MARKUP_LABEL, kindName: "Claude" },
  };
  const html = renderToString(content(known(), open, handlers));
  expect(html.match(/type="password"/gu)).toHaveLength(1);
  expect(html).toContain(
    `<label class="account-label" for="${PROVIDER_KEY_INPUT_ID}">API key</label>`,
  );
  // The field opens empty and never offers a stored key.
  expect(html).toMatch(
    new RegExp(
      `<input id="${PROVIDER_KEY_INPUT_ID}" class="account-input" type="password" autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck="false" aria-describedby="provider-key-hint provider-key-problem" value=""/>`,
      "u",
    ),
  );
  expect(html).toContain(
    'aria-describedby="provider-key-hint provider-key-problem"',
  );
  expect(html).toContain(htmlText(PROVIDER_CONNECTION_MESSAGES.keyHint));
  // The label of the connection stays text in the form's title.
  expect(html).toContain(
    '<span dir="auto" translate="no">&lt;b&gt;Work&lt;/b&gt; account</span>',
  );
  // Its "Enter an API key" button gives way to the form; the other row
  // keeps its own.
  expect(html).not.toContain(
    'aria-describedby="provider-connection-label-0">Enter an API key</button>',
  );
  expect(html).toContain(
    'aria-describedby="provider-connection-label-1">Enter an API key</button>',
  );
  const elements = elementsOf(content(known(), open, handlers));
  const input = elements.find(
    (element) =>
      element.type === "input" && element.props.id === PROVIDER_KEY_INPUT_ID,
  );
  input?.props.onChange?.({ currentTarget: { value: SENTINEL_KEY } });
  const form = elements.find(
    (element) =>
      element.type === "form" &&
      element.props["aria-labelledby"] === "provider-key-title",
  );
  form?.props.onSubmit?.({ preventDefault: () => undefined });
  elements
    .find(
      (element) =>
        element.type === "button" &&
        textOf(element) === PROVIDER_CONNECTION_MESSAGES.cancel,
    )
    ?.props.onClick?.({ currentTarget: null });
  expect(calls).toEqual([`key ${SENTINEL_KEY}`, "saveKey", "cancelKey"]);

  // A typed key is in the field only; once sent, the field is empty again.
  const typed = renderToString(
    content(known(), { ...open, draftKey: SENTINEL_KEY }, handlers),
  );
  expect(typed.match(new RegExp(SENTINEL_KEY, "gu"))).toHaveLength(1);
  const sent = renderToString(
    content(
      known(),
      {
        ...open,
        draftKey: "",
        keyProblem: PROVIDER_CONNECTION_MESSAGES.keyUnsafe,
      },
      handlers,
    ),
  );
  expect(sent).not.toContain(SENTINEL_KEY);
  expect(sent).toContain('aria-invalid="true"');
  expect(sent).toContain(
    `<p class="panel-message" id="provider-key-problem" role="alert">${PROVIDER_CONNECTION_MESSAGES.keyUnsafe}</p>`,
  );
  // While an action runs the field is read-only and its buttons do nothing.
  const running = renderToString(
    content(known(), { ...open, running: true }, handlers),
  );
  expect(running).toMatch(
    new RegExp(`<input id="${PROVIDER_KEY_INPUT_ID}"[^>]*readOnly=""`, "u"),
  );
});

test("a ready connection offers to replace and remove its key, and the key question has its own texts", () => {
  const ready = known({
    revision: 4,
    status: "ready",
    connections: [
      {
        id: ID_1,
        kind: "claude",
        label: "Work",
        createdAt: AT,
        status: "ready",
      },
    ],
  });
  const html = renderToString(content(ready));
  expect(html).toContain(
    `Ready<!-- -->. <!-- -->${htmlText(PROVIDER_CONNECTION_STATUS_TEXTS.ready.text)}`,
  );
  expect(html).toContain(">Replace the API key</button>");
  expect(html).toContain(">Remove the API key</button>");
  expect(html).not.toContain(">Enter an API key</button>");
  expect(html).not.toContain('type="password"');

  const question = renderToString(
    <ProviderConnectionQuestionContent
      question={{
        id: ID_1,
        label: "Work",
        kindName: "Claude",
        action: "removeKey",
      }}
      onConfirm={() => undefined}
      onCancel={() => undefined}
    />,
  );
  expect(question).toContain(htmlText(REMOVE_KEY_QUESTION_MESSAGES.title));
  expect(question).toContain(htmlText(REMOVE_KEY_QUESTION_MESSAGES.text));
  expect(question).toContain(`>${REMOVE_KEY_QUESTION_MESSAGES.confirm}<`);
  expect(question).not.toContain(REMOVE_QUESTION_MESSAGES.title);
});
