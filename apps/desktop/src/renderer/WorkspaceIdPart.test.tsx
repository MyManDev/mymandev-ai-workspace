// The workspace ID on the people screen (#95; the Project Manager's decision
// of 2026-11-13). The tests run without a DOM: the part has no hooks, so
// they render it with `react-dom/server` and call it as a function to reach
// its button's click handler; the hook runs in a server render, which runs
// its body but no effect.
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";
import type { WorkspaceBridge } from "../shared/desktop-bridge.ts";
import type { PeopleView, PersonView } from "../shared/ipc-contract.ts";
import { PeopleScreenContent } from "./PeopleScreen.tsx";
import { peopleDateFormat, type PeopleScreenView } from "./people-view.ts";
import {
  useWorkspaceIdCopy,
  WORKSPACE_ID_LINE_ID,
  WORKSPACE_ID_MESSAGE_ID,
  WorkspaceIdPart,
  type WorkspaceIdCopyControls,
} from "./WorkspaceIdPart.tsx";
import {
  IDLE_WORKSPACE_ID_COPY,
  type WorkspaceIdCopyView,
} from "./workspace-id-view.ts";

const WORKSPACE = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3";
const OTHER_WORKSPACE = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a4";
const OWN = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c1";
const OTHER = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c2";

function person(
  memberId: string,
  overrides: Partial<PersonView> = {},
): PersonView {
  return {
    memberId,
    displayName: "Ada",
    role: "member",
    claimed: true,
    login: "octocat",
    verifiedAt: "2026-11-06T22:30:00.000Z",
    former: false,
    ...overrides,
  };
}

const READY: PeopleView = {
  revision: 4,
  status: "ready",
  workspaceId: WORKSPACE,
  workspaceName: "Team",
  ownMemberId: OWN,
  people: [person(OWN), person(OTHER, { role: "owner", displayName: "Lin" })],
  morePeople: 0,
  ownershipOffer: null,
  maxUnclaimedMembers: null,
};

function known(overrides: Partial<PeopleView> = {}): PeopleScreenView {
  return { kind: "known", state: { ...READY, ...overrides } as PeopleView };
}

/** Controls that record every copy. */
function controls(view: WorkspaceIdCopyView = IDLE_WORKSPACE_ID_COPY) {
  const copied: string[] = [];
  const value: WorkspaceIdCopyControls = {
    view,
    onCopy: (workspaceId) => copied.push(workspaceId),
  };
  return { value, copied };
}

function render(
  view: PeopleScreenView,
  copy: WorkspaceIdCopyView = IDLE_WORKSPACE_ID_COPY,
): string {
  return renderToString(
    <WorkspaceIdPart view={view} copy={controls(copy).value} />,
  );
}

/** The status paragraph of the copy, with this text. */
function message(text = ""): string {
  return `<p class="people-status" id="workspace-id-message" role="status">${text}</p>`;
}

const BOX_START =
  '<div class="people-offer"><p id="workspace-id-line">Workspace ID: <span class="workspace-id" dir="ltr" translate="no">0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3</span></p><p>Someone who is not in this workspace can ask to join it with this ID. The owner or an admin decides.</p><div class="account-actions">';
const BUTTON =
  '<button type="button" class="panel-action" aria-describedby="workspace-id-line">Copy</button>';
const INERT_BUTTON =
  '<button type="button" class="panel-action" aria-describedby="workspace-id-line" aria-disabled="true">Copy</button>';
const BOX_END = "</div></div>";

test("every active member sees the ID as text in the monospace font, never translated, the sentence of what it allows, Copy, and the empty status paragraph", () => {
  for (const role of ["owner", "admin", "member"] as const) {
    expect(
      render(known({ people: [person(OWN, { role }), person(OTHER)] })),
      role,
    ).toBe(BOX_START + BUTTON + BOX_END + message());
  }
  expect(WORKSPACE_ID_LINE_ID).toBe("workspace-id-line");
  expect(WORKSPACE_ID_MESSAGE_ID).toBe("workspace-id-message");
});

test("without the people ready or without the account's own active person, no ID shows, and the status paragraph stays", () => {
  for (const view of [
    { kind: "unavailable" },
    { kind: "pending" },
    known({ status: "loading" }),
    known({ status: "no_workspace", workspaceId: null }),
    known({ people: [person(OWN, { former: true }), person(OTHER)] }),
    known({ people: [person(OTHER)] }),
  ] satisfies PeopleScreenView[]) {
    expect(render(view)).toBe(message());
  }
});

test("while a copy runs, Copy stays on the page, focusable, and does nothing; it is never disabled, so the focus stays on it", () => {
  const running = { running: true, last: undefined };
  expect(render(known(), running)).toBe(
    BOX_START + INERT_BUTTON + BOX_END + message(),
  );
  // In every state of the copy, the one button is there and keeps its place.
  for (const copy of [
    IDLE_WORKSPACE_ID_COPY,
    running,
    { running: false, last: { workspaceId: WORKSPACE, copied: true } },
    { running: false, last: { workspaceId: WORKSPACE, copied: false } },
  ]) {
    const html = render(known(), copy);
    expect(html.match(/<button[^>]*>Copy<\/button>/g)).toHaveLength(1);
    expect(html.startsWith(BOX_START)).toBe(true);
    expect(html).not.toMatch(/\sdisabled=/);
    expect(html).not.toMatch(/\sautofocus/i);
  }
});

test("after a copy, its sentence shows politely in the status paragraph, only for the ID that it copied", () => {
  const copied = {
    running: false,
    last: { workspaceId: WORKSPACE, copied: true },
  };
  const notCopied = {
    running: false,
    last: { workspaceId: WORKSPACE, copied: false },
  };

  expect(render(known(), copied)).toBe(
    BOX_START + BUTTON + BOX_END + message("The workspace ID was copied."),
  );
  expect(render(known(), notCopied)).toBe(
    BOX_START +
      BUTTON +
      BOX_END +
      message(
        "The workspace ID could not be copied. Select it and copy it instead.",
      ),
  );
  // After a switch to another workspace, and once no ID shows.
  expect(render(known({ workspaceId: OTHER_WORKSPACE }), copied)).toContain(
    message(),
  );
  expect(render({ kind: "pending" }, copied)).toBe(message());
});

interface ButtonProps {
  readonly children?: ReactNode;
  readonly onClick?: () => void;
}

/** The elements of a tree whose components have no hooks. */
function elementsOf(node: ReactNode): ReactElement<ButtonProps>[] {
  if (Array.isArray(node)) {
    return node.flatMap((child: ReactNode) => elementsOf(child));
  }
  if (!isValidElement<ButtonProps>(node)) {
    return [];
  }
  if (typeof node.type === "function") {
    return elementsOf(
      (node.type as (props: ButtonProps) => ReactNode)(node.props),
    );
  }
  return [node, ...elementsOf(node.props.children)];
}

function copyButton(
  view: PeopleScreenView,
  copy: WorkspaceIdCopyControls,
): ReactElement<ButtonProps> | undefined {
  return elementsOf(<WorkspaceIdPart view={view} copy={copy} />).find(
    (element) => element.type === "button",
  );
}

test("Copy asks for exactly the ID that the screen shows, once per click, and does nothing while a copy runs", () => {
  const idle = controls();
  copyButton(known(), idle.value)?.props.onClick?.();
  copyButton(
    known({ workspaceId: OTHER_WORKSPACE }),
    idle.value,
  )?.props.onClick?.();
  expect(idle.copied).toEqual([WORKSPACE, OTHER_WORKSPACE]);

  const running = controls({ running: true, last: undefined });
  const button = copyButton(known(), running.value);
  expect(button).toBeDefined();
  expect(button?.props.onClick).toBeUndefined();
  expect(running.copied).toEqual([]);
});

test("the people screen shows the part right below the workspace's name, before its status paragraph, and none without the controls", () => {
  const dates = peopleDateFormat({ locale: "en-GB", timeZone: "UTC" });
  const named =
    '<p class="people-workspace">Workspace: <span dir="auto">Team</span></p>';
  const html = renderToString(
    <PeopleScreenContent
      view={known()}
      dateFormat={dates}
      workspaceIdCopy={controls().value}
    />,
  );
  expect(html).toContain(
    named +
      BOX_START +
      BUTTON +
      BOX_END +
      message() +
      '<p class="people-status" role="status"></p>',
  );
  const without = renderToString(
    <PeopleScreenContent view={known()} dateFormat={dates} />,
  );
  expect(without).not.toContain("workspace-id");
  expect(without).not.toContain(READY.workspaceId);
});

test("the hook gives no controls without the bridge, and with it a copy goes to the bridge's copyId with only the ID", async () => {
  let given: WorkspaceIdCopyControls | undefined;
  function Harness({
    bridge,
  }: {
    readonly bridge: Pick<WorkspaceBridge, "copyId"> | undefined;
  }) {
    given = useWorkspaceIdCopy(bridge);
    return null;
  }

  renderToString(<Harness bridge={undefined} />);
  expect(given).toBeUndefined();

  const calls: unknown[][] = [];
  const bridge: Pick<WorkspaceBridge, "copyId"> = {
    copyId: (...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve({ outcome: "ok" });
    },
  };
  renderToString(<Harness bridge={bridge} />);
  expect(given?.view).toEqual(IDLE_WORKSPACE_ID_COPY);
  given?.onCopy(WORKSPACE);
  await Promise.resolve();
  expect(calls).toEqual([[WORKSPACE]]);
});

// The sources of the part, and of every other renderer module, without the
// tests, as text.
const PART_SOURCES = import.meta.glob<string>(
  ["./WorkspaceIdPart.tsx", "./workspace-id-view.ts"],
  { query: "?raw", import: "default", eager: true },
);
const RENDERER_SOURCES = import.meta.glob<string>(
  ["./**/*.{ts,tsx}", "!./**/*.test.*"],
  { query: "?raw", import: "default", eager: true },
);

/** `source` without its block and line comments; the sources hold no `//` in a string. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** What would reach the clipboard, a log, storage, or the focus outside the bridge. */
const FORBIDDEN: readonly [string, RegExp][] = [
  ["clipboard", /clipboard/i],
  ["execCommand", /\bexecCommand\b/],
  ["console", /\bconsole\b/],
  ["localStorage", /\blocalStorage\b/],
  ["sessionStorage", /\bsessionStorage\b/],
  ["focus", /\.focus\s*\(/],
  // `aria-disabled` keeps Copy focusable; `disabled` would drop the focus.
  ["disabled", /(?<![-\w])disabled\s*=/],
];

test("the part reaches the clipboard only through the bridge's copyId, logs and stores nothing, and never moves the focus or disables Copy", () => {
  expect(Object.keys(PART_SOURCES).sort()).toEqual([
    "./WorkspaceIdPart.tsx",
    "./workspace-id-view.ts",
  ]);
  for (const [file, source] of Object.entries(PART_SOURCES)) {
    const code = withoutComments(source);
    expect(code.length, file).toBeGreaterThan(1_000);
    for (const [name, pattern] of FORBIDDEN) {
      expect(pattern.test(code), `${file}: ${name}`).toBe(false);
    }
  }
  expect(withoutComments(PART_SOURCES["./workspace-id-view.ts"] ?? "")).toMatch(
    /\bbridge\.copyId\(workspaceId\)/,
  );
  // The check finds each of them in code.
  const sample = withoutComments(
    [
      "// navigator.clipboard is named in a comment only.",
      "void navigator.clipboard.writeText(id);",
      'document.execCommand("copy");',
      "console.info(id);",
      'localStorage.setItem("id", id);',
      'sessionStorage.setItem("id", id);',
      "button.focus();",
      "<button aria-disabled={inert} disabled={true}>",
    ].join("\n"),
  );
  expect(
    FORBIDDEN.filter(([, pattern]) => pattern.test(sample)).map(
      ([name]) => name,
    ),
  ).toEqual(FORBIDDEN.map(([name]) => name));
});

test("no renderer module uses the clipboard itself: the session denies its permissions, and the main process writes the workspace ID", () => {
  const files = Object.keys(RENDERER_SOURCES);
  expect(files).toContain("./WorkspaceIdPart.tsx");
  expect(files).toContain("./PeopleScreen.tsx");
  expect(files).toContain("./AccountPanel.tsx");
  expect(files.filter((file) => /\.test\./.test(file))).toEqual([]);
  for (const [file, source] of Object.entries(RENDERER_SOURCES)) {
    const code = withoutComments(source);
    expect(/clipboard/i.test(code), file).toBe(false);
    expect(/\bexecCommand\b/.test(code), file).toBe(false);
  }
});
