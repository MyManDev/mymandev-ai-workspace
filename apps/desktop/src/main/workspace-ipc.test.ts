import {
  LIMITS,
  MAX_ANSWER_LIST_ITEMS,
  newUuidV7,
  ProjectIdSchema,
  WorkspaceIdSchema,
  type MemberId,
  type ProjectId,
  type WorkspaceId,
} from "@mymandev/protocol";
import { expect, test } from "vitest";
import { EVENT_CHANNELS, INVOKE_CHANNELS } from "../shared/ipc-channels.ts";
import {
  ProtocolIdSchema,
  WORKSPACE_LIMITS,
  WORKSPACE_PROBLEMS,
  WORKSPACE_STATUSES,
  WorkspaceViewSchema,
} from "../shared/ipc-contract.ts";
import { WORKSPACE_READ_FAILURES } from "./api-reads.ts";
import { APP_ENTRY_URL } from "./app-protocol.ts";
import type {
  IpcFrame,
  IpcInvokeEvent,
  IpcInvokeListener,
  StatusReceiver,
} from "./ipc.ts";
import type {
  ProjectSummary,
  WorkspaceServiceStatus,
  WorkspaceState,
  WorkspaceSummary,
} from "./workspace/service.ts";
import {
  closeProjectWithPage,
  createWorkspaceActions,
  registerWorkspaceIpc,
  workspaceView,
  type WorkspacePageWindow,
} from "./workspace-ipc.ts";

const DEV_URL = "http://localhost:5173/";

const WORKSPACE_ID = "019a5b2c-3d4e-7f60-8a1b-2c3d4e5f6a7b" as WorkspaceId;
const OTHER_WORKSPACE_ID =
  "019a5b2c-3d4e-7f61-8a1b-2c3d4e5f6a7b" as WorkspaceId;
const PROJECT_ID = "019a5b2c-3d4e-7f60-9a1b-2c3d4e5f6a7c" as ProjectId;
const MEMBER_ID = "019a5b2c-3d4e-7f60-aa1b-2c3d4e5f6a7d" as MemberId;

const STATE: WorkspaceState = Object.freeze({
  revision: 2,
  status: "ready",
  workspaces: Object.freeze([
    Object.freeze({ id: WORKSPACE_ID, name: "Team" }),
    Object.freeze({ id: OTHER_WORKSPACE_ID, name: "Other team" }),
  ]),
  selectedWorkspaceId: WORKSPACE_ID,
  projects: Object.freeze([
    Object.freeze({
      id: PROJECT_ID,
      name: "Desktop",
      createdByMemberId: MEMBER_ID,
    }),
  ]),
  openProjectId: PROJECT_ID,
});

const VIEW = {
  revision: 2,
  status: "ready",
  workspaces: [
    { id: WORKSPACE_ID, name: "Team" },
    { id: OTHER_WORKSPACE_ID, name: "Other team" },
  ],
  selectedWorkspaceId: WORKSPACE_ID,
  projects: [{ id: PROJECT_ID, name: "Desktop" }],
  openProjectId: PROJECT_ID,
};

/** IDs that are not a lowercase UUIDv7, and values that are not strings. */
const NOT_PROTOCOL_IDS: readonly unknown[] = [
  "",
  "workspace",
  // A UUID of version 4, and of version 7 with a wrong variant.
  "0b9e2f7c-5d0a-4c8e-9f3b-2a1d6e4c8b70",
  "019a5b2c-3d4e-7f60-ca1b-2c3d4e5f6a7b",
  WORKSPACE_ID.toUpperCase(),
  `${WORKSPACE_ID} `,
  `${WORKSPACE_ID}\n`,
  WORKSPACE_ID.replaceAll("-", ""),
  `${WORKSPACE_ID}${"0".repeat(100_000)}`,
  "x".repeat(1_000_000),
  1,
  0n,
  true,
  {},
  { id: WORKSPACE_ID },
  [WORKSPACE_ID],
  undefined,
];

function frame(url: string, parent: IpcFrame | null = null): IpcFrame {
  return { url, parent, detached: false, isDestroyed: () => false };
}

function receiver(url: string = DEV_URL) {
  const sent: unknown[][] = [];
  const value: StatusReceiver & { sent: unknown[][] } = {
    mainFrame: frame(url),
    sent,
    isDestroyed: () => false,
    send: (channel, ...args) => {
      sent.push([channel, ...args]);
    },
    once: () => undefined,
  };
  return value;
}

function event(
  senderFrame: IpcFrame | null,
  sender: StatusReceiver = receiver(),
): IpcInvokeEvent {
  return { senderFrame, sender };
}

/**
 * A workspace service that records its calls. Like the real one, it selects
 * only a listed workspace and opens only a project of the selected one, and
 * it tells its listeners of every change.
 */
function fakeService(initial: WorkspaceState = STATE) {
  let state = initial;
  const calls: { method: string; args: unknown[] }[] = [];
  const listeners: ((state: WorkspaceState) => void)[] = [];
  const change = (next: Partial<WorkspaceState>) => {
    state = Object.freeze({ ...state, ...next, revision: state.revision + 1 });
    for (const listener of listeners) {
      listener(state);
    }
  };
  return {
    calls,
    current: () => state,
    emit: (next: unknown) => {
      for (const listener of listeners) {
        listener(next as WorkspaceState);
      }
    },
    service: {
      state: () => {
        calls.push({ method: "state", args: [] });
        return state;
      },
      onChange: (listener: (state: WorkspaceState) => void) => {
        listeners.push(listener);
        return () => undefined;
      },
      select: (workspaceId: WorkspaceId) => {
        calls.push({ method: "select", args: [workspaceId] });
        if (!state.workspaces.some(({ id }) => id === workspaceId)) {
          return false;
        }
        if (workspaceId !== state.selectedWorkspaceId) {
          change({
            selectedWorkspaceId: workspaceId,
            projects: Object.freeze([]),
            openProjectId: null,
          });
        }
        return true;
      },
      openProject: (projectId: ProjectId | null) => {
        calls.push({ method: "openProject", args: [projectId] });
        if (
          projectId !== null &&
          !state.projects.some(({ id }) => id === projectId)
        ) {
          return false;
        }
        if (projectId !== state.openProjectId) {
          change({ openProjectId: projectId });
        }
        return true;
      },
    },
  };
}

function register(
  fake: ReturnType<typeof fakeService>,
  appUrl: string = DEV_URL,
) {
  const handlers = new Map<string, IpcInvokeListener>();
  const errors: string[] = [];
  registerWorkspaceIpc(
    { handle: (channel, listener) => handlers.set(channel, listener) },
    appUrl,
    fake.service,
    (message) => errors.push(message),
  );
  const call = (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (handler === undefined) {
      throw new Error(`No handler for ${channel}.`);
    }
    return handler(event(frame(appUrl)), ...args);
  };
  return { handlers, errors, call };
}

const WORKSPACE_CHANNELS = Object.values(INVOKE_CHANNELS).filter((channel) =>
  channel.startsWith("workspaces:"),
);

test("the workspace channels are registered, and nothing else", () => {
  const { handlers } = register(fakeService());

  expect(WORKSPACE_CHANNELS).toHaveLength(4);
  expect([...handlers.keys()].sort()).toEqual([...WORKSPACE_CHANNELS].sort());
});

test("the limits, the problems, and the statuses match the protocol and the service", () => {
  expect(WORKSPACE_LIMITS.workspaces).toBe(MAX_ANSWER_LIST_ITEMS);
  expect(WORKSPACE_LIMITS.projects).toBe(MAX_ANSWER_LIST_ITEMS);
  expect(WORKSPACE_LIMITS.name).toBe(LIMITS.name);
  expect(WORKSPACE_PROBLEMS).toEqual(WORKSPACE_READ_FAILURES);
  const serviceStatuses = {
    signed_out: true,
    loading: true,
    ready: true,
    unavailable: true,
  } satisfies Record<WorkspaceServiceStatus, true>;
  expect([...WORKSPACE_STATUSES].sort()).toEqual(
    Object.keys(serviceStatuses).sort(),
  );
});

test("the contract's ID schema accepts exactly what the protocol's ID schemas accept", () => {
  const samples: unknown[] = [
    ...NOT_PROTOCOL_IDS,
    WORKSPACE_ID,
    PROJECT_ID,
    "00000000-0000-7000-8000-000000000000",
    "ffffffff-ffff-7fff-bfff-ffffffffffff",
    "ffffffff-ffff-6fff-bfff-ffffffffffff",
    "ffffffff-ffff-7fff-7fff-ffffffffffff",
    ...Array.from({ length: 50 }, () => newUuidV7()),
  ];
  for (const sample of samples) {
    const local = ProtocolIdSchema.safeParse(sample).success;
    expect(WorkspaceIdSchema.safeParse(sample).success, String(sample)).toBe(
      local,
    );
    expect(ProjectIdSchema.safeParse(sample).success, String(sample)).toBe(
      local,
    );
  }
});

test("every handler refuses a foreign sender, before the service is asked", () => {
  const fake = fakeService();
  const { handlers } = register(fake, APP_ENTRY_URL);
  const validArguments: Record<string, unknown[]> = {
    [INVOKE_CHANNELS.selectWorkspace]: [WORKSPACE_ID],
    [INVOKE_CHANNELS.openProject]: [PROJECT_ID],
  };
  for (const [channel, handler] of handlers) {
    for (const sender of [
      null,
      frame("https://example.invalid/"),
      frame(APP_ENTRY_URL, frame(APP_ENTRY_URL)),
      frame(DEV_URL),
      { ...frame(APP_ENTRY_URL), detached: true },
    ]) {
      expect(
        () => handler(event(sender), ...(validArguments[channel] ?? [])),
        channel,
      ).toThrow(
        `The call on ${channel} was refused: the sender is not the application.`,
      );
    }
  }
  expect(fake.calls).toEqual([]);
});

test("the state channels refuse any argument, before the service is asked", () => {
  const fake = fakeService();
  const { call } = register(fake);
  for (const channel of [
    INVOKE_CHANNELS.getWorkspaceState,
    INVOKE_CHANNELS.subscribeWorkspaceState,
  ]) {
    for (const args of [[undefined], [WORKSPACE_ID], [{}, 1]]) {
      expect(() => call(channel, ...args), channel).toThrow(
        `The call on ${channel} was refused: the arguments do not match the contract.`,
      );
    }
  }
  expect(fake.calls).toEqual([]);
});

test("select refuses an ID that is not a lowercase UUIDv7, a wrong type, a missing or an extra argument, before the service is asked", () => {
  const fake = fakeService();
  const { call } = register(fake);
  const channel = INVOKE_CHANNELS.selectWorkspace;
  const refused = `The call on ${channel} was refused: the arguments do not match the contract.`;

  for (const value of NOT_PROTOCOL_IDS) {
    expect(() => call(channel, value), String(value)).toThrow(refused);
  }
  for (const args of [
    [],
    [null],
    [WORKSPACE_ID, WORKSPACE_ID],
    [WORKSPACE_ID, undefined],
    [WORKSPACE_ID, { force: true }],
  ]) {
    expect(() => call(channel, ...args)).toThrow(refused);
  }
  expect(fake.calls).toEqual([]);
});

test("open refuses an ID that is not a lowercase UUIDv7, a wrong type, a missing or an extra argument, before the service is asked", () => {
  const fake = fakeService();
  const { call } = register(fake);
  const channel = INVOKE_CHANNELS.openProject;
  const refused = `The call on ${channel} was refused: the arguments do not match the contract.`;

  for (const value of NOT_PROTOCOL_IDS) {
    expect(() => call(channel, value), String(value)).toThrow(refused);
  }
  for (const args of [
    [],
    [PROJECT_ID, PROJECT_ID],
    [null, null],
    [PROJECT_ID, "extra"],
  ]) {
    expect(() => call(channel, ...args)).toThrow(refused);
  }
  expect(fake.calls).toEqual([]);
});

test("a refused call does not repeat the argument", () => {
  const { call } = register(fakeService());

  let message = "";
  try {
    call(INVOKE_CHANNELS.selectWorkspace, "secret-workspace");
  } catch (error) {
    message = String(error);
  }
  expect(message).toContain("refused");
  expect(message).not.toContain("secret");
});

test("select and open pass a valid ID to the service and answer ok or refused", () => {
  const fake = fakeService();
  const { call } = register(fake);
  const unknown = "019a5b2c-3d4e-7f62-8a1b-2c3d4e5f6a7b";

  expect(call(INVOKE_CHANNELS.openProject, null)).toEqual({ outcome: "ok" });
  expect(call(INVOKE_CHANNELS.openProject, PROJECT_ID)).toEqual({
    outcome: "ok",
  });
  expect(call(INVOKE_CHANNELS.openProject, unknown)).toEqual({
    outcome: "refused",
  });
  expect(call(INVOKE_CHANNELS.selectWorkspace, unknown)).toEqual({
    outcome: "refused",
  });
  expect(call(INVOKE_CHANNELS.selectWorkspace, OTHER_WORKSPACE_ID)).toEqual({
    outcome: "ok",
  });
  expect(fake.calls).toEqual([
    { method: "openProject", args: [null] },
    { method: "openProject", args: [PROJECT_ID] },
    { method: "openProject", args: [unknown] },
    { method: "select", args: [unknown] },
    { method: "select", args: [OTHER_WORKSPACE_ID] },
  ]);
  expect(fake.current().selectedWorkspaceId).toBe(OTHER_WORKSPACE_ID);
  expect(fake.current().openProjectId).toBeNull();
});

test("the actions check every ID with the protocol's ID schemas, also without the contract", () => {
  const fake = fakeService();
  const actions = createWorkspaceActions(fake.service);
  const select = actions.selectWorkspace as (value: unknown) => unknown;
  const open = actions.openProject as (value: unknown) => unknown;

  for (const value of NOT_PROTOCOL_IDS) {
    expect(select(value), String(value)).toEqual({ outcome: "refused" });
    expect(open(value), String(value)).toEqual({ outcome: "refused" });
  }
  expect(fake.calls).toEqual([]);

  expect(select(WORKSPACE_ID)).toEqual({ outcome: "ok" });
  expect(open(PROJECT_ID)).toEqual({ outcome: "ok" });
  expect(open(null)).toEqual({ outcome: "ok" });
  expect(fake.calls.map(({ method }) => method)).toEqual([
    "select",
    "openProject",
    "openProject",
  ]);
  expect(Object.isFrozen(actions)).toBe(true);
});

test("the state holds IDs and names only, as a frozen copy that passes the contract", () => {
  const fake = fakeService();
  const { call } = register(fake);

  expect(call(INVOKE_CHANNELS.getWorkspaceState)).toEqual(VIEW);

  const view = workspaceView(STATE);
  expect(view).toEqual(VIEW);
  expect(JSON.stringify(view)).not.toContain(MEMBER_ID);
  expect(Object.isFrozen(view)).toBe(true);
  expect(Object.isFrozen(view.workspaces)).toBe(true);
  expect(Object.isFrozen(view.projects)).toBe(true);
  for (const item of [...view.workspaces, ...view.projects]) {
    expect(Object.isFrozen(item)).toBe(true);
  }
  // A copy: no part of it is the service's object.
  expect(view.workspaces).not.toBe(STATE.workspaces);
  expect(view.workspaces[0]).not.toBe(STATE.workspaces[0]);
  expect(view.projects).not.toBe(STATE.projects);
  expect(view.projects[0]).not.toBe(STATE.projects[0]);
});

test("the state has a problem only while unavailable", () => {
  const unavailable = workspaceView(
    Object.freeze({ ...STATE, status: "unavailable", problem: "rate_limited" }),
  );
  expect(unavailable).toEqual({
    ...VIEW,
    status: "unavailable",
    problem: "rate_limited",
  });
  expect(WorkspaceViewSchema.parse(unavailable)).toEqual(unavailable);

  for (const status of ["signed_out", "loading", "ready"] as const) {
    const view = workspaceView(
      Object.freeze({ ...STATE, status, problem: "failed" }),
    );
    expect(view).toEqual({ ...VIEW, status });
    expect("problem" in view).toBe(false);
  }
});

test("at most the limit of workspaces and projects crosses, with names cut to the limit", () => {
  const workspaces: WorkspaceSummary[] = Array.from(
    { length: WORKSPACE_LIMITS.workspaces + 5 },
    () => Object.freeze({ id: newUuidV7() as WorkspaceId, name: "Team" }),
  );
  const projects: ProjectSummary[] = Array.from(
    { length: WORKSPACE_LIMITS.projects + 5 },
    () =>
      Object.freeze({
        id: newUuidV7() as ProjectId,
        name: "Project",
        createdByMemberId: MEMBER_ID,
      }),
  );
  // A name over the limit in characters, outside the Basic Multilingual
  // Plane, so that its UTF-16 length is twice the count.
  const longName = "\u{1F600}".repeat(WORKSPACE_LIMITS.name + 1);
  workspaces[0] = Object.freeze({ id: WORKSPACE_ID, name: longName });
  projects[0] = Object.freeze({
    id: PROJECT_ID,
    name: "x".repeat(WORKSPACE_LIMITS.name + 1),
    createdByMemberId: MEMBER_ID,
  });
  const fake = fakeService(Object.freeze({ ...STATE, workspaces, projects }));
  const { call } = register(fake);

  const view = WorkspaceViewSchema.parse(
    call(INVOKE_CHANNELS.getWorkspaceState),
  );
  expect(view.workspaces).toHaveLength(WORKSPACE_LIMITS.workspaces);
  expect(view.projects).toHaveLength(WORKSPACE_LIMITS.projects);
  expect(view.workspaces.map(({ id }) => id)).toEqual(
    workspaces.slice(0, WORKSPACE_LIMITS.workspaces).map(({ id }) => id),
  );
  expect(view.workspaces[0]?.name).toBe(
    "\u{1F600}".repeat(WORKSPACE_LIMITS.name),
  );
  expect(view.projects[0]?.name).toBe("x".repeat(WORKSPACE_LIMITS.name));
  expect(view.workspaces[1]?.name).toBe("Team");
});

test("a subscribed frame receives every later state, parsed by the contract", () => {
  const fake = fakeService();
  const { handlers, errors, call } = register(fake);
  const subscriber = receiver();
  const bystander = receiver();
  const subscribe = handlers.get(INVOKE_CHANNELS.subscribeWorkspaceState);
  expect(subscribe?.(event(frame(DEV_URL), subscriber))).toEqual(VIEW);
  expect(call(INVOKE_CHANNELS.getWorkspaceState)).toEqual(VIEW);

  expect(call(INVOKE_CHANNELS.openProject, null)).toEqual({ outcome: "ok" });
  expect(subscriber.sent).toEqual([
    [
      EVENT_CHANNELS.workspaceStateChanged,
      { ...VIEW, revision: 3, openProjectId: null },
    ],
  ]);
  expect(bystander.sent).toEqual([]);

  // A state that the contract refuses is reported, not sent.
  fake.emit({ ...STATE, revision: 4, selectedWorkspaceId: "workspace" });
  expect(subscriber.sent).toHaveLength(1);
  expect(errors).toEqual(["Sending the workspace state failed."]);
});

/** A window whose events the test fires, like Electron's after "closed". */
function fakeWindow() {
  const listeners = new Map<string, (() => void)[]>();
  let destroyed = false;
  const add = (event: string, listener: () => void) => {
    listeners.set(event, [...(listeners.get(event) ?? []), listener]);
  };
  const contents = { on: add };
  const window: WorkspacePageWindow = {
    get webContents() {
      if (destroyed) {
        throw new Error("Object has been destroyed");
      }
      return contents;
    },
    on: add,
  };
  return {
    window,
    events: () => [...listeners.keys()].sort(),
    fire: (event: string) => {
      if (event === "closed") {
        destroyed = true;
      }
      for (const listener of listeners.get(event) ?? []) {
        listener();
      }
    },
  };
}

test("the open project closes when the window closes, and the selection stays", () => {
  const fake = fakeService();
  const page = fakeWindow();
  closeProjectWithPage(page.window, fake.service);

  expect(page.events()).toEqual([
    "closed",
    "did-start-loading",
    "render-process-gone",
  ]);
  expect(fake.calls).toEqual([]);
  page.fire("closed");
  expect(fake.calls).toEqual([{ method: "openProject", args: [null] }]);
  expect(fake.current().openProjectId).toBeNull();
  expect(fake.current().selectedWorkspaceId).toBe(WORKSPACE_ID);
});

test("the open project closes when the renderer starts loading or reloading, and the selection stays", () => {
  const fake = fakeService();
  const page = fakeWindow();
  closeProjectWithPage(page.window, fake.service);

  page.fire("did-start-loading");
  expect(fake.calls).toEqual([{ method: "openProject", args: [null] }]);
  expect(fake.current().openProjectId).toBeNull();
  expect(fake.current().selectedWorkspaceId).toBe(WORKSPACE_ID);

  // The new page opens a project again; the next reload closes it again.
  expect(fake.service.openProject(PROJECT_ID)).toBe(true);
  page.fire("did-start-loading");
  expect(fake.current().openProjectId).toBeNull();
});

test("the open project closes when the render process is gone, and the selection stays", () => {
  const fake = fakeService();
  const page = fakeWindow();
  closeProjectWithPage(page.window, fake.service);

  page.fire("render-process-gone");
  expect(fake.calls).toEqual([{ method: "openProject", args: [null] }]);
  expect(fake.current().openProjectId).toBeNull();
  expect(fake.current().selectedWorkspaceId).toBe(WORKSPACE_ID);
});

test("a failure to close the open project is reported, not thrown into Electron", () => {
  const errors: string[] = [];
  const page = fakeWindow();
  closeProjectWithPage(
    page.window,
    {
      openProject: () => {
        throw new Error("broken");
      },
    },
    (message) => errors.push(message),
  );

  expect(() => page.fire("render-process-gone")).not.toThrow();
  expect(() => page.fire("closed")).not.toThrow();
  expect(errors).toEqual([
    "Closing the open project failed.",
    "Closing the open project failed.",
  ]);
});
