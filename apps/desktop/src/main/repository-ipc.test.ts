import { expect, test } from "vitest";
import { EVENT_CHANNELS, INVOKE_CHANNELS } from "../shared/ipc-channels.ts";
import type { MountResult, RepositoryList } from "../shared/ipc-contract.ts";
import { APP_ENTRY_URL } from "./app-protocol.ts";
import type {
  IpcFrame,
  IpcInvokeEvent,
  IpcInvokeListener,
  StatusReceiver,
} from "./ipc.ts";
import type { RepositoryService } from "./repositories.ts";
import { registerRepositoryIpc } from "./repository-ipc.ts";
import { FOLDER_DIALOG_OPTIONS, selectedFolder } from "./repository-system.ts";

const DEV_URL = "http://localhost:5173/";
const MOUNT_ID = "0b9e2f7c-5d0a-4c8e-9f3b-2a1d6e4c8b70";
const EMPTY: RepositoryList = { revision: 0, repositories: [] };

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

function fakeService(mountResult: () => Promise<MountResult>) {
  const calls: { method: string; args: unknown[] }[] = [];
  const listeners: ((list: RepositoryList) => void)[] = [];
  const service: Pick<
    RepositoryService,
    "list" | "mount" | "unmount" | "onChange"
  > = {
    list: () => {
      calls.push({ method: "list", args: [] });
      return EMPTY;
    },
    mount: (folder) => {
      calls.push({ method: "mount", args: [folder] });
      return mountResult();
    },
    unmount: (mountId) => {
      calls.push({ method: "unmount", args: [mountId] });
      return mountId === MOUNT_ID;
    },
    onChange: (listener) => {
      listeners.push(listener);
      return () => undefined;
    },
  };
  return {
    service,
    calls,
    change: (list: RepositoryList) => {
      for (const listener of listeners) {
        listener(list);
      }
    },
  };
}

function register(
  selectFolder: () => Promise<string | undefined> = async () =>
    "/home/user/project",
  mountResult: () => Promise<MountResult> = async () => ({
    outcome: "mounted",
    mountId: MOUNT_ID,
  }),
) {
  const handlers = new Map<string, IpcInvokeListener>();
  const fake = fakeService(mountResult);
  const errors: string[] = [];
  let dialogs = 0;
  registerRepositoryIpc(
    {
      handle: (channel, listener) => {
        expect(handlers.has(channel)).toBe(false);
        handlers.set(channel, listener);
      },
    },
    DEV_URL,
    fake.service,
    () => {
      dialogs += 1;
      return selectFolder();
    },
    (message) => errors.push(message),
  );
  const call = (
    channel: string,
    ipcEvent: IpcInvokeEvent,
    ...args: unknown[]
  ) => {
    const handler = handlers.get(channel);
    if (handler === undefined) {
      throw new Error(`no handler for ${channel}`);
    }
    return handler(ipcEvent, ...args);
  };
  return { handlers, call, ...fake, errors, dialogs: () => dialogs };
}

const REPOSITORY_CHANNELS = Object.values(INVOKE_CHANNELS).filter((channel) =>
  channel.startsWith("repositories:"),
);

test("a handler is registered for every repository channel and nothing else", () => {
  const { handlers } = register();

  expect(REPOSITORY_CHANNELS).toHaveLength(4);
  expect([...handlers.keys()].sort()).toEqual([...REPOSITORY_CHANNELS].sort());
});

test("every repository handler refuses a foreign sender before anything runs", () => {
  const { call, calls, dialogs } = register();

  for (const channel of REPOSITORY_CHANNELS) {
    for (const senderFrame of [
      frame("https://example.com/"),
      frame(APP_ENTRY_URL),
      frame("file:///home/user/evil.html"),
      frame(DEV_URL, frame(DEV_URL)),
      null,
    ]) {
      const args =
        channel === INVOKE_CHANNELS.unmountRepository ? [MOUNT_ID] : [];
      expect(() => call(channel, event(senderFrame), ...args)).toThrow(
        `The call on ${channel} was refused: the sender is not the application.`,
      );
    }
  }
  expect(calls).toEqual([]);
  expect(dialogs()).toBe(0);
});

test("every repository handler refuses arguments that break the contract", () => {
  const { call, calls, dialogs } = register();

  for (const [channel, argumentLists] of [
    [INVOKE_CHANNELS.listRepositories, [["x"], [undefined]]],
    [INVOKE_CHANNELS.subscribeRepositories, [[{}]]],
    [
      INVOKE_CHANNELS.mountRepository,
      [["/home/user/project"], [{ path: "/etc" }], [undefined]],
    ],
    [
      INVOKE_CHANNELS.unmountRepository,
      [[], ["/home/user/project"], [MOUNT_ID, "extra"], [1], [null]],
    ],
  ] as const) {
    for (const args of argumentLists) {
      expect(() => call(channel, event(frame(DEV_URL)), ...args)).toThrow(
        `The call on ${channel} was refused: the arguments do not match the contract.`,
      );
    }
  }
  expect(calls).toEqual([]);
  expect(dialogs()).toBe(0);
});

test("mount asks with the dialog and mounts the selected folder", async () => {
  const { call, calls, dialogs } = register();

  await expect(
    call(INVOKE_CHANNELS.mountRepository, event(frame(DEV_URL))),
  ).resolves.toEqual({ outcome: "mounted", mountId: MOUNT_ID });
  expect(dialogs()).toBe(1);
  expect(calls).toEqual([{ method: "mount", args: ["/home/user/project"] }]);
});

test("a cancelled dialog mounts nothing", async () => {
  const { call, calls } = register(async () => undefined);

  await expect(
    call(INVOKE_CHANNELS.mountRepository, event(frame(DEV_URL))),
  ).resolves.toEqual({ outcome: "cancelled" });
  expect(calls).toEqual([]);
});

test("a second mount while the dialog is open is refused as busy", async () => {
  let close: (folder: string | undefined) => void = () => undefined;
  const { call, dialogs } = register(
    () =>
      new Promise((resolve) => {
        close = resolve;
      }),
  );

  const first = call(INVOKE_CHANNELS.mountRepository, event(frame(DEV_URL)));
  await expect(
    call(INVOKE_CHANNELS.mountRepository, event(frame(DEV_URL))),
  ).resolves.toEqual({ outcome: "refused", reason: "busy" });
  close(undefined);
  await expect(first).resolves.toEqual({ outcome: "cancelled" });
  expect(dialogs()).toBe(1);

  // The dialog can open again afterwards.
  void call(INVOKE_CHANNELS.mountRepository, event(frame(DEV_URL)));
  expect(dialogs()).toBe(2);
});

test("a failing dialog or service is refused as failed, without details", async () => {
  const dialogFails = register(async () => {
    throw new Error("/home/user/secret");
  });
  await expect(
    dialogFails.call(INVOKE_CHANNELS.mountRepository, event(frame(DEV_URL))),
  ).resolves.toEqual({ outcome: "refused", reason: "failed" });
  expect(dialogFails.errors).toEqual(["Mounting a repository failed."]);

  const serviceFails = register(undefined, async () => {
    throw new Error("boom");
  });
  await expect(
    serviceFails.call(INVOKE_CHANNELS.mountRepository, event(frame(DEV_URL))),
  ).resolves.toEqual({ outcome: "refused", reason: "failed" });
});

test("unmount passes the validated mount ID to the service", () => {
  const { call, calls } = register();

  expect(
    call(INVOKE_CHANNELS.unmountRepository, event(frame(DEV_URL)), MOUNT_ID),
  ).toBe(true);
  expect(calls).toEqual([{ method: "unmount", args: [MOUNT_ID] }]);
});

test("list and subscribe answer with the list, and only subscribers get changes", () => {
  const { call, change } = register();
  const subscriber = receiver();
  const bystander = receiver();

  expect(
    call(INVOKE_CHANNELS.listRepositories, event(frame(DEV_URL), bystander)),
  ).toEqual(EMPTY);
  expect(
    call(
      INVOKE_CHANNELS.subscribeRepositories,
      event(frame(DEV_URL), subscriber),
    ),
  ).toEqual(EMPTY);
  const next = { revision: 1, repositories: [], extra: "dropped" };
  change(next as RepositoryList);

  expect(subscriber.sent).toEqual([
    [EVENT_CHANNELS.repositoriesChanged, { revision: 1, repositories: [] }],
  ]);
  expect(bystander.sent).toEqual([]);
});

test("a list that breaks the contract is not sent, and the error is reported", () => {
  const { call, change, errors } = register();
  const subscriber = receiver();
  call(
    INVOKE_CHANNELS.subscribeRepositories,
    event(frame(DEV_URL), subscriber),
  );

  change({ revision: -1, repositories: [] });

  expect(subscriber.sent).toEqual([]);
  expect(errors).toEqual(["Sending the repository list failed."]);
});

test("the folder dialog selects one existing folder and creates nothing", () => {
  expect(FOLDER_DIALOG_OPTIONS.properties).toEqual([
    "openDirectory",
    "dontAddToRecent",
  ]);
  for (const property of [
    "openFile",
    "multiSelections",
    "createDirectory",
    "promptToCreate",
  ]) {
    expect(FOLDER_DIALOG_OPTIONS.properties).not.toContain(property);
  }
  expect(Object.isFrozen(FOLDER_DIALOG_OPTIONS)).toBe(true);
  expect(Object.isFrozen(FOLDER_DIALOG_OPTIONS.properties)).toBe(true);

  expect(selectedFolder({ canceled: false, filePaths: ["/home/user/p"] })).toBe(
    "/home/user/p",
  );
  expect(
    selectedFolder({ canceled: true, filePaths: ["/home/user/p"] }),
  ).toBeUndefined();
  expect(selectedFolder({ canceled: false, filePaths: [] })).toBeUndefined();
  expect(
    selectedFolder({ canceled: false, filePaths: ["/a", "/b"] }),
  ).toBeUndefined();
});
