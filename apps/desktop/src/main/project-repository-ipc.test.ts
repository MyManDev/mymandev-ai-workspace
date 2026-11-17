import {
  LIMITS,
  MAX_ANSWER_LIST_ITEMS,
  type ProjectId,
  type RepositoryId,
  type WorkspaceId,
} from "@mymandev/protocol";
import { expect, test } from "vitest";
import { EVENT_CHANNELS, INVOKE_CHANNELS } from "../shared/ipc-channels.ts";
import {
  PROJECT_REPOSITORY_LIMITS,
  PROJECT_REPOSITORY_PROBLEMS,
} from "../shared/ipc-contract.ts";
import { WORKSPACE_READ_FAILURES } from "./api-reads.ts";
import type {
  IpcFrame,
  IpcInvokeEvent,
  IpcInvokeListener,
  StatusReceiver,
} from "./ipc.ts";
import {
  PROJECT_REPOSITORY_PUBLISH_INTERVAL_MS,
  projectRepositoriesView,
  registerProjectRepositoryIpc,
} from "./project-repository-ipc.ts";
import type {
  ProjectRepositoryService,
  ProjectRepositoryState,
} from "./repository-links/service.ts";

const DEV_URL = "http://localhost:5173/";

/** A lowercase UUIDv7 that ends in `n`. */
function id(n: number): string {
  return `0192f0a0-7b3c-7d4e-8f50-${n.toString(16).padStart(12, "0")}`;
}

const WORKSPACE = id(0xa1) as WorkspaceId;
const PROJECT = id(0xe1) as ProjectId;
const REPOSITORY = id(0xf1) as RepositoryId;
const MOUNT = "0b9e2f7c-5d0a-4c8e-9f3b-000000000001";

function state(
  overrides: Partial<ProjectRepositoryState> = {},
): ProjectRepositoryState {
  return Object.freeze({
    revision: 1,
    status: "ready",
    workspaceId: WORKSPACE,
    projectId: PROJECT,
    links: "ready",
    repositories: Object.freeze([
      Object.freeze({
        repositoryId: REPOSITORY,
        name: "web app",
        linked: true,
        mountId: MOUNT,
      }),
    ]),
    ...overrides,
  } as ProjectRepositoryState);
}

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

function invokeEvent(
  senderFrame: IpcFrame | null,
  sender: StatusReceiver = receiver(),
): IpcInvokeEvent {
  return { senderFrame, sender };
}

function setup(initial: ProjectRepositoryState = state()) {
  let current = initial;
  const listeners = new Set<(state: ProjectRepositoryState) => void>();
  const calls: { method: string; args: unknown[] }[] = [];
  const timers: { callback: () => void; cancelled: boolean }[] = [];
  const errors: string[] = [];
  const handlers = new Map<string, IpcInvokeListener>();
  const service: Pick<
    ProjectRepositoryService,
    "state" | "onChange" | "register" | "remove" | "link" | "unlink"
  > = {
    state: () => current,
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    register: async (...args) => {
      calls.push({ method: "register", args });
      return { outcome: "ok", repositoryId: REPOSITORY };
    },
    remove: async (...args) => {
      calls.push({ method: "remove", args });
      return {
        outcome: "refused",
        reason: "rate_limited",
        retryAfterMs: 2_000,
      };
    },
    link: async (...args) => {
      calls.push({ method: "link", args });
      return { outcome: "linked" };
    },
    unlink: async (...args) => {
      calls.push({ method: "unlink", args });
      return { outcome: "refused", reason: "not_linked" };
    },
  };
  const ipc = registerProjectRepositoryIpc(
    { handle: (channel, listener) => handlers.set(channel, listener) },
    DEV_URL,
    {
      service,
      scheduleTimer: (callback) => {
        const timer = { callback, cancelled: false };
        timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
      onError: (message) => errors.push(message),
    },
  );
  return {
    ipc,
    handlers,
    calls,
    timers,
    errors,
    listeners,
    setState(next: ProjectRepositoryState) {
      current = next;
      for (const listener of [...listeners]) {
        listener(next);
      }
    },
    invoke(channel: string, ...args: unknown[]) {
      const handler = handlers.get(channel);
      if (handler === undefined) {
        throw new Error(`No handler for ${channel}`);
      }
      return handler(invokeEvent(frame(DEV_URL)), ...args);
    },
  };
}

test("the view holds IDs, names, the link, and the mount ID only, and a problem only while unavailable", () => {
  const view = projectRepositoriesView(
    state({
      // Extra fields of the state never cross.
      ...({ folder: "/home/octocat/secret-web" } as object),
    }),
    7,
  );
  expect(view).toEqual({
    revision: 7,
    status: "ready",
    workspaceId: WORKSPACE,
    projectId: PROJECT,
    links: "ready",
    repositories: [
      {
        repositoryId: REPOSITORY,
        name: "web app",
        linked: true,
        mountId: MOUNT,
      },
    ],
  });
  expect(Object.isFrozen(view)).toBe(true);
  expect(JSON.stringify(view)).not.toContain("secret");

  for (const problem of WORKSPACE_READ_FAILURES) {
    expect(
      projectRepositoriesView(state({ status: "unavailable", problem }), 1),
    ).toMatchObject({ status: "unavailable", problem });
  }
  expect(
    projectRepositoriesView(state({ status: "unavailable" }), 1),
  ).toMatchObject({ problem: "failed" });
  // A repository that is not linked names no mount.
  expect(
    projectRepositoriesView(
      state({
        repositories: [
          {
            repositoryId: REPOSITORY,
            name: "web app",
            linked: false,
            mountId: MOUNT,
          },
        ],
      }),
      1,
    ).repositories[0],
  ).toMatchObject({ linked: false, mountId: null });
});

test("the contract's limits and problems match the protocol and the reads", () => {
  expect(PROJECT_REPOSITORY_LIMITS).toEqual({
    repositories: MAX_ANSWER_LIST_ITEMS,
    name: LIMITS.name,
  });
  expect([...PROJECT_REPOSITORY_PROBLEMS].sort()).toEqual(
    [...WORKSPACE_READ_FAILURES].sort(),
  );
});

test("get and subscribe answer the view, and a change publishes the latest view at most once an interval", async () => {
  const harness = setup();
  const subscriber = receiver();

  expect(harness.invoke(INVOKE_CHANNELS.getProjectRepositoryState)).toEqual(
    projectRepositoriesView(state(), 0),
  );
  const handler = harness.handlers.get(
    INVOKE_CHANNELS.subscribeProjectRepositoryState,
  );
  handler?.(invokeEvent(frame(DEV_URL), subscriber));

  harness.setState(state({ status: "loading", repositories: [] }));
  harness.setState(state());
  expect(harness.timers).toHaveLength(1);
  expect(PROJECT_REPOSITORY_PUBLISH_INTERVAL_MS).toBe(50);
  harness.timers[0]?.callback();
  expect(subscriber.sent).toEqual([
    [
      EVENT_CHANNELS.projectRepositoriesChanged,
      projectRepositoriesView(state(), 2),
    ],
  ]);
});

test("each action passes only its checked values to the service and its parsed answer back", async () => {
  const harness = setup();

  await expect(
    harness.invoke(INVOKE_CHANNELS.registerRepository, PROJECT, "web app"),
  ).resolves.toEqual({ outcome: "ok", repositoryId: REPOSITORY });
  await expect(
    harness.invoke(INVOKE_CHANNELS.removeRepository, PROJECT, REPOSITORY),
  ).resolves.toEqual({
    outcome: "refused",
    reason: "rate_limited",
    retryAfterMs: 2_000,
  });
  await expect(
    harness.invoke(INVOKE_CHANNELS.linkRepository, REPOSITORY, MOUNT),
  ).resolves.toEqual({ outcome: "linked" });
  await expect(
    harness.invoke(INVOKE_CHANNELS.unlinkRepository, REPOSITORY),
  ).resolves.toEqual({ outcome: "refused", reason: "not_linked" });
  expect(harness.calls).toEqual([
    { method: "register", args: [PROJECT, "web app"] },
    { method: "remove", args: [PROJECT, REPOSITORY] },
    { method: "link", args: [REPOSITORY, MOUNT] },
    { method: "unlink", args: [REPOSITORY] },
  ]);
});

test("a foreign sender, a path, or an argument outside the contract is refused before the service runs, without naming the value", () => {
  const harness = setup();
  const secret = "/home/octocat/secret-web";
  const attempts: [string, unknown[]][] = [
    [INVOKE_CHANNELS.registerRepository, [PROJECT]],
    [INVOKE_CHANNELS.registerRepository, [secret, "web"]],
    [INVOKE_CHANNELS.registerRepository, [PROJECT, "web", secret]],
    [INVOKE_CHANNELS.removeRepository, [PROJECT, secret]],
    [INVOKE_CHANNELS.linkRepository, [REPOSITORY, secret]],
    [INVOKE_CHANNELS.linkRepository, [secret, MOUNT]],
    [INVOKE_CHANNELS.unlinkRepository, [secret]],
    [INVOKE_CHANNELS.getProjectRepositoryState, [secret]],
  ];
  for (const [channel, args] of attempts) {
    expect(() => harness.invoke(channel, ...args), channel).toThrow(
      /arguments do not match the contract/u,
    );
    try {
      harness.invoke(channel, ...args);
    } catch (error) {
      expect(String(error)).not.toContain("secret");
    }
  }
  const handler = harness.handlers.get(INVOKE_CHANNELS.linkRepository);
  expect(() =>
    handler?.(invokeEvent(frame("https://evil.example/")), REPOSITORY, MOUNT),
  ).toThrow(/sender is not the application/u);
  expect(harness.calls).toEqual([]);
});

test("a view that the contract refuses is reported with a fixed message, and close stops publishing", () => {
  const harness = setup();
  harness.handlers.get(INVOKE_CHANNELS.subscribeProjectRepositoryState)?.(
    invokeEvent(frame(DEV_URL), receiver()),
  );
  harness.setState(
    state({
      repositories: Array.from(
        { length: PROJECT_REPOSITORY_LIMITS.repositories + 1 },
        () => ({
          repositoryId: REPOSITORY,
          name: "web app",
          linked: false,
          mountId: null,
        }),
      ),
    }),
  );
  harness.timers[0]?.callback();
  expect(harness.errors).toEqual(["Sending the project repositories failed."]);

  harness.setState(state());
  harness.ipc.close();
  expect(harness.timers.at(-1)?.cancelled).toBe(true);
  expect(harness.listeners.size).toBe(0);
});
