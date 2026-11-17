import type { ProjectId, WorkspaceId } from "@mymandev/protocol";
import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { INVOKE_CHANNELS } from "../shared/ipc-channels.ts";
import {
  COPY_WORKSPACE_ID_REFUSALS,
  CopyWorkspaceIdResultSchema,
} from "../shared/ipc-contract.ts";
import { APP_ENTRY_URL } from "./app-protocol.ts";
import type { IpcFrame, IpcInvokeListener, StatusReceiver } from "./ipc.ts";
import type { WorkspaceState } from "./workspace/service.ts";
import {
  copyWorkspaceId,
  registerWorkspaceIdIpc,
  type WorkspaceIdClipboard,
} from "./workspace-id-ipc.ts";

const DEV_URL = "http://localhost:5173/";

const WORKSPACE_ID = "019a5b2c-3d4e-7f60-8a1b-2c3d4e5f6a7b" as WorkspaceId;
const OTHER_WORKSPACE_ID =
  "019a5b2c-3d4e-7f61-8a1b-2c3d4e5f6a7b" as WorkspaceId;
/** A lowercase UUIDv7 that the list does not hold. */
const UNLISTED_ID = "019a5b2c-3d4e-7f62-8a1b-2c3d4e5f6a7b";
const PROJECT_ID = "019a5b2c-3d4e-7f60-9a1b-2c3d4e5f6a7c" as ProjectId;

const STATE: WorkspaceState = Object.freeze({
  revision: 2,
  status: "ready",
  workspaces: Object.freeze([
    Object.freeze({ id: WORKSPACE_ID, name: "Team" }),
    Object.freeze({ id: OTHER_WORKSPACE_ID, name: "Other team" }),
  ]),
  selectedWorkspaceId: WORKSPACE_ID,
  projects: Object.freeze([]),
  openProjectId: null,
});

const SIGNED_OUT: WorkspaceState = Object.freeze({
  revision: 3,
  status: "signed_out",
  workspaces: Object.freeze([]),
  selectedWorkspaceId: null,
  projects: Object.freeze([]),
  openProjectId: null,
});

/** IDs that are not a lowercase UUIDv7, and values that are not strings. */
const NOT_PROTOCOL_IDS: readonly unknown[] = [
  "",
  "workspace",
  // A UUID of version 4, and of version 7 with a wrong variant.
  "0b9e2f7c-5d0a-4c8e-9f3b-2a1d6e4c8b70",
  "019a5b2c-3d4e-7f60-ca1b-2c3d4e5f6a7b",
  WORKSPACE_ID.toUpperCase(),
  `${WORKSPACE_ID} `,
  ` ${WORKSPACE_ID}`,
  `${WORKSPACE_ID}\n`,
  `${WORKSPACE_ID}\u0000`,
  WORKSPACE_ID.replaceAll("-", ""),
  `${WORKSPACE_ID}${"0".repeat(100_000)}`,
  "x".repeat(1_000_000),
  1,
  0n,
  true,
  null,
  {},
  { id: WORKSPACE_ID },
  [WORKSPACE_ID],
  undefined,
];

function frame(url: string, parent: IpcFrame | null = null): IpcFrame {
  return { url, parent, detached: false, isDestroyed: () => false };
}

function receiver(url: string = DEV_URL): StatusReceiver {
  return {
    mainFrame: frame(url),
    isDestroyed: () => false,
    send: () => undefined,
    once: () => undefined,
  };
}

/**
 * A clipboard like Electron's, whose `writeText` returns a promise: it
 * records every write and resolves, rejects with `failure`, or, with
 * `throws`, throws before it returns a promise.
 */
function fakeClipboard(failure?: Error, throws = false) {
  const written: string[] = [];
  const clipboard: WorkspaceIdClipboard = {
    writeText: (text) => {
      if (failure !== undefined) {
        if (throws) {
          throw failure;
        }
        return Promise.reject(failure);
      }
      written.push(text);
      return Promise.resolve();
    },
  };
  return { clipboard, written };
}

/** A workspace service that records every read of its state. */
function fakeWorkspaces(initial: WorkspaceState = STATE) {
  let state = initial;
  let reads = 0;
  return {
    workspaces: {
      state: () => {
        reads += 1;
        return state;
      },
    },
    set: (next: WorkspaceState) => {
      state = next;
    },
    reads: () => reads,
  };
}

function register(
  options: {
    readonly state?: WorkspaceState;
    readonly clipboard?: WorkspaceIdClipboard;
    readonly failure?: Error;
    readonly appUrl?: string;
  } = {},
) {
  const service = fakeWorkspaces(options.state);
  const fake = fakeClipboard(options.failure);
  const errors: { message: string; error: unknown }[] = [];
  const handlers = new Map<string, IpcInvokeListener>();
  const appUrl = options.appUrl ?? DEV_URL;
  registerWorkspaceIdIpc(
    { handle: (channel, listener) => handlers.set(channel, listener) },
    appUrl,
    {
      workspaces: service.workspaces,
      clipboard: options.clipboard ?? fake.clipboard,
      onError: (message, error) => errors.push({ message, error }),
    },
  );
  const call = (...args: unknown[]) => {
    const handler = handlers.get(INVOKE_CHANNELS.copyWorkspaceId);
    if (handler === undefined) {
      throw new Error("No handler for the copy channel.");
    }
    return handler(
      { senderFrame: frame(appUrl), sender: receiver(appUrl) },
      ...args,
    ) as Promise<unknown>;
  };
  return { handlers, call, written: fake.written, errors, service };
}

/** The options of a direct call of the action, with a recording reporter. */
function directOptions(clipboard: WorkspaceIdClipboard) {
  const service = fakeWorkspaces();
  const errors: string[] = [];
  return {
    service,
    errors,
    options: {
      workspaces: service.workspaces,
      clipboard,
      onError: (message: string) => errors.push(message),
    },
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}

const REFUSED_ARGUMENTS = `The call on ${INVOKE_CHANNELS.copyWorkspaceId} was refused: the arguments do not match the contract.`;

test("only the copy channel is registered", () => {
  const { handlers } = register();

  expect([...handlers.keys()]).toEqual([INVOKE_CHANNELS.copyWorkspaceId]);
  expect(INVOKE_CHANNELS.copyWorkspaceId).toBe("workspaces:copy-id");
});

test("a foreign sender is refused before the list is read or anything is written", () => {
  const { handlers, written, service } = register({ appUrl: APP_ENTRY_URL });
  const handler = handlers.get(INVOKE_CHANNELS.copyWorkspaceId);

  for (const senderFrame of [
    null,
    frame("https://example.invalid/"),
    frame(APP_ENTRY_URL, frame(APP_ENTRY_URL)),
    frame(DEV_URL),
    { ...frame(APP_ENTRY_URL), detached: true },
  ]) {
    expect(() =>
      handler?.({ senderFrame, sender: receiver(APP_ENTRY_URL) }, WORKSPACE_ID),
    ).toThrow(
      `The call on ${INVOKE_CHANNELS.copyWorkspaceId} was refused: the sender is not the application.`,
    );
  }
  expect(service.reads()).toBe(0);
  expect(written).toEqual([]);
});

test("an ID that is not a lowercase UUIDv7, a wrong type, and a missing or an extra argument are refused before the list is read or anything is written", () => {
  const { call, written, service } = register();

  for (const value of NOT_PROTOCOL_IDS) {
    expect(() => call(value), String(value)).toThrow(REFUSED_ARGUMENTS);
  }
  for (const args of [
    [],
    [WORKSPACE_ID, WORKSPACE_ID],
    [WORKSPACE_ID, undefined],
    [WORKSPACE_ID, "text for the clipboard"],
    [WORKSPACE_ID, { text: "text for the clipboard" }],
  ]) {
    expect(() => call(...args)).toThrow(REFUSED_ARGUMENTS);
  }
  expect(service.reads()).toBe(0);
  expect(written).toEqual([]);
});

test("a refused call does not repeat the argument", () => {
  const { call } = register();

  let message = "";
  try {
    void call("secret-text-for-the-clipboard");
  } catch (error) {
    message = String(error);
  }
  expect(message).toContain("refused");
  expect(message).not.toContain("secret");
});

test("the ID of every workspace of the list is written once, exactly, selected or not, and answers ok", async () => {
  const { call, written } = register();

  await expect(call(WORKSPACE_ID)).resolves.toEqual({ outcome: "ok" });
  await expect(call(OTHER_WORKSPACE_ID)).resolves.toEqual({ outcome: "ok" });
  expect(written).toEqual([WORKSPACE_ID, OTHER_WORKSPACE_ID]);
});

test("the answer waits for the write: it stays open until the write resolves, and answers ok only then", async () => {
  let finish: (() => void) | undefined;
  const written: string[] = [];
  const clipboard: WorkspaceIdClipboard = {
    writeText: (text) => {
      written.push(text);
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
  };
  const { call } = register({ clipboard });

  let answer: unknown = "open";
  void call(WORKSPACE_ID).then((value) => {
    answer = value;
  });
  await settle();
  expect(written).toEqual([WORKSPACE_ID]);
  expect(answer).toBe("open");
  finish?.();
  await settle();
  expect(answer).toEqual({ outcome: "ok" });
});

test("a write that rejects later, or throws at once, answers failed and is reported with a fixed message that names no ID", async () => {
  const failure = new Error("Another application holds the clipboard.");
  let refuse: ((error: Error) => void) | undefined;
  const pending: WorkspaceIdClipboard = {
    writeText: () =>
      new Promise<void>((_resolve, reject) => {
        refuse = reject;
      }),
  };
  const later = register({ clipboard: pending });

  let answer: unknown = "open";
  void later.call(WORKSPACE_ID).then((value) => {
    answer = value;
  });
  await settle();
  expect(answer).toBe("open");
  expect(later.errors).toEqual([]);
  refuse?.(failure);
  await settle();
  expect(answer).toEqual({ outcome: "failed" });
  expect(later.errors).toEqual([
    { message: "Copying the workspace ID failed.", error: failure },
  ]);

  const rejected = register({ failure });
  await expect(rejected.call(WORKSPACE_ID)).resolves.toEqual({
    outcome: "failed",
  });
  expect(rejected.errors).toEqual([
    { message: "Copying the workspace ID failed.", error: failure },
  ]);

  const throwing = register({
    clipboard: fakeClipboard(failure, true).clipboard,
  });
  await expect(throwing.call(WORKSPACE_ID)).resolves.toEqual({
    outcome: "failed",
  });
  expect(throwing.errors).toEqual([
    { message: "Copying the workspace ID failed.", error: failure },
  ]);
  for (const { message } of [...later.errors, ...throwing.errors]) {
    expect(message).not.toContain(WORKSPACE_ID);
  }
});

test("a workspace that the list does not hold is refused as not_found, and nothing is written", async () => {
  const { call, written, service } = register();
  const notFound = { outcome: "refused", reason: "not_found" };

  // A project's ID, an unknown ID, and a workspace that left the list.
  await expect(call(PROJECT_ID)).resolves.toEqual(notFound);
  await expect(call(UNLISTED_ID)).resolves.toEqual(notFound);
  service.set({ ...STATE, workspaces: STATE.workspaces.slice(1) });
  await expect(call(WORKSPACE_ID)).resolves.toEqual(notFound);
  expect(written).toEqual([]);
  // The list is read at each call, so a workspace that joins it can be copied.
  service.set(STATE);
  await expect(call(WORKSPACE_ID)).resolves.toEqual({ outcome: "ok" });
  expect(written).toEqual([WORKSPACE_ID]);
});

test("without a signed-in device the list is empty, so every ID is refused as not_found", async () => {
  const { call, written } = register({ state: SIGNED_OUT });

  for (const id of [WORKSPACE_ID, OTHER_WORKSPACE_ID]) {
    await expect(call(id)).resolves.toEqual({
      outcome: "refused",
      reason: "not_found",
    });
  }
  expect(written).toEqual([]);
});

test("the action checks the ID with the protocol's ID schema, also without the contract, before the list is read", async () => {
  const { clipboard, written } = fakeClipboard();
  const { service, options } = directOptions(clipboard);

  for (const value of NOT_PROTOCOL_IDS) {
    await expect(
      copyWorkspaceId(value as string, options),
      String(value),
    ).resolves.toEqual({ outcome: "refused", reason: "invalid" });
  }
  expect(service.reads()).toBe(0);
  expect(written).toEqual([]);
});

test("every answer is a fixed outcome that the contract accepts, and the contract refuses any other", async () => {
  const { call } = register();
  const answers = [
    await call(WORKSPACE_ID),
    await call(UNLISTED_ID),
    await register({ failure: new Error("no") }).call(WORKSPACE_ID),
    await copyWorkspaceId(
      "x",
      directOptions(fakeClipboard().clipboard).options,
    ),
  ];

  expect(answers).toEqual([
    { outcome: "ok" },
    { outcome: "refused", reason: "not_found" },
    { outcome: "failed" },
    { outcome: "refused", reason: "invalid" },
  ]);
  for (const answer of answers) {
    expect(CopyWorkspaceIdResultSchema.parse(answer)).toEqual(answer);
  }
  expect(COPY_WORKSPACE_ID_REFUSALS).toEqual(["invalid", "not_found"]);
});

/**
 * The sources of a folder of `src`, without the tests, as text, by their
 * path in that folder with forward slashes.
 */
function sourcesOf(folder: string): Readonly<Record<string, string>> {
  const url = new URL(folder, import.meta.url);
  return Object.fromEntries(
    readdirSync(url, { recursive: true, encoding: "utf8" })
      .map((file) => file.replaceAll("\\", "/"))
      .filter(
        (file) =>
          /\.(?:ts|tsx|mts|cts)$/.test(file) && !/\.test\.[^/]+$/.test(file),
      )
      .map((file) => [`./${file}`, readFileSync(new URL(file, url), "utf8")]),
  );
}

const MAIN_SOURCES = sourcesOf("./");
const PRELOAD_SOURCES = sourcesOf("../preload/");
const SHARED_SOURCES = sourcesOf("../shared/");

/** `source` without its block and line comments. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** The files of `sources` whose code, without comments, names the clipboard. */
function namingTheClipboard(sources: Readonly<Record<string, string>>) {
  return Object.entries(sources)
    .filter(([, source]) => /clipboard/i.test(withoutComments(source)))
    .map(([file]) => file)
    .sort();
}

test("the entry point registers the copy with Electron's clipboard and its own reporter, and no other module of the main process, the preload script, or the shared code reaches the clipboard", () => {
  expect(Object.keys(MAIN_SOURCES)).toContain("./workspace/service.ts");
  expect(Object.keys(MAIN_SOURCES)).not.toContain("./workspace-id-ipc.test.ts");
  expect(Object.keys(PRELOAD_SOURCES).sort()).toEqual([
    "./bridge.ts",
    "./index.ts",
  ]);
  expect(Object.keys(SHARED_SOURCES)).toContain("./ipc-contract.ts");
  expect(Object.keys(SHARED_SOURCES)).toContain("./desktop-bridge.ts");
  expect(Object.keys(SHARED_SOURCES)).not.toContain("./ipc-contract.test.ts");
  const entry = withoutComments(MAIN_SOURCES["./index.ts"] ?? "");
  expect(entry).toMatch(/import \{[^}]*\bclipboard,[^}]*\} from "electron";/);
  expect(entry).toMatch(
    /registerWorkspaceIdIpc\(ipcMain, rendererUrl, \{\s*workspaces,\s*clipboard,\s*onError: \(message, error\) => console\.error\(message, error\),?\s*\}\);/,
  );
  expect(namingTheClipboard(MAIN_SOURCES)).toEqual([
    "./index.ts",
    "./workspace-id-ipc.ts",
  ]);
  // In the entry point, only the import and the registration name it.
  expect(entry.match(/\bclipboard\b/g)).toHaveLength(2);
  expect(namingTheClipboard(PRELOAD_SOURCES)).toEqual([]);
  expect(namingTheClipboard(SHARED_SOURCES)).toEqual([]);
  // The check finds a use in code, but not in a comment.
  expect(
    namingTheClipboard({
      "./comment.ts": "// The clipboard is named here only.\nexport {};\n",
      "./code.ts": 'import { clipboard } from "electron";\n',
    }),
  ).toEqual(["./code.ts"]);
});
