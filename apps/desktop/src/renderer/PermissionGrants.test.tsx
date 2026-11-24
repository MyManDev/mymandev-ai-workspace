// The grant section of the permission screen (#342). The components below
// `PermissionGrants` use no hooks, so the tests render the markup and also
// call the components as functions, walk the returned elements, and invoke
// their event handlers.
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";
import type {
  AgentBridge,
  GrantBridge,
  ProjectRepositoriesBridge,
} from "../shared/desktop-bridge.ts";
import {
  GRANT_RESULT_ID,
  GrantSectionContent,
  type GrantSectionHandlers,
} from "./PermissionGrants.tsx";
import { PermissionsScreen } from "./ProjectScreens.tsx";
import {
  EXPIRY_CHOICES,
  GRANT_MESSAGES,
  IDLE_GRANT_ACTIONS,
  OFFERED_CAPABILITIES,
  type GrantActionsView,
  type GrantFormView,
  type GrantSectionView,
} from "./grant-view.ts";

const HERE = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192f1";
const SECOND = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192f2";
const WEB = "0192f2a0-7c3e-7a1b-8c4d-5e6f70819201";
const GRANT_1 = "0192f2a0-7c3e-7a1b-8c4d-5e6f70819401";

interface HostProps {
  readonly children?: ReactNode;
  readonly onClick?: () => void;
  readonly onSubmit?: (event: { preventDefault: () => void }) => void;
  readonly onChange?: (event: { target: { value: string } }) => void;
  readonly id?: string;
  readonly type?: string;
  readonly disabled?: boolean;
  readonly value?: string;
}

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

const FORM: GrantFormView = {
  agents: [
    { id: HERE, label: "Builder" },
    { id: SECOND, label: "<b>Reviewer</b>" },
  ],
  agentId: HERE,
  capabilities: OFFERED_CAPABILITIES,
  capability: "repo.read",
  scopeKind: "repository",
  scopes: [{ id: WEB, label: "web" }],
  scopeId: WEB,
  scopeNote: undefined,
  expiries: EXPIRY_CHOICES,
  expiryId: "day",
  ready: true,
};

const VIEW: GrantSectionView = {
  kind: "form",
  form: FORM,
  notes: [GRANT_MESSAGES.shellLater],
  grants: [
    {
      grantId: GRANT_1,
      capability: "repo.write",
      scope: "web",
      expiry: GRANT_MESSAGES.neverExpires,
      expired: false,
    },
  ],
  grantsNote: undefined,
};

function recorder() {
  const calls: unknown[][] = [];
  const handlers: GrantSectionHandlers = {
    onAgent: (agentId) => calls.push(["agent", agentId]),
    onCapability: (capability) => calls.push(["capability", capability]),
    onScope: (scopeId) => calls.push(["scope", scopeId]),
    onExpiry: (expiryId) => calls.push(["expiry", expiryId]),
    onGrant: (agentId, form) => calls.push(["grant", agentId, form]),
    onRevoke: (agentId, grantId) => calls.push(["revoke", agentId, grantId]),
  };
  return { calls, handlers };
}

function render(
  view: GrantSectionView,
  actions: GrantActionsView = IDLE_GRANT_ACTIONS,
): string {
  return renderToString(
    <GrantSectionContent
      view={view}
      actions={actions}
      handlers={recorder().handlers}
    />,
  );
}

test("the form offers the grantable agents, the capabilities without the shell, the scopes, and the expiries, each with its label", () => {
  const html = render(VIEW);

  for (const [id, label] of [
    ["grant-agent", "Agent"],
    ["grant-capability", "Permission"],
    ["grant-scope", "Repository"],
    ["grant-expiry", "Expires"],
  ]) {
    expect(html).toContain(`<label for="${id}">${label}</label>`);
    expect(html).toContain(`<select id="${id}"`);
  }
  for (const capability of OFFERED_CAPABILITIES) {
    expect(html).toContain(`<option value="${capability}"`);
  }
  expect(html).not.toContain('<option value="terminal.execute"');
  expect(html).toContain(GRANT_MESSAGES.shellLater);
  // Names are text, never markup.
  expect(html).toContain("&lt;b&gt;Reviewer&lt;/b&gt;");
  expect(html).not.toContain("<b>Reviewer</b>");
  expect(html).toContain('<button type="submit">Grant</button>');
  // The list names the capability, its scope, and its expiry, with a
  // revoke control of its own name.
  expect(html).toContain(
    '<li class="grant-item"><code>repo.write</code> <span>web</span> <span class="grant-expiry">Does not expire</span> <button type="button" aria-label="Revoke repo.write on web">Revoke</button></li>',
  );
  // Every ID is unique, and every label names an element.
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  expect(new Set(ids).size).toBe(ids.length);
  for (const [, reference] of html.matchAll(
    /\s(?:for|aria-labelledby)="([^"]+)"/g,
  )) {
    expect(ids).toContain(reference);
  }
});

test("the form cannot be sent without a scope, and every control waits while an action does", () => {
  const notReady = render({
    ...VIEW,
    form: { ...FORM, scopeId: null, ready: false },
  });
  expect(notReady).toContain(
    '<button type="submit" disabled="">Grant</button>',
  );
  const running = render(VIEW, { running: true, message: undefined });
  expect(running.match(/<select [^>]*disabled=""/g)).toHaveLength(4);
  expect(running).toContain('<button type="submit" disabled="">Grant</button>');
  expect(running).toMatch(
    /<button type="button" (?=[^>]*disabled="")[^>]*aria-label="Revoke repo\.write on web"/,
  );
  expect(running).toContain(
    `<p id="${GRANT_RESULT_ID}" role="status">${GRANT_MESSAGES.running}</p>`,
  );
  const done = render(VIEW, {
    running: false,
    message: "The permission was granted.",
  });
  expect(done).toContain(
    `<p id="${GRANT_RESULT_ID}" role="status">The permission was granted.</p>`,
  );
});

test("each control reports its choice, the form sends its agent and its form, and a revoke sends its grant", () => {
  const { calls, handlers } = recorder();
  const elements = elementsOf(
    GrantSectionContent({ view: VIEW, actions: IDLE_GRANT_ACTIONS, handlers }),
  );
  const byId = (id: string) =>
    elements.find((element) => element.props.id === id)!;
  byId("grant-agent").props.onChange?.({ target: { value: SECOND } });
  byId("grant-capability").props.onChange?.({
    target: { value: "provider.use" },
  });
  byId("grant-scope").props.onChange?.({ target: { value: WEB } });
  byId("grant-expiry").props.onChange?.({ target: { value: "week" } });
  let prevented = false;
  elements
    .find((element) => element.type === "form")!
    .props.onSubmit?.({
      preventDefault: () => {
        prevented = true;
      },
    });
  elements
    .find(
      (element) => element.type === "button" && element.props.type === "button",
    )!
    .props.onClick?.();

  expect(prevented).toBe(true);
  expect(calls).toEqual([
    ["agent", SECOND],
    ["capability", "provider.use"],
    ["scope", WEB],
    ["expiry", "week"],
    ["grant", HERE, FORM],
    ["revoke", HERE, GRANT_1],
  ]);
});

test("without a grantable agent, or while the agents are not known, the section shows its sentence and no control", () => {
  for (const view of [
    {
      kind: "form",
      form: null,
      notes: [GRANT_MESSAGES.noGrantableAgent],
      grants: [],
      grantsNote: undefined,
    } as const,
    { kind: "message", text: GRANT_MESSAGES.pending } as const,
  ]) {
    const html = render(view);
    expect(html).not.toMatch(/<(?:button|input|select|form)[\s>]/);
  }
  expect(
    render({
      kind: "form",
      form: null,
      notes: [GRANT_MESSAGES.noGrantableAgent],
      grants: [],
      grantsNote: undefined,
    }),
  ).toContain(GRANT_MESSAGES.noGrantableAgent.replaceAll("'", "&#x27;"));
});

test("with the bridges, the screen subscribes once it is shown and first says that it checks the agents", () => {
  const unused = () => {
    throw new Error("not called while rendering on the server");
  };
  const html = renderToString(
    <PermissionsScreen
      agents={{ getState: unused, subscribeState: unused } as AgentBridge}
      projectRepositories={
        {
          getState: unused,
          subscribeState: unused,
        } as unknown as ProjectRepositoriesBridge
      }
      grants={
        {
          getState: unused,
          subscribeState: unused,
          listProviderConnections: unused,
          grant: unused,
          revoke: unused,
        } as GrantBridge
      }
    />,
  );
  expect(html).toContain(
    `<section class="grant-section"><h3 id="grant-title">Grant a permission</h3><p class="placeholder-note">${GRANT_MESSAGES.pending}</p></section>`,
  );
});
