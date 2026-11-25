// The grant section of the permission screen (#342), with the presentation
// rules of #77. The components below `PermissionGrants` use no hooks, so the
// tests render the markup and also call the components as functions, walk
// the returned elements, and invoke their event handlers; the hook's wiring
// is `grantSectionHandlers`, which the tests drive with a form state of
// their own.
import {
  createRef,
  isValidElement,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";
import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";
import type {
  AgentBridge,
  GrantBridge,
  ProjectRepositoriesBridge,
} from "../shared/desktop-bridge.ts";
import type {
  AgentActivityView,
  GrantCapabilityResult,
} from "../shared/ipc-contract.ts";
import { agentTimeFormat } from "./agent-view.ts";
import {
  GRANT_LIST_STATUS_ID,
  GRANT_RESULT_ID,
  grantAgentNoteId,
  GrantSectionContent,
  grantSectionHandlers,
  type GrantSectionHandlers,
  sectionGrantActions,
} from "./PermissionGrants.tsx";
import { PermissionsScreen } from "./ProjectScreens.tsx";
import {
  createGrantActions,
  describeGrantSection,
  EXPIRY_CHOICES,
  expiryChoices,
  AGENT_GRANTS_PROBLEM_MESSAGES,
  focusAfterConfirmation,
  GRANT_MESSAGES,
  GRANT_RESULT_MESSAGES,
  IDLE_GRANT_ACTIONS,
  INITIAL_GRANT_FORM,
  NO_AGENT_GRANTS,
  OFFERED_CAPABILITIES,
  type ConfirmationEnd,
  type GrantActions,
  type GrantActionsView,
  type GrantConfirmationView,
  type GrantFormState,
  type GrantFormView,
  type GrantSectionView,
} from "./grant-view.ts";
import {
  describeCapability,
  HIGHEST_RISK_CONFIRMATIONS,
  REPOSITORY_PROVIDER_STATEMENT,
  SHELL_STATEMENTS,
  shellGitStatement,
} from "./permission-view.ts";

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
  readonly ref?: Ref<unknown>;
  readonly tabIndex?: number;
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
  agentId: HERE,
  capabilities: OFFERED_CAPABILITIES.map((capability) => ({
    capability,
    riskLabel: describeCapability(capability).riskLabel,
  })),
  capability: "repo.read",
  risk: "standard",
  riskLabel: "Standard risk",
  meaning: "Read the files of the repository.",
  details: [],
  statements: [REPOSITORY_PROVIDER_STATEMENT],
  scopeKind: "repository",
  scopes: [{ id: WEB, label: "web" }],
  scopeId: WEB,
  scopeNote: undefined,
  expiries: EXPIRY_CHOICES,
  expiryId: "day",
  expiryNote: undefined,
  ready: true,
  needsConfirmation: false,
  confirmation: undefined,
};

const SHELL_REQUEST = {
  capability: "terminal.execute",
  scopeId: WEB,
  lifetimeSeconds: 86_400,
} as const;

/** The shell chosen on `web` for the proposed day. */
const SHELL_FORM: GrantFormView = {
  ...FORM,
  capability: "terminal.execute",
  risk: "highest",
  riskLabel: "Highest risk",
  meaning: "Run a shell that starts in the repository.",
  details: SHELL_STATEMENTS,
  statements: [],
  expiries: expiryChoices("terminal.execute"),
  expiryId: "day",
  expiryNote: GRANT_MESSAGES.shellExpiry,
  needsConfirmation: true,
};

/** The same form while its confirmation waits. */
const CONFIRMING_FORM: GrantFormView = {
  ...SHELL_FORM,
  confirmation: {
    text: HIGHEST_RISK_CONFIRMATIONS["terminal.execute"],
    agent: "Builder",
    scope: "web",
    expiry: "1 day",
    statements: [shellGitStatement(["git.push"])!],
    pending: { agentId: HERE, request: SHELL_REQUEST },
  },
};

const VIEW: GrantSectionView = {
  kind: "form",
  agents: [
    { id: HERE, label: "Builder", grantable: true },
    { id: SECOND, label: "<b>Reviewer</b>", grantable: true },
  ],
  agentId: HERE,
  form: FORM,
  notes: [],
  grants: [
    {
      grantId: GRANT_1,
      capability: "repo.write",
      scope: "web",
      expiry: GRANT_MESSAGES.neverExpires,
      expired: false,
      statements: [],
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
    onConfirm: (form) => calls.push(["confirm", form]),
    onCancel: () => calls.push(["cancel"]),
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

test("the form offers the grantable agents, every capability with its risk label, the scopes, and the expiries, each with its label", () => {
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
  expect(html).toContain(
    '<option value="repo.read" selected="">repo.read (Standard risk)</option>',
  );
  expect(html).toContain(
    '<option value="terminal.execute">terminal.execute (Highest risk)</option>',
  );
  // The chosen capability: its risk, what it allows, and with repo.read
  // that it can reach the provider together with provider.use.
  expect(html).toContain(
    '<div id="grant-capability-about" class="grant-capability" data-risk="standard"><p class="capability-risk">Standard risk</p><p>Read the files of the repository.</p><p>With <code>repo.read</code> on a repository and <code>provider.use</code> on an AI provider connection, the agent can send that repository&#x27;s content to that connection&#x27;s provider.</p></div>',
  );
  expect(html).toContain('aria-describedby="grant-capability-about"');
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
  const confirming = render({ ...VIEW, form: CONFIRMING_FORM });
  expect(confirming).toContain(
    `<button type="submit" disabled="">${GRANT_MESSAGES.submitConfirmation}</button>`,
  );
  const running = render(VIEW, { running: true, message: undefined });
  expect(running.match(/<select [^>]*disabled=""/g)).toHaveLength(4);
  expect(running).toContain('<button type="submit" disabled="">Grant</button>');
  expect(running).toMatch(
    /<button type="button" (?=[^>]*disabled="")[^>]*aria-label="Revoke repo\.write on web"/,
  );
  expect(running).toContain(
    `<p id="${GRANT_RESULT_ID}" role="status" tabindex="-1">${GRANT_MESSAGES.running}</p>`,
  );
  const done = render(VIEW, {
    running: false,
    message: "The permission was granted.",
  });
  expect(done).toContain(
    `<p id="${GRANT_RESULT_ID}" role="status" tabindex="-1">The permission was granted.</p>`,
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

const ELSEWHERE = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192f3";

/** The owner's agent that another device hosts, selected, with its grants. */
const ELSEWHERE_VIEW: GrantSectionView = {
  kind: "form",
  agents: [
    { id: HERE, label: "Builder", grantable: true },
    {
      id: ELSEWHERE,
      label: "Laptop agent (on another device)",
      grantable: false,
    },
  ],
  agentId: ELSEWHERE,
  form: null,
  notes: [GRANT_MESSAGES.hostedElsewhere],
  grants: [
    {
      grantId: GRANT_1,
      capability: "terminal.execute",
      scope: "web",
      expiry: "Expires soon",
      expired: false,
      statements: [shellGitStatement(["git.push"])!],
    },
  ],
  grantsNote: undefined,
};

test("for the owner's agent that another device hosts, the section offers the agents and its grants with Revoke and the commit and push statement, but no form", () => {
  const html = render(ELSEWHERE_VIEW);
  expect(html).toContain('<label for="grant-agent">Agent</label>');
  expect(html).toContain(
    `<option value="${ELSEWHERE}" selected="">Laptop agent (on another device)</option>`,
  );
  expect(html).toContain(`<option value="${HERE}">Builder</option>`);
  // No grant control: only the host device grants.
  expect(html).not.toMatch(/<form[\s>]/);
  expect(html).not.toContain('id="grant-capability"');
  expect(html).not.toContain('type="submit"');
  // The note on the agent describes the agent list while it shows.
  expect(html).toContain(
    `<p id="${grantAgentNoteId(0)}" class="grant-note">${GRANT_MESSAGES.hostedElsewhere.replaceAll("'", "&#x27;")}</p>`,
  );
  expect(html).toMatch(
    new RegExp(
      `<select id="grant-agent" [^>]*aria-describedby="${grantAgentNoteId(0)}"`,
    ),
  );
  expect(html).toContain(
    'aria-label="Revoke terminal.execute on web">Revoke</button>',
  );
  expect(html).toContain('class="grant-warning"');
  // The sentence on the read is always there, and announced as it changes.
  expect(html).toContain(`<p id="${GRANT_LIST_STATUS_ID}" role="status"></p>`);
  for (const note of [
    GRANT_MESSAGES.agentGrantsPending,
    GRANT_MESSAGES.noGrants,
    AGENT_GRANTS_PROBLEM_MESSAGES.not_found,
  ]) {
    expect(
      render({ ...ELSEWHERE_VIEW, grants: [], grantsNote: note }),
    ).toContain(
      `<p id="${GRANT_LIST_STATUS_ID}" class="grant-note" role="status">${note}</p>`,
    );
  }
  // Every ID is unique, and every label and description names an element.
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  expect(new Set(ids).size).toBe(ids.length);
  for (const [, references] of html.matchAll(
    /\s(?:for|aria-labelledby|aria-describedby)="([^"]+)"/g,
  )) {
    for (const reference of references!.split(" ")) {
      expect(ids).toContain(reference);
    }
  }

  const { calls, handlers } = recorder();
  const elements = elementsOf(
    GrantSectionContent({
      view: ELSEWHERE_VIEW,
      actions: IDLE_GRANT_ACTIONS,
      handlers,
    }),
  );
  elements
    .find((element) => element.props.id === "grant-agent")!
    .props.onChange?.({ target: { value: HERE } });
  elements
    .find(
      (element) => element.type === "button" && element.props.type === "button",
    )!
    .props.onClick?.();
  expect(calls).toEqual([
    ["agent", HERE],
    ["revoke", ELSEWHERE, GRANT_1],
  ]);
  // While an action waits, the agents and Revoke wait too.
  const running = render(ELSEWHERE_VIEW, { running: true, message: undefined });
  expect(running.match(/<select [^>]*disabled=""/g)).toHaveLength(1);
  expect(running).toMatch(
    /<button type="button" (?=[^>]*disabled="")[^>]*aria-label="Revoke terminal\.execute on web"/,
  );
});

test("without a grantable agent, or while the agents are not known, the section shows its sentence and no control", () => {
  for (const view of [
    {
      kind: "form",
      agents: [],
      agentId: null,
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
      agents: [],
      agentId: null,
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
          listAgentGrants: unused,
        } as GrantBridge
      }
    />,
  );
  expect(html).toContain(
    `<section class="grant-section"><h3 id="grant-title">Grant a permission</h3><p class="placeholder-note">${GRANT_MESSAGES.pending}</p></section>`,
  );
});

test("the shell is shown as the highest risk with what a shell can do, an expiry that cannot be removed, and a Grant that asks for the confirmation", () => {
  const html = render({ ...VIEW, form: SHELL_FORM });

  expect(html).toContain(
    '<option value="terminal.execute" selected="">terminal.execute (Highest risk)</option>',
  );
  expect(html).toContain(
    '<div id="grant-capability-about" class="grant-capability" data-risk="highest"><p class="capability-risk">Highest risk</p><p>Run a shell that starts in the repository.</p><p>A shell runs as the user of the agent&#x27;s device. The repository is only where it starts: it is not a sandbox.</p><p>A shell can read and change files outside the repository, use the network, run <code>git commit</code> and <code>git push</code>, and read the credentials stored for that user, including local AI provider credentials.</p><p>So a shell can send files and those credentials over the network.</p></div>',
  );
  // No choice without an expiry, and a note that says why.
  expect(html).not.toContain('<option value="none"');
  expect(html).toContain(
    '<select id="grant-expiry" aria-describedby="grant-expiry-note">',
  );
  expect(html).toContain(
    `<p id="grant-expiry-note" class="grant-note">${GRANT_MESSAGES.shellExpiry}</p>`,
  );
  expect(html).toContain(
    `<button type="submit">${GRANT_MESSAGES.submitConfirmation}</button>`,
  );
  // No confirmation before the person asks for it.
  expect(html).not.toContain("grant-confirmation");
  expect(html).not.toContain(GRANT_MESSAGES.confirm);
});

test("the confirmation shows its text, the grant as the form shows it, and the warning where it applies, with Cancel first and Confirm and grant", () => {
  const html = render({ ...VIEW, form: CONFIRMING_FORM });

  expect(html).toContain(
    '<div class="grant-confirmation" role="group" aria-labelledby="grant-confirm-title" aria-describedby="grant-confirm-text grant-confirm-grant grant-confirm-warning-0" data-risk="highest"><h4 id="grant-confirm-title">Confirm the highest-risk permission</h4><p id="grant-confirm-text">Allow this agent to run a shell in this repository? The shell runs as the user of the agent&#x27;s device and is not limited to the repository: it can read and change files outside the repository, use the network, commit and push, and read the credentials stored for that user, including local AI provider credentials.</p><dl id="grant-confirm-grant" class="grant-confirmation-grant"><dt>Agent</dt><dd>Builder</dd><dt>Permission</dt><dd><code>terminal.execute</code></dd><dt>Repository</dt><dd>web</dd><dt>Expires</dt><dd>1 day</dd></dl><p id="grant-confirm-warning-0" class="grant-warning">This agent does not have <code>git.push</code> on this repository, but the shell can still commit and push.</p><button type="button" autofocus="">Cancel</button> <button type="button">Confirm and grant</button></div>',
  );
  // Every ID is unique, and every reference, each of a list, names an
  // element.
  const references = (markup: string) => {
    const ids = [...markup.matchAll(/\sid="([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(new Set(ids).size).toBe(ids.length);
    const named = [
      ...markup.matchAll(
        /\s(?:for|aria-labelledby|aria-describedby)="([^"]+)"/g,
      ),
    ].flatMap(([, reference]) => reference!.split(" "));
    for (const reference of named) {
      expect(ids).toContain(reference);
    }
    return named;
  };
  references(html);
  // A screen reader reads the text, the grant, and every warning when the
  // focus enters the group on "Cancel", with no warning or with several.
  const describedBy = (statements: GrantConfirmationView["statements"]) => {
    const markup = render({
      ...VIEW,
      form: {
        ...CONFIRMING_FORM,
        confirmation: { ...CONFIRMING_FORM.confirmation!, statements },
      },
    });
    references(markup);
    return /<div class="grant-confirmation"[^>]* aria-describedby="([^"]+)"/.exec(
      markup,
    )?.[1];
  };
  expect(describedBy([])).toBe("grant-confirm-text grant-confirm-grant");
  expect(
    describedBy([
      shellGitStatement(["git.push"])!,
      shellGitStatement("unknown")!,
    ]),
  ).toBe(
    "grant-confirm-text grant-confirm-grant grant-confirm-warning-0 grant-confirm-warning-1",
  );
  // While an action runs, the confirmation waits too.
  expect(
    render(
      { ...VIEW, form: CONFIRMING_FORM },
      { running: true, message: undefined },
    ),
  ).toContain(
    '<button type="button" autofocus="" disabled="">Cancel</button> <button type="button" disabled="">Confirm and grant</button>',
  );

  const { calls, handlers } = recorder();
  const elements = elementsOf(
    GrantSectionContent({
      view: { ...VIEW, form: CONFIRMING_FORM },
      actions: IDLE_GRANT_ACTIONS,
      handlers,
    }),
  );
  const button = (text: string) =>
    elements.find(
      (element) => element.type === "button" && element.props.children === text,
    )!;
  expect(button(GRANT_MESSAGES.cancel).props).toMatchObject({
    autoFocus: true,
  });
  button(GRANT_MESSAGES.cancel).props.onClick?.();
  button(GRANT_MESSAGES.confirm).props.onClick?.();
  expect(calls).toEqual([["cancel"], ["confirm", CONFIRMING_FORM]]);
});

test("an active shell grant in the list says that the shell can still commit and push", () => {
  const html = render({
    ...VIEW,
    grants: [
      {
        grantId: GRANT_1,
        capability: "terminal.execute",
        scope: "web",
        expiry: "Expires soon",
        expired: false,
        statements: [shellGitStatement(["git.commit", "git.push"])!],
      },
    ],
  });
  expect(html).toContain(
    '<li class="grant-item"><code>terminal.execute</code> <span>web</span> <span class="grant-expiry">Expires soon</span> <button type="button" aria-label="Revoke terminal.execute on web">Revoke</button><p class="grant-warning">This agent has neither <code>git.commit</code> nor <code>git.push</code> on this repository, but the shell can still commit and push.</p></li>',
  );
});

/** The open project's agents for the wiring tests: one grantable here. */
const AGENTS: AgentActivityView = {
  status: "ready",
  revision: 1,
  workspaceId: "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a1",
  projectId: "0192f2a0-7c3e-7a1b-8c4d-5e6f708192e1",
  agents: [
    {
      id: HERE,
      name: "Builder",
      ownerName: "Ada",
      disabledAt: null,
      ownedByMe: true,
      grantableHere: true,
      hostedElsewhere: false,
    },
    {
      id: SECOND,
      name: "Reviewer",
      ownerName: "Ada",
      disabledAt: null,
      ownedByMe: true,
      grantableHere: true,
      hostedElsewhere: false,
    },
  ],
  unfinishedRuns: [],
  moreUnfinishedRuns: 0,
  finishedRuns: [],
};

/**
 * The hook's loop without the hook: a form state, the view that it gives,
 * the handlers for it, and the grants that reached the actions.
 */
function wiring(
  actions: Pick<GrantActions, "grant" | "revoke"> | undefined = undefined,
) {
  let state: GrantFormState = INITIAL_GRANT_FORM;
  const granted: unknown[][] = [];
  const ends: ConfirmationEnd[] = [];
  actions ??= {
    grant: async (agentId, request) => {
      granted.push([agentId, request]);
    },
    revoke: async () => {},
  };
  const section = () =>
    describeGrantSection({
      agents: { kind: "known", state: AGENTS },
      repositories: {
        kind: "known",
        state: {
          status: "ready",
          revision: 1,
          workspaceId: AGENTS.workspaceId,
          projectId: AGENTS.projectId,
          links: "ready",
          repositories: [
            {
              repositoryId: WEB,
              name: "web",
              linked: false,
              mountId: null,
              removable: true,
            },
          ],
        },
      },
      grants: { kind: "pending" },
      agentGrants: NO_AGENT_GRANTS,
      connections: { kind: "pending" },
      form: state,
      now: Date.parse("2026-11-24T12:00:00.000Z"),
      timeFormat: agentTimeFormat({ locale: "en-US", timeZone: "UTC" }),
    });
  const form = () => {
    const view = section();
    if (view.kind !== "form" || view.form === null) {
      throw new Error("no form");
    }
    return view.form;
  };
  const handlers = () =>
    grantSectionHandlers(
      state,
      (change) => {
        state = change(state);
      },
      actions,
      (end) => ends.push(end),
    );
  return { section, form, handlers, granted, ends, state: () => state };
}

test("a standard capability is granted at once, without the confirmation flag", () => {
  const { form, handlers, granted } = wiring();
  handlers().onScope(WEB);
  handlers().onGrant(HERE, form());
  expect(granted).toEqual([
    [HERE, { capability: "repo.read", scopeId: WEB, lifetimeSeconds: null }],
  ]);
});

test("no grant of the shell is sent without the person's confirmation, and the confirmation sends it with confirmedHighestRisk", () => {
  const { form, handlers, granted, state } = wiring();
  handlers().onCapability("terminal.execute");
  handlers().onScope(WEB);
  expect(form().expiryId).toBe("day");
  // "Grant" only asks.
  handlers().onGrant(HERE, form());
  expect(granted).toEqual([]);
  expect(state().confirming).toEqual({ agentId: HERE, request: SHELL_REQUEST });
  expect(form().confirmation?.text).toBe(
    HIGHEST_RISK_CONFIRMATIONS["terminal.execute"],
  );
  // A second "Grant" while it waits sends nothing either.
  handlers().onGrant(HERE, form());
  expect(granted).toEqual([]);
  // The confirmation sends it once, and ends.
  handlers().onConfirm(form());
  expect(granted).toEqual([
    [HERE, { ...SHELL_REQUEST, confirmedHighestRisk: true }],
  ]);
  expect(state().confirming).toBeNull();
  expect(form().confirmation).toBeUndefined();
  // A confirmation of the view that is gone sends nothing again.
  handlers().onConfirm(CONFIRMING_FORM);
  expect(granted).toHaveLength(1);
});

test("cancelling the confirmation, or changing the agent, the capability, the scope, or the expiry during it, sends nothing", () => {
  const changes: [string, (handlers: GrantSectionHandlers) => void][] = [
    ["cancel", (handlers) => handlers.onCancel()],
    ["agent", (handlers) => handlers.onAgent(SECOND)],
    ["capability", (handlers) => handlers.onCapability("repo.write")],
    ["scope", (handlers) => handlers.onScope(WEB)],
    ["expiry", (handlers) => handlers.onExpiry("week")],
  ];
  for (const [label, change] of changes) {
    const { form, handlers, granted, state } = wiring();
    handlers().onCapability("terminal.execute");
    handlers().onScope(WEB);
    handlers().onGrant(HERE, form());
    const asked = form();
    expect(asked.confirmation, label).toBeDefined();

    change(handlers());
    expect(state().confirming, label).toBeNull();
    expect(form().confirmation, label).toBeUndefined();
    // Neither the confirmation that was shown nor the form now sends it.
    handlers().onConfirm(asked);
    handlers().onConfirm(form());
    expect(granted, label).toEqual([]);
  }
});

test("once the person ends the confirmation, the focus goes back to Grant after Cancel, and to the sentence after an action after a confirmation that sent", () => {
  const asking = () => {
    const wired = wiring();
    wired.handlers().onCapability("terminal.execute");
    wired.handlers().onScope(WEB);
    wired.handlers().onGrant(HERE, wired.form());
    expect(wired.form().confirmation).toBeDefined();
    return wired;
  };

  const cancelled = asking();
  cancelled.handlers().onCancel();
  expect(cancelled.ends).toEqual(["cancelled"]);
  expect(
    focusAfterConfirmation(
      "cancelled",
      cancelled.section(),
      IDLE_GRANT_ACTIONS,
    ),
  ).toBe("submit");

  const sent = asking();
  sent.handlers().onConfirm(sent.form());
  expect(sent.granted).toHaveLength(1);
  expect(sent.ends).toEqual(["sent"]);
  // "Grant" is disabled while the request waits.
  expect(
    focusAfterConfirmation("sent", sent.section(), {
      running: true,
      message: undefined,
    }),
  ).toBe("result");

  // A confirmation of another grant than the one that waits sends
  // nothing, and leaves "Grant" to use again.
  const other = asking();
  const asked = other.form();
  other.handlers().onConfirm({
    ...asked,
    confirmation: {
      ...asked.confirmation!,
      pending: { agentId: SECOND, request: SHELL_REQUEST },
    },
  });
  expect(other.granted).toEqual([]);
  expect(other.ends).toEqual(["not_sent"]);
  expect(other.state().confirming).toBeNull();

  // Once nothing waits, the handlers end nothing, so a later render
  // does not move the focus.
  const stale = asking();
  const shown = stale.form();
  stale.handlers().onExpiry("week");
  stale.handlers().onConfirm(shown);
  stale.handlers().onCancel();
  expect(stale.granted).toEqual([]);
  expect(stale.ends).toEqual([]);

  // Every other change ends nothing that moves the focus.
  const changed = asking();
  changed.handlers().onScope(WEB);
  expect(changed.ends).toEqual([]);

  // The two places take the hook's refs, and the sentence can take the
  // focus without being in the tab order.
  const focus = {
    submit: createRef<HTMLButtonElement>(),
    result: createRef<HTMLParagraphElement>(),
  };
  const elements = elementsOf(
    GrantSectionContent({
      view: { ...VIEW, form: SHELL_FORM },
      actions: IDLE_GRANT_ACTIONS,
      handlers: recorder().handlers,
      focus,
    }),
  );
  const submit = elements.filter(
    (element) => element.type === "button" && element.props.type === "submit",
  );
  expect(submit).toHaveLength(1);
  expect(submit[0]!.props.ref).toBe(focus.submit);
  const result = elements.find(
    (element) => element.props.id === GRANT_RESULT_ID,
  )!;
  expect(result.props.ref).toBe(focus.result);
  expect(result.props.tabIndex).toBe(-1);
});

test("confirming twice with the same handlers sends the grant once", async () => {
  // A bridge whose answer waits, as while the server has not answered.
  const sent: unknown[][] = [];
  let answer: (result: GrantCapabilityResult) => void = () => {};
  const views: GrantActionsView[] = [];
  const actions = createGrantActions(
    {
      grant: (agentId, request) => {
        sent.push([agentId, request]);
        return new Promise((resolve) => {
          answer = resolve;
        });
      },
      revoke: () => Promise.reject(new Error("not called")),
    },
    (view) => views.push(view),
  );
  const { form, handlers } = wiring(actions);
  handlers().onCapability("terminal.execute");
  handlers().onScope(WEB);
  handlers().onGrant(HERE, form());
  const shown = form();

  // A double click reaches the same handlers, made for the state that
  // waits for the confirmation, before the section is drawn again.
  const same = handlers();
  same.onConfirm(shown);
  same.onConfirm(shown);
  expect(sent).toEqual([
    [HERE, { ...SHELL_REQUEST, confirmedHighestRisk: true }],
  ]);
  answer({ outcome: "ok", grantId: GRANT_1 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(sent).toHaveLength(1);
  expect(views.at(-1)).toEqual({
    running: false,
    message: GRANT_RESULT_MESSAGES.granted,
  });
});

test("every revocation that ended, whatever its outcome, bumps the section's refresh, so that an agent on another device is read again; a grant does not", async () => {
  const bumps: ((count: number) => number)[] = [];
  let revoked: () => Promise<{ readonly outcome: "ok" }> = () =>
    Promise.resolve({ outcome: "ok" });
  const actions = sectionGrantActions(
    {
      grant: () => Promise.resolve({ outcome: "ok", grantId: GRANT_1 }),
      revoke: () => revoked(),
    },
    () => {},
    (change) => bumps.push(change),
  );
  await actions.grant(HERE, {
    capability: "repo.read",
    scopeId: WEB,
    lifetimeSeconds: null,
  });
  expect(bumps).toEqual([]);
  await actions.revoke(HERE, GRANT_1);
  expect(bumps).toHaveLength(1);
  revoked = () => Promise.reject(new Error("lost"));
  await actions.revoke(HERE, GRANT_1);
  expect(bumps).toHaveLength(2);
  // Each bump counts one more, from whatever count the section holds.
  expect(bumps.map((bump) => bump(3))).toEqual([4, 4]);
});
