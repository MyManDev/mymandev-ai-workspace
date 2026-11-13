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

/** A clipboard that records every write, or throws on each one. */
function fakeClipboard(failure?: Error) {
  const written: string[] = [];
  const clipboard: WorkspaceIdClipboard = {
    writeText: (text) => {
      if (failure !== undefined) {
        throw failure;
      }
      written.push(text);
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
    readonly failure?: Error;
    readonly appUrl?: string;
  } = {},
) {
  const service = fakeWorkspaces(options.state);
  const { clipboard, written } = fakeClipboard(options.failure);
  const errors: { message: string; error: unknown }[] = [];
  const handlers = new Map<string, IpcInvokeListener>();
  const appUrl = options.appUrl ?? DEV_URL;
  registerWorkspaceIdIpc(
    { handle: (channel, listener) => handlers.set(channel, listener) },
    appUrl,
    {
      workspaces: service.workspaces,
      clipboard,
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
    );
  };
  return { handlers, call, written, errors, service };
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
    call("secret-text-for-the-clipboard");
  } catch (error) {
    message = String(error);
  }
  expect(message).toContain("refused");
  expect(message).not.toContain("secret");
});

test("the ID of every workspace of the list is written once, exactly, selected or not, and answers ok", () => {
  const { call, written } = register();

  expect(call(WORKSPACE_ID)).toEqual({ outcome: "ok" });
  expect(call(OTHER_WORKSPACE_ID)).toEqual({ outcome: "ok" });
  expect(written).toEqual([WORKSPACE_ID, OTHER_WORKSPACE_ID]);
});

test("a workspace that the list does not hold is refused as not_found, and nothing is written", () => {
  const { call, written, service } = register();

  // A project's ID, an unknown ID, and a workspace that left the list.
  expect(call(PROJECT_ID)).toEqual({
    outcome: "refused",
    reason: "not_found",
  });
  expect(call(UNLISTED_ID)).toEqual({
    outcome: "refused",
    reason: "not_found",
  });
  service.set({ ...STATE, workspaces: STATE.workspaces.slice(1) });
  expect(call(WORKSPACE_ID)).toEqual({
    outcome: "refused",
    reason: "not_found",
  });
  expect(written).toEqual([]);
  // The list is read at each call, so a workspace that joins it can be copied.
  service.set(STATE);
  expect(call(WORKSPACE_ID)).toEqual({ outcome: "ok" });
  expect(written).toEqual([WORKSPACE_ID]);
});

test("without a signed-in device the list is empty, so every ID is refused as not_found", () => {
  const { call, written } = register({ state: SIGNED_OUT });

  for (const id of [WORKSPACE_ID, OTHER_WORKSPACE_ID]) {
    expect(call(id)).toEqual({ outcome: "refused", reason: "not_found" });
  }
  expect(written).toEqual([]);
});

test("the action checks the ID with the protocol's ID schema, also without the contract, before the list is read", () => {
  const service = fakeWorkspaces();
  const { clipboard, written } = fakeClipboard();

  for (const value of NOT_PROTOCOL_IDS) {
    expect(
      copyWorkspaceId(value as string, {
        workspaces: service.workspaces,
        clipboard,
      }),
      String(value),
    ).toEqual({ outcome: "refused", reason: "invalid" });
  }
  expect(service.reads()).toBe(0);
  expect(written).toEqual([]);
});

test("a write that the system refuses answers failed and is reported with a fixed message that names no ID", () => {
  const failure = new Error("The clipboard is not available.");
  const { call, errors } = register({ failure });

  expect(call(WORKSPACE_ID)).toEqual({ outcome: "failed" });
  expect(errors).toEqual([
    { message: "Copying the workspace ID failed.", error: failure },
  ]);
  expect(errors[0]?.message).not.toContain(WORKSPACE_ID);
});

test("every answer is a fixed outcome that the contract accepts, and the contract refuses any other", () => {
  const { call } = register();
  const answers = [call(WORKSPACE_ID), call(UNLISTED_ID)];
  answers.push(register({ failure: new Error("no") }).call(WORKSPACE_ID));
  answers.push(
    copyWorkspaceId("x", {
      workspaces: fakeWorkspaces().workspaces,
      clipboard: fakeClipboard().clipboard,
    }),
  );

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

// The main process's sources, without the tests, as text, by their path
// in this folder with forward slashes.
const MAIN_FOLDER = new URL("./", import.meta.url);
const MAIN_SOURCES: Readonly<Record<string, string>> = Object.fromEntries(
  readdirSync(MAIN_FOLDER, { recursive: true, encoding: "utf8" })
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .map((file) => [
      `./${file}`,
      readFileSync(new URL(file, MAIN_FOLDER), "utf8"),
    ]),
);

/** `source` without its block and line comments. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

test("the entry point registers the copy with Electron's clipboard, and no other module of the main process reaches the clipboard", () => {
  expect(Object.keys(MAIN_SOURCES)).toContain("./workspace/service.ts");
  expect(Object.keys(MAIN_SOURCES)).not.toContain("./workspace-id-ipc.test.ts");
  const entry = withoutComments(MAIN_SOURCES["./index.ts"] ?? "");
  expect(entry).toMatch(/import \{[^}]*\bclipboard,[^}]*\} from "electron";/);
  expect(entry).toMatch(
    /registerWorkspaceIdIpc\(ipcMain, rendererUrl, \{\s*workspaces,\s*clipboard,?\s*\}\);/,
  );
  const reaching = Object.entries(MAIN_SOURCES)
    .filter(([, source]) => /clipboard/i.test(withoutComments(source)))
    .map(([file]) => file)
    .sort();
  expect(reaching).toEqual(["./index.ts", "./workspace-id-ipc.ts"]);
  // In the entry point, only the import and the registration name it.
  expect(entry.match(/\bclipboard\b/g)).toHaveLength(2);
});
