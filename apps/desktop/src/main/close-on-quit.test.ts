import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import {
  CLOSE_FAILED_MESSAGE,
  closeOnQuit,
  type Closable,
  type ClosingHost,
} from "./close-on-quit.ts";
import { createLocalRuntime } from "./runtime.ts";
import {
  stopRuntimeOnQuit,
  type Defer,
  type QuitHost,
} from "./runtime-lifecycle.ts";

/** An application whose `will-quit` listeners the test calls. */
function fakeHost() {
  const listeners: (() => void)[] = [];
  const host: ClosingHost = {
    on: (event, listener) => {
      expect(event).toBe("will-quit");
      listeners.push(listener);
    },
  };
  function emitWillQuit(): void {
    for (const listener of listeners) {
      listener();
    }
  }
  return { host, listeners, emitWillQuit };
}

/** A closable that notes its name in `closed` when it closes. */
function noting(name: string, closed: string[]): Closable {
  return { close: () => void closed.push(name) };
}

/** A closable whose `close` throws `error`. */
function throwing(error: Error): Closable {
  return {
    close: () => {
      throw error;
    },
  };
}

test("one will-quit listener closes every closable once, in the reverse order of adding", () => {
  const app = fakeHost();
  const errors: unknown[] = [];
  const closables = closeOnQuit(app.host, (message, error) =>
    errors.push([message, error]),
  );
  const closed: string[] = [];
  for (const name of ["service", "service ipc", "other", "other ipc"]) {
    closables.add(noting(name, closed));
  }

  expect(app.listeners).toHaveLength(1);
  expect(closed).toEqual([]);
  app.emitWillQuit();
  expect(closed).toEqual(["other ipc", "other", "service ipc", "service"]);
  app.emitWillQuit();
  expect(closed).toHaveLength(4);
  expect(app.listeners).toHaveLength(1);
  expect(errors).toEqual([]);
});

test("a close that throws is reported with fixed text and the rest still close", () => {
  const app = fakeHost();
  const errors: [string, unknown][] = [];
  const closables = closeOnQuit(app.host, (message, error) =>
    errors.push([message, error]),
  );
  const closed: string[] = [];
  const first = new Error("first");
  const second = new Error("second");
  closables.add(noting("a", closed));
  closables.add(throwing(first));
  closables.add(noting("b", closed));
  closables.add(throwing(second));
  closables.add(noting("c", closed));

  app.emitWillQuit();

  expect(closed).toEqual(["c", "b", "a"]);
  expect(errors).toEqual([
    [CLOSE_FAILED_MESSAGE, second],
    [CLOSE_FAILED_MESSAGE, first],
  ]);
  expect(CLOSE_FAILED_MESSAGE).toBe(
    "A service of the main process failed to close at quit.",
  );
});

test("a report that throws skips no other closable", () => {
  const app = fakeHost();
  const reported: unknown[] = [];
  const closables = closeOnQuit(app.host, (_message, error) => {
    reported.push(error);
    throw new Error("The report failed.");
  });
  const closed: string[] = [];
  const first = new Error("first");
  const second = new Error("second");
  closables.add(noting("a", closed));
  closables.add(throwing(first));
  closables.add(noting("b", closed));
  closables.add(throwing(second));
  closables.add(noting("c", closed));

  expect(() => app.emitWillQuit()).not.toThrow();

  expect(closed).toEqual(["c", "b", "a"]);
  expect(reported).toEqual([second, first]);
});

test("a closable added after the first will-quit closes at once, and only once", () => {
  const app = fakeHost();
  const errors: [string, unknown][] = [];
  const closables = closeOnQuit(app.host, (message, error) =>
    errors.push([message, error]),
  );
  const closed: string[] = [];
  closables.add(noting("before", closed));
  app.emitWillQuit();
  expect(closed).toEqual(["before"]);

  closables.add(noting("after", closed));
  expect(closed).toEqual(["before", "after"]);
  const late = new Error("late");
  expect(() => closables.add(throwing(late))).not.toThrow();
  expect(errors).toEqual([[CLOSE_FAILED_MESSAGE, late]]);

  app.emitWillQuit();
  expect(closed).toEqual(["before", "after"]);
  expect(errors).toHaveLength(1);
});

async function settle(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}

test("with Electron's listener order, the runtime holds back the first quit, the closables close in that quit while it stops, and the second quit closes nothing again", async () => {
  // A real emitter with Node's default limit of 10 listeners, like
  // Electron's `app`.
  const emitter = new EventEmitter();
  const deferred: (() => void)[] = [];
  const defer: Defer = (callback) => {
    deferred.push(callback);
  };
  const events: string[] = [];
  let exited = false;
  function emitWillQuit(): void {
    let prevented = false;
    emitter.emit("will-quit", {
      preventDefault: () => {
        prevented = true;
      },
    });
    if (!prevented) {
      exited = true;
    }
  }
  const host: QuitHost = {
    on: (event, listener) => emitter.on(event, listener),
    quit: () => {
      events.push("quit");
      emitWillQuit();
    },
  };
  const runtime = createLocalRuntime();
  runtime.onStatusChange((status) => events.push(`runtime ${status.state}`));
  stopRuntimeOnQuit(
    host,
    {
      status: () => runtime.status(),
      stop: () => {
        events.push("runtime stop called");
        return runtime.stop();
      },
    },
    defer,
  );
  const closables = closeOnQuit(host, () => undefined);
  const names = Array.from({ length: 30 }, (_, index) => `closable ${index}`);
  for (const name of names) {
    closables.add({ close: () => events.push(`closed ${name}`) });
  }
  await runtime.start();
  events.length = 0;

  expect(emitter.listenerCount("will-quit")).toBe(2);
  expect(emitter.getMaxListeners()).toBe(10);
  emitWillQuit();
  expect(exited).toBe(false);
  await settle();
  expect(deferred).toHaveLength(1);
  for (const callback of deferred.splice(0)) {
    callback();
  }

  // The runtime's listener runs first and starts the stop; the closables
  // close in the same event, before the stop settles, and the second quit,
  // after the stop, closes nothing again.
  expect(events).toEqual([
    "runtime stop called",
    ...names.toReversed().map((name) => `closed ${name}`),
    "runtime stopping",
    "runtime stopped",
    "quit",
  ]);
  expect(exited).toBe(true);
});

/** `source` without its block and line comments. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function mainSource(file: string): string {
  return readFileSync(new URL(file, import.meta.url), "utf8");
}

const ENTRY = withoutComments(mainSource("./index.ts"));

/**
 * The values that the entry point creates and does not add to the list, each
 * with the reason. Every other `const … = create…(` or `register…(` of the
 * entry point is added.
 */
const NOT_ADDED: Readonly<Record<string, string>> = {
  runtime: "stopRuntimeOnQuit stops it and holds back the first quit",
  account: "the account service has no close",
  enforcement: "the enforcement point keeps nothing and has no close",
  guardSession: "a function that guards a session",
};

/** The module that the entry point imports `name` from. */
function importedFrom(name: string): string {
  for (const match of ENTRY.matchAll(
    /import \{([^}]*)\} from "(\.\/[^"]+)";/g,
  )) {
    const names = (match[1] ?? "").split(",").map((part) => part.trim());
    if (names.includes(name)) {
      return match[2] ?? "";
    }
  }
  throw new Error(`The entry point does not import ${name}.`);
}

/**
 * The declared return type of the exported function `name` of `source`, read
 * from its own signature: the match stops at the first `{`, which opens the
 * body. A function without a declared return type throws, and so does one
 * with a `{` in its parameters, which needs a reader that skips them.
 */
function declaredReturnType(source: string, name: string): string {
  const match = new RegExp(
    `export function ${name}\\b[^{]*?\\n\\): ([^\\n]+) \\{\\n`,
  ).exec(source);
  if (match === null) {
    throw new Error(`No declared return type in the signature of ${name}.`);
  }
  return match[1] ?? "";
}

test("the entry point registers no will-quit listener of its own and adds every service and IPC registration that it creates to one list, right after the runtime's listener", () => {
  expect(ENTRY).not.toMatch(/will-quit/);
  expect(ENTRY.match(/\bstopRuntimeOnQuit\(/g)).toHaveLength(1);
  expect(ENTRY.match(/\bcloseOnQuit\(/g)).toHaveLength(1);
  expect(ENTRY).toMatch(
    /stopRuntimeOnQuit\(app, runtime\);\s*const closables = closeOnQuit\(app, \(message, error\) =>\s*console\.error\(message, error\),?\s*\);/,
  );

  const created = [
    ...ENTRY.matchAll(/\bconst (\w+) = (?:create|register)\w*\(/g),
  ].map((match) => match[1] ?? "");
  const added = [...ENTRY.matchAll(/\bclosables\.add\((\w+)\);/g)].map(
    (match) => match[1] ?? "",
  );
  // In the order of creation, so that the list closes them in reverse.
  expect(added).toEqual(created.filter((name) => !(name in NOT_ADDED)));
  expect(added).toEqual(expect.arrayContaining(["connection", "devSwitch"]));
  expect(added.length).toBeGreaterThanOrEqual(23);
  expect(ENTRY.match(/\bclosables\.add\(/g)).toHaveLength(added.length);
  for (const name of Object.keys(NOT_ADDED)) {
    expect(created).toContain(name);
  }
  // Each reason holds.
  expect(ENTRY).toMatch(/const runtime = createLocalRuntime\(/);
  const accountService = /export interface AccountService \{[\s\S]*?\n\}/.exec(
    mainSource("./account.ts"),
  );
  expect(accountService?.[0]).toMatch(/readonly status:/);
  expect(accountService?.[0]).not.toMatch(/^\s*(?:readonly )?close\b/m);
  const enforcementPoint =
    /export interface PermissionEnforcement \{[\s\S]*?\n\}/.exec(
      mainSource("./permissions/enforcement.ts"),
    );
  expect(enforcementPoint?.[0]).toMatch(/\brecheck\(/);
  expect(enforcementPoint?.[0]).not.toMatch(/^\s*(?:readonly )?close\b/m);
  expect(
    declaredReturnType(
      mainSource("./guards.ts"),
      "createSessionGuardInstaller",
    ),
  ).toBe("(session: GuardedSession) => void");

  // A creation or registration whose result is not kept returns nothing to
  // close. This covers every `create…(` or `register…(` call that is not a
  // method, not kept in a `const`, and not passed on as a value right after
  // `(`, `,` or `:`, such as an argument or a property: at the start of a
  // statement, after `void`, or anywhere else.
  const dropped = [
    ...ENTRY.matchAll(
      /(?<!\bconst \w+ = |[(,:.]\s*)\b((?:create|register)\w*)\(/g,
    ),
  ].map((match) => match[1] ?? "");
  expect(dropped).toEqual(
    expect.arrayContaining(["registerRuntimeIpc", "registerWorkspaceIpc"]),
  );
  expect(dropped.length).toBeGreaterThanOrEqual(11);
  for (const name of dropped) {
    expect([
      name,
      declaredReturnType(mainSource(importedFrom(name)), name),
    ]).toEqual([name, "void"]);
  }
});
