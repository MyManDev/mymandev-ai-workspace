// The join screen's invitation code. The components below the screen use no
// hooks except the question's box, so the tests render the markup and also
// call the components as functions, walk the returned elements, and invoke
// their event handlers.
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";
import type { WorkspaceView } from "../shared/ipc-contract.ts";
import { deviceTimeFormat } from "./device-view.ts";
import {
  IDLE_JOIN_INVITATION,
  type InvitationPreview,
  type JoinInvitationView,
} from "./join-invitation-view.ts";
import {
  JoinQuestionContent,
  JoinScreenContent,
  type JoinInvitationHandlers,
} from "./JoinScreen.tsx";
import { peopleDateFormat } from "./people-view.ts";
import type { WorkspacePanelView } from "./workspace-view.ts";

const CODE = `mmdi_${"J01nW1thC0de-_".repeat(4).slice(0, 42)}g`;
const WORKSPACE_A = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3";
const JOINED = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a5";

const PREVIEW: InvitationPreview = {
  workspaceName: "Team",
  displayName: "Margaret",
  inviterName: "Ada",
  inviterLogin: "octocat",
  inviterVerifiedAt: "2026-11-06T22:30:00.000Z",
  expiresAt: "2026-11-12T12:00:00.000Z",
};

function known(overrides: Partial<WorkspaceView> = {}): WorkspacePanelView {
  return {
    kind: "known",
    state: {
      revision: 1,
      status: "ready",
      workspaces: [{ id: WORKSPACE_A, name: "Workspace A" }],
      selectedWorkspaceId: WORKSPACE_A,
      projects: [],
      openProjectId: null,
      ...overrides,
    } as WorkspaceView,
  };
}

/** A fixed locale and a time zone that is not UTC, whatever the machine's. */
const ISTANBUL = { locale: "en-GB", timeZone: "Europe/Istanbul" };

interface HostProps {
  readonly children?: ReactNode;
  readonly id?: string;
  readonly type?: string;
  readonly readOnly?: boolean;
  readonly "aria-disabled"?: string;
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

/** Handlers that record each call as text. */
function recorder() {
  const calls: string[] = [];
  const handlers: JoinInvitationHandlers = {
    onCode: (text) => calls.push(`code ${text}`),
    onPreview: () => calls.push("preview"),
    onAsk: () => calls.push("ask"),
    onConfirm: () => calls.push("confirm"),
    onBack: () => calls.push("back"),
    onCancel: (button) => calls.push(`cancel ${String(button)}`),
    onOpen: (workspaceId) => calls.push(`open ${workspaceId}`),
  };
  return { calls, handlers };
}

interface Props {
  readonly workspaces?: WorkspacePanelView;
  readonly view?: Partial<JoinInvitationView>;
  readonly handlers?: JoinInvitationHandlers | undefined;
}

function screen({
  workspaces = known(),
  view = {},
  handlers = recorder().handlers,
}: Props) {
  return (
    <JoinScreenContent
      workspaces={workspaces}
      view={{ ...IDLE_JOIN_INVITATION, ...view }}
      handlers={handlers}
      dateFormat={peopleDateFormat(ISTANBUL)}
      timeFormat={deviceTimeFormat(ISTANBUL)}
    />
  );
}

function render(props: Props = {}): string {
  return renderToString(screen(props));
}

function elements(props: Props): ReactElement<HostProps>[] {
  return elementsOf(screen(props));
}

function buttonLabels(html: string): string[] {
  const outside = html.replace(/<dialog[\s\S]*?<\/dialog>/g, "");
  return [...outside.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map(
    ([, label]) => label ?? "",
  );
}

function attributeValues(html: string, name: string): string[] {
  return [...html.matchAll(new RegExp(`\\s${name}="([^"]*)"`, "g"))].map(
    ([, value]) => value ?? "",
  );
}

const TITLE =
  '<section aria-labelledby="join-title"><h2 id="join-title" tabindex="-1">Join a workspace</h2><section aria-labelledby="join-code-title"><h3 class="people-heading" id="join-code-title">Join with an invitation code</h3>';
const HINT =
  '<p id="join-code-hint">If a workspace already added you as a person, its owner or an admin can give you an invitation code for that person. Paste the code here: you see the workspace and the person before you join. The application takes a code only when you paste it here, never from a link.</p>';
const LATER =
  '<p class="placeholder-note">Asking to join a workspace by its ID, and your own join requests with a way to withdraw them, will be added here.</p>';

test("without the bridge, the screen says that joining is not available, with no form, status, or dialog", () => {
  const html = renderToString(<JoinScreenContent workspaces={known()} />);
  expect(html).toBe(
    `${TITLE}<p>Joining with an invitation code is not available.</p></section>${LATER}</section>`,
  );
});

test("while no device is signed in and ready, the screen says so instead of the form, and keeps its status paragraph", () => {
  const html = render({
    workspaces: known({
      status: "signed_out",
      workspaces: [],
      selectedWorkspaceId: null,
    }),
  });
  expect(html).toBe(
    `${TITLE}${HINT}<p>You can join a workspace once this device is signed in and ready.</p><p class="people-status" id="join-message" role="status"></p></section>${LATER}<dialog class="people-dialog"></dialog></section>`,
  );
});

test("the form is a labelled code field without spelling, completion, or translation, its own alert, and Preview", () => {
  const html = render({ view: { code: CODE } });
  expect(html).toContain(
    `${TITLE}${HINT}<form class="account-form" aria-labelledby="join-code-title"><label class="account-label" for="join-code">Invitation code</label><input id="join-code" class="account-input" type="text" autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck="false" translate="no" aria-describedby="join-code-hint join-code-problem" value="${CODE}"/><p class="panel-message" id="join-code-problem" role="alert"></p><div class="account-actions"><button type="submit" class="panel-action">Preview</button><button type="button" class="panel-action">Cancel</button></div></form><p class="people-status" id="join-message" role="status"></p></section>${LATER}`,
  );
  // Cancel shows only while there is something to drop.
  expect(buttonLabels(render())).toEqual(["Preview"]);
  expect(
    buttonLabels(render({ view: { problem: "Paste an invitation code." } })),
  ).toEqual(["Preview", "Cancel"]);
  expect(
    buttonLabels(render({ view: { message: "You joined the workspace." } })),
  ).toEqual(["Preview"]);
});

test("the field sends its text, the form previews, and Cancel drops the code with its button", () => {
  const { calls, handlers } = recorder();
  const found = elements({ view: { code: CODE }, handlers });
  found
    .find((element) => element.props.id === "join-code")
    ?.props.onChange?.({ currentTarget: { value: `${CODE}\n` } });
  let prevented = false;
  found
    .find((element) => element.type === "form")
    ?.props.onSubmit?.({
      preventDefault: () => {
        prevented = true;
      },
    });
  expect(prevented).toBe(true);
  found
    .find(
      (element) =>
        element.type === "button" && element.props.children === "Cancel",
    )
    ?.props.onClick?.({ currentTarget: "cancel button" });
  expect(calls).toEqual([`code ${CODE}\n`, "preview", "cancel cancel button"]);
});

test("a problem shows in the field's own alert, not in the status paragraph, and marks the field", () => {
  const html = render({
    view: {
      code: "mmdi_",
      problem: "This is not an invitation code.",
      message: "You joined the workspace.",
    },
  });
  expect(html).toContain(
    'aria-invalid="true" aria-describedby="join-code-hint join-code-problem" value="mmdi_"/><p class="panel-message" id="join-code-problem" role="alert">This is not an invitation code.</p>',
  );
  expect(html).toContain(
    '<p class="people-status" id="join-message" role="status">You joined the workspace.</p>',
  );
});

test("while a request runs, the field is read-only and every button stays focusable and does nothing", () => {
  const { calls, handlers } = recorder();
  const view = { running: true, code: CODE, preview: PREVIEW };
  const html = render({ view, handlers });
  expect(html).toContain(`readOnly="" aria-describedby`);
  expect(html).not.toContain('disabled=""');
  const found = elements({ view, handlers });
  const buttons = found.filter((element) => element.type === "button");
  expect(buttons.map((button) => button.props.children)).toEqual([
    "Preview",
    "Cancel",
    "Join the workspace",
  ]);
  for (const button of buttons) {
    expect(button.props["aria-disabled"]).toBe("true");
    button.props.onClick?.({ currentTarget: "button" });
  }
  found
    .find((element) => element.type === "form")
    ?.props.onSubmit?.({ preventDefault: () => undefined });
  expect(calls).toEqual([]);
});

test("a preview shows the workspace, the person, the inviter with the login in the monospace font, and the expiry, as text", () => {
  const html = render({ view: { code: CODE, preview: PREVIEW } });
  expect(html).toContain(
    '<div class="people-offer"><dl class="account-facts" id="join-preview"><dt>Workspace</dt><dd><span dir="auto">Team</span></dd><dt>You join as</dt><dd><span dir="auto">Margaret</span></dd><dt>Invited by</dt><dd><span dir="auto">Ada</span>, GitHub <span class="person-login" dir="auto" translate="no">octocat</span>, last verified <time dateTime="2026-11-06T22:30:00.000Z">7 Nov 2026</time></dd><dt>Valid until</dt><dd><time dateTime="2026-11-12T12:00:00.000Z">12 Nov 2026, 15:00</time></dd></dl><p>Check the inviter&#x27;s GitHub login, not only the name: anyone can choose a name.</p><div class="account-actions"><button type="button" class="panel-action" aria-describedby="join-preview">Join the workspace</button></div></div>',
  );

  // Names that look like markup, or run right to left, stay text.
  const marked = render({
    view: {
      preview: {
        ...PREVIEW,
        workspaceName: "<b>Team</b>",
        displayName: "\u0645\u0631\u064a\u0645",
        inviterName: '<img src="x" onerror="alert(1)">',
      },
    },
  });
  expect(marked).toContain('<span dir="auto">&lt;b&gt;Team&lt;/b&gt;</span>');
  expect(marked).toContain('<span dir="auto">\u0645\u0631\u064a\u0645</span>');
  expect(marked).toContain(
    '<span dir="auto">&lt;img src=&quot;x&quot; onerror=&quot;alert(1)&quot;&gt;</span>',
  );
  expect(marked).not.toContain("<b>");
  expect(marked).not.toContain("<img");
});

test("Join the workspace opens the question", () => {
  const { calls, handlers } = recorder();
  elements({ view: { code: CODE, preview: PREVIEW }, handlers })
    .find(
      (element) =>
        element.type === "button" &&
        element.props.children === "Join the workspace",
    )
    ?.props.onClick?.({ currentTarget: "join button" });
  expect(calls).toEqual(["ask"]);
});

test("the joined workspace is named as text, with Open this workspace while it is listed and not selected", () => {
  const joined = { workspaceId: JOINED, workspaceName: "<i>Team</i>" };
  const listed = [
    { id: WORKSPACE_A, name: "Workspace A" },
    { id: JOINED, name: "Team" },
  ];
  const { calls, handlers } = recorder();
  const props = {
    workspaces: known({ workspaces: listed }),
    view: { joined, message: "You joined the workspace." },
    handlers,
  };
  const html = render(props);
  expect(html).toContain(
    '<p class="people-status" id="join-message" role="status">You joined the workspace.</p><div class="people-offer"><p id="join-joined">Joined: <span dir="auto">&lt;i&gt;Team&lt;/i&gt;</span></p><div class="account-actions"><button type="button" class="panel-action" aria-describedby="join-joined">Open this workspace</button></div></div>',
  );
  // The workspace ID only reaches the handler.
  expect(html).not.toContain(JOINED);
  elements(props)
    .find(
      (element) =>
        element.type === "button" &&
        element.props.children === "Open this workspace",
    )
    ?.props.onClick?.({ currentTarget: "open button" });
  expect(calls).toEqual([`open ${JOINED}`]);

  expect(
    render({
      ...props,
      workspaces: known({ workspaces: listed, selectedWorkspaceId: JOINED }),
    }),
  ).toContain(
    "</p><p>It is the selected workspace now. Its projects are in the sidebar.</p></div>",
  );
  expect(render({ ...props, workspaces: known() })).toContain(
    "</p><p>It appears in your list of workspaces once the list has loaded.</p></div>",
  );
});

test("the question names the workspace and the person as text, says what joining does, and puts Back first", () => {
  const html = renderToString(
    <JoinQuestionContent
      preview={{ ...PREVIEW, displayName: "<b>Margaret</b>" }}
      onConfirm={() => undefined}
      onBack={() => undefined}
    />,
  );
  expect(html).toBe(
    '<dialog class="people-dialog" aria-labelledby="join-dialog-title" aria-describedby="join-dialog-workspace join-dialog-person join-dialog-text"><form><h2 id="join-dialog-title">Join this workspace?</h2><p class="people-dialog-name" id="join-dialog-workspace"><span dir="auto">Team</span></p><p id="join-dialog-person">You join as <span dir="auto">&lt;b&gt;Margaret&lt;/b&gt;</span></p><p id="join-dialog-text">You claim the person that the workspace added for you and become a member. Everyone in the workspace sees your GitHub login next to the person&#x27;s name, and the owner and the admins are told that you joined, with your GitHub login and the creation date of your GitHub account. The code stops working once you join.</p><div class="people-dialog-actions"><button type="button" class="panel-action">Back</button><button type="submit" class="panel-action">Join</button></div></form></dialog>',
  );
  // Without a question, the dialog waits in the page, closed and empty.
  expect(
    renderToString(
      <JoinQuestionContent
        preview={undefined}
        onConfirm={() => undefined}
        onBack={() => undefined}
      />,
    ),
  ).toBe('<dialog class="people-dialog"></dialog>');
});

test("the question confirms with its form, and Back, Escape, and a close go back", () => {
  const calls: string[] = [];
  const found = elementsOf(
    <JoinQuestionContent
      preview={PREVIEW}
      onConfirm={() => calls.push("confirm")}
      onBack={() => calls.push("back")}
    />,
  );
  const dialog = found.find((element) => element.type === "dialog");
  let prevented = 0;
  const event = {
    preventDefault: () => {
      prevented += 1;
    },
  };
  found.find((element) => element.type === "form")?.props.onSubmit?.(event);
  found
    .find(
      (element) =>
        element.type === "button" && element.props.children === "Back",
    )
    ?.props.onClick?.({ currentTarget: "back" });
  dialog?.props.onCancel?.(event);
  dialog?.props.onClose?.();
  expect(calls).toEqual(["confirm", "back", "back", "back"]);
  expect(prevented).toBe(2);
});

test("the screen holds the question's dialog only while the question is open, with the preview's names", () => {
  const closed = render({ view: { code: CODE, preview: PREVIEW } });
  expect(closed).toContain('<dialog class="people-dialog"></dialog>');
  const open = render({ view: { code: CODE, preview: PREVIEW, asking: true } });
  expect(open).toContain(
    '<h2 id="join-dialog-title">Join this workspace?</h2>',
  );
});

test("the code shows only as the field's value, never in a text of the screen", () => {
  const html = render({
    view: {
      code: CODE,
      preview: PREVIEW,
      asking: true,
      message: "The invitation is shown below. Check it before you join.",
      problem: "Paste an invitation code.",
      joined: { workspaceId: JOINED, workspaceName: "Team" },
    },
  });
  expect(html.split(CODE)).toHaveLength(2);
  expect(html).toContain(`value="${CODE}"`);
});

test("every ID is unique, every reference points to one of them, and no style attribute is used", () => {
  const listed = [{ id: JOINED, name: "Team" }];
  const html = render({
    workspaces: known({ workspaces: listed }),
    view: {
      code: CODE,
      preview: PREVIEW,
      asking: true,
      problem: "Paste an invitation code.",
      message: "You joined the workspace.",
      joined: { workspaceId: JOINED, workspaceName: "Team" },
    },
  });
  const ids = attributeValues(html, "id");
  expect(new Set(ids).size).toBe(ids.length);
  for (const reference of [
    ...attributeValues(html, "aria-labelledby"),
    ...attributeValues(html, "aria-describedby"),
    ...attributeValues(html, "for"),
  ].flatMap((value) => value.split(" "))) {
    expect(ids).toContain(reference);
  }
  expect(html).not.toMatch(/\sstyle=/);
});
