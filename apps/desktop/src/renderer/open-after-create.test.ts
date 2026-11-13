// "Open this workspace" and "Open this project" through the real `App`
// (the Project Manager's decision of 2026-11-12 on #95). The tests run
// without a DOM, so React's hooks are replaced by a small synchronous
// stand-in: `App` is called as a function, its effects run after each
// call, and a state change calls it again. The returned elements are not
// rendered; the tests read the props that `App` passes to its children.
// This checks `App`'s wiring of the paths and the `useCreation` hook: the
// button offered, the click, and the focus once the button leaves.
//
// The stand-in knows six hooks only: useState, useReducer, useMemo,
// useCallback, useRef, and useEffect. Any other hook of React throws a clear
// error here, so that a hook that `App` starts to use needs a stand-in
// first instead of reaching React without a renderer.
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { WorkspaceBridge } from "../shared/desktop-bridge.ts";
import type {
  CreateProjectResult,
  CreateWorkspaceResult,
  WorkspaceView,
} from "../shared/ipc-contract.ts";

const hooks = vi.hoisted(() => {
  interface Slot {
    value?: unknown;
    deps?: readonly unknown[] | undefined;
    cleanup?: (() => void) | undefined;
    set?: (next: unknown) => void;
  }
  const store = {
    slots: [] as Slot[],
    index: 0,
    effects: [] as (() => void)[],
    dirty: false,
  };
  const changed = (
    before: readonly unknown[] | undefined,
    after: readonly unknown[] | undefined,
  ) =>
    before === undefined ||
    after === undefined ||
    before.length !== after.length ||
    before.some((value, index) => !Object.is(value, after[index]));
  const slot = (): Slot => {
    const index = store.index;
    store.index += 1;
    store.slots[index] ??= {};
    return store.slots[index];
  };
  const useState = (initial: unknown) => {
    const own = slot();
    if (own.set === undefined) {
      own.value = typeof initial === "function" ? initial() : initial;
      own.set = (next: unknown) => {
        const value =
          typeof next === "function"
            ? (next as (value: unknown) => unknown)(own.value)
            : next;
        if (!Object.is(value, own.value)) {
          own.value = value;
          store.dirty = true;
        }
      };
    }
    return [own.value, own.set];
  };
  const useReducer = (
    reducer: (state: unknown, action: unknown) => unknown,
    argument: unknown,
    init?: (argument: unknown) => unknown,
  ) => {
    const [value, set] = useState(() =>
      init === undefined ? argument : init(argument),
    ) as [unknown, (next: unknown) => void];
    const own = store.slots[store.index - 1] as Slot & {
      dispatch?: (action: unknown) => void;
    };
    own.dispatch ??= (action: unknown) =>
      set((state: unknown) => reducer(state, action));
    return [value, own.dispatch];
  };
  const useMemo = (make: () => unknown, deps?: readonly unknown[]) => {
    const own = slot();
    if (!("value" in own) || changed(own.deps, deps)) {
      own.value = make();
      own.deps = deps;
    }
    return own.value;
  };
  const useCallback = (callback: unknown, deps?: readonly unknown[]) =>
    useMemo(() => callback, deps);
  const useRef = (initial: unknown) => {
    const own = slot();
    if (!("value" in own)) {
      own.value = { current: initial };
    }
    return own.value;
  };
  const useEffect = (
    effect: () => void | (() => void),
    deps?: readonly unknown[],
  ) => {
    const own = slot();
    if ("deps" in own && !changed(own.deps, deps)) {
      return;
    }
    own.deps = deps;
    store.effects.push(() => {
      own.cleanup?.();
      const cleanup = effect();
      own.cleanup = typeof cleanup === "function" ? cleanup : undefined;
    });
  };
  return {
    store,
    api: { useState, useReducer, useMemo, useCallback, useRef, useEffect },
  };
});

vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  const unknown = Object.fromEntries(
    Object.keys(react)
      .filter((name) => /^use([A-Z]|$)/.test(name) && !(name in hooks.api))
      .map((name) => [
        name,
        () => {
          throw new Error(
            `The React stand-in of open-after-create.test.ts has no ${name}; add one to its hooks first.`,
          );
        },
      ]),
  );
  return { ...react, ...unknown, ...hooks.api };
});

// `App` and its modules load afresh, with the stand-in.
vi.resetModules();
const { App } = await import("./App.tsx");
const {
  CREATE_DONE_MESSAGES,
  CREATE_DONE_SHORT_MESSAGES,
  CREATE_MESSAGES,
  describeCreateSentence,
} = await import("./creation-view.ts");
const { PROJECTS_HEADING_ID, WORKSPACES_HEADING_ID } =
  await import("./Creation.tsx");

const WORKSPACE_A = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a1";
const WORKSPACE_B = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a2";
const NEW_WORKSPACE = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3";
const PROJECT = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192e1";
const NEW_PROJECT = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192e2";

let revision = 0;

function workspaceState(overrides: Partial<WorkspaceView> = {}): WorkspaceView {
  revision += 1;
  return {
    revision,
    status: "ready",
    workspaces: [
      { id: WORKSPACE_A, name: "Team Alpha" },
      { id: WORKSPACE_B, name: "Team Beta" },
    ],
    selectedWorkspaceId: WORKSPACE_A,
    projects: [{ id: PROJECT, name: "Launch Plan" }],
    openProjectId: null,
    ...overrides,
  } as WorkspaceView;
}

/** The elements that took the focus, by ID. */
const focused: string[] = [];

/** The IDs of the elements that are not on the page; every other one is. */
const missing = new Set<string>();

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  hooks.store.slots = [];
  hooks.store.effects = [];
  focused.length = 0;
  missing.clear();
  const body = { id: "body" };
  vi.stubGlobal("document", {
    body,
    activeElement: body,
    getElementById: (id: string) =>
      missing.has(id)
        ? null
        : {
            isConnected: true,
            contains: () => false,
            focus: () => focused.push(id),
          },
  });
});

/**
 * A workspace bridge whose creates confirm, recording every call with its
 * arguments, while chat messages wait to be sent: a switch answers
 * `waiting` until it comes with `discardWaiting`, which answers `ok`. The
 * report that no project is open, which `App` sends at the start, answers
 * `ok` too, so that no question is open before a click, as in the app.
 */
function fakeWorkspaces(createResult: CreateWorkspaceResult) {
  const calls: string[] = [];
  let listener: ((state: WorkspaceView) => void) | undefined;
  const bridge: WorkspaceBridge = {
    getState: () => new Promise(() => undefined),
    subscribeState: (next) => {
      listener = next;
      return () => undefined;
    },
    select: (...args: Parameters<WorkspaceBridge["select"]>) => {
      calls.push(`select ${JSON.stringify(args)}`);
      return Promise.resolve(
        args[1]?.discardWaiting === true
          ? { outcome: "ok" as const }
          : { outcome: "waiting" as const, count: 2 },
      );
    },
    openProject: (...args: Parameters<WorkspaceBridge["openProject"]>) => {
      calls.push(`openProject ${JSON.stringify(args)}`);
      return Promise.resolve(
        args[0] === null || args[1]?.discardWaiting === true
          ? { outcome: "ok" as const }
          : { outcome: "waiting" as const, count: 1 },
      );
    },
    create: (name) => {
      calls.push(`create ${name}`);
      return Promise.resolve(createResult);
    },
    createProject: (workspaceId, name) => {
      calls.push(`createProject ${workspaceId} ${name}`);
      return Promise.resolve<CreateProjectResult>({
        outcome: "ok",
        projectId: NEW_PROJECT,
      });
    },
    copyId: (workspaceId) => {
      calls.push(`copyId ${workspaceId}`);
      return Promise.resolve({ outcome: "ok" as const });
    },
  };
  return {
    bridge,
    calls,
    publish: (state: WorkspaceView) => listener?.(state),
  };
}

/** The shell over `bridge`, rendered again after every change. */
function shell(bridge: WorkspaceBridge) {
  let tree: ReactElement | undefined;
  const render = () => {
    for (let round = 0; round < 50; round += 1) {
      hooks.store.dirty = false;
      hooks.store.index = 0;
      tree = App({ workspaces: bridge }) as ReactElement;
      const effects = hooks.store.effects;
      hooks.store.effects = [];
      for (const effect of effects) {
        effect();
      }
      if (!hooks.store.dirty) {
        return;
      }
    }
    throw new Error("The shell kept changing.");
  };
  /** The props of the first element that has `name` among its props. */
  const propsWith = <T>(name: string): T => {
    const search = (node: ReactNode): T | undefined => {
      if (Array.isArray(node)) {
        for (const child of node as ReactNode[]) {
          const found = search(child);
          if (found !== undefined) {
            return found;
          }
        }
        return undefined;
      }
      if (node === null || typeof node !== "object" || !("props" in node)) {
        return undefined;
      }
      const props = (node as ReactElement<Record<string, unknown>>).props;
      return name in props ? (props as T) : search(props.children as ReactNode);
    };
    const found = search(tree);
    if (found === undefined) {
      throw new Error(`No element has ${name}.`);
    }
    return found;
  };
  const creation = () =>
    propsWith<{
      creation: import("./Creation.tsx").CreationControls;
    }>("creation").creation;
  render();
  return {
    render,
    creation,
    /**
     * The sentence that the status paragraph shows by the controls that
     * `App` passes on, as one text.
     */
    sentence: () => {
      const { view, created } = creation();
      if (view.message === undefined) {
        return undefined;
      }
      const { start, rest } = describeCreateSentence(view.message, created);
      return `${start}${rest}`;
    },
    question: () =>
      propsWith<{
        question: import("./workspace-view.ts").SwitchQuestion | undefined;
        onDiscard: () => void;
      }>("onDiscard"),
    openView: () =>
      propsWith<{ view: { screen: string; projectId?: string } }>(
        "electronVersion",
      ).view,
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

test("App offers Open this workspace for an unselected new workspace, selects it through the sidebar's switch with the ID alone, and moves the focus once it leaves", async () => {
  const fake = fakeWorkspaces({
    outcome: "ok",
    workspaceId: NEW_WORKSPACE,
    selected: false,
  });
  const app = shell(fake.bridge);
  fake.publish(workspaceState());
  app.render();
  app.creation().onOpen("workspaces", null);
  app.render();
  app.creation().onDialogDraft("Team Gamma");
  app.render();
  app.creation().onConfirm();
  await settle();
  app.render();
  expect(fake.calls).toContain("create Team Gamma");
  // Not before the list holds it, and the long sentence says what to do.
  expect(app.creation().created).toBeUndefined();
  expect(app.sentence()).toBe(CREATE_DONE_MESSAGES.workspaceNotSelected);

  const listed = [
    { id: NEW_WORKSPACE, name: "Team Gamma" },
    { id: WORKSPACE_A, name: "Team Alpha" },
    { id: WORKSPACE_B, name: "Team Beta" },
  ];
  fake.publish(workspaceState({ workspaces: listed }));
  app.render();
  expect(app.creation().created).toEqual({
    kind: "workspace",
    place: "workspaces",
    workspaceId: NEW_WORKSPACE,
  });
  expect(CREATE_MESSAGES.openWorkspace).toBe("Open this workspace");
  // Next to the button, the sentence is the short one.
  expect(app.sentence()).toBe(CREATE_DONE_SHORT_MESSAGES.workspace);

  // No question is open before the click.
  expect(app.question().question).toBeUndefined();
  const before = fake.calls.length;
  app.creation().onOpenCreated();
  await settle();
  app.render();
  // The sidebar's switch, with the ID alone: messages wait, so it asks.
  expect(fake.calls.slice(before)).toEqual([`select ["${NEW_WORKSPACE}"]`]);
  expect(app.question().question).toEqual({ kind: "workspace", count: 2 });
  expect(focused).toEqual([]);

  // Only the person's answer drops the waiting messages.
  app.question().onDiscard();
  await settle();
  app.render();
  expect(fake.calls.slice(before)).toEqual([
    `select ["${NEW_WORKSPACE}"]`,
    `select ["${NEW_WORKSPACE}",{"discardWaiting":true}]`,
  ]);
  expect(app.question().question).toBeUndefined();
  expect(focused).toEqual([]);

  // Once it is selected, the button leaves, and the focus, which fell to
  // the page, moves to the Workspaces heading.
  fake.publish(
    workspaceState({
      workspaces: listed,
      selectedWorkspaceId: NEW_WORKSPACE,
      projects: [],
    }),
  );
  app.render();
  expect(app.creation().created).toBeUndefined();
  expect(focused).toEqual([WORKSPACES_HEADING_ID]);
});

test("App offers Open this project once its event lists it, and opens it through the shell's open-project, which the main process gets without a discard until the person's answer", async () => {
  const fake = fakeWorkspaces({
    outcome: "ok",
    workspaceId: NEW_WORKSPACE,
    selected: true,
  });
  const app = shell(fake.bridge);
  fake.publish(workspaceState());
  app.render();
  app.creation().onOpen("projects", null);
  app.render();
  app.creation().onDialogDraft("Roadmap");
  app.render();
  app.creation().onConfirm();
  await settle();
  app.render();
  expect(fake.calls).toContain(`createProject ${WORKSPACE_A} Roadmap`);
  expect(app.creation().created).toBeUndefined();
  expect(app.sentence()).toBe(CREATE_DONE_MESSAGES.project);

  // Its `workspace.project.created` event lists it.
  const projects = [
    { id: PROJECT, name: "Launch Plan" },
    { id: NEW_PROJECT, name: "Roadmap" },
  ];
  fake.publish(workspaceState({ projects }));
  app.render();
  expect(app.creation().created).toEqual({
    kind: "project",
    place: "projects",
    projectId: NEW_PROJECT,
  });
  expect(app.sentence()).toBe(CREATE_DONE_SHORT_MESSAGES.project);

  // No question is open before the click.
  expect(app.question().question).toBeUndefined();
  const before = fake.calls.length;
  app.creation().onOpenCreated();
  app.render();
  expect(app.openView()).toMatchObject({
    screen: "chat",
    projectId: NEW_PROJECT,
  });
  await settle();
  app.render();
  // The report of the open project, without a discard: messages wait, so
  // the shell asks.
  expect(fake.calls.slice(before)).toEqual([`openProject ["${NEW_PROJECT}"]`]);
  expect(app.question().question).toEqual({ kind: "project", count: 1 });
  expect(focused).toEqual([]);

  // Only the person's answer drops the waiting messages.
  app.question().onDiscard();
  await settle();
  app.render();
  expect(fake.calls.slice(before)).toEqual([
    `openProject ["${NEW_PROJECT}"]`,
    `openProject ["${NEW_PROJECT}",{"discardWaiting":true}]`,
  ]);
  expect(app.question().question).toBeUndefined();
  expect(focused).toEqual([]);

  // Once the main process opened it, the button leaves, and the focus
  // moves to the Projects heading.
  fake.publish(workspaceState({ projects, openProjectId: NEW_PROJECT }));
  app.render();
  expect(app.creation().created).toBeUndefined();
  expect(focused).toEqual([PROJECTS_HEADING_ID]);
  // The sentence stays short; it does not grow back.
  expect(app.sentence()).toBe(CREATE_DONE_SHORT_MESSAGES.project);
});

test("App moves the focus to the Workspaces heading when Open this project leaves while the Projects heading is not on the page", async () => {
  const fake = fakeWorkspaces({
    outcome: "ok",
    workspaceId: NEW_WORKSPACE,
    selected: true,
  });
  const app = shell(fake.bridge);
  fake.publish(workspaceState());
  app.render();
  app.creation().onOpen("projects", null);
  app.render();
  app.creation().onDialogDraft("Roadmap");
  app.render();
  app.creation().onConfirm();
  await settle();
  app.render();
  fake.publish(
    workspaceState({
      projects: [
        { id: PROJECT, name: "Launch Plan" },
        { id: NEW_PROJECT, name: "Roadmap" },
      ],
    }),
  );
  app.render();
  expect(app.creation().created).toMatchObject({ place: "projects" });

  // The workspace is no longer selected, so the projects and their heading
  // leave the page with the button.
  missing.add(PROJECTS_HEADING_ID);
  fake.publish(
    workspaceState({
      workspaces: [{ id: WORKSPACE_B, name: "Team Beta" }],
      selectedWorkspaceId: null,
      projects: [],
    }),
  );
  app.render();
  expect(app.creation().created).toBeUndefined();
  expect(focused).toEqual([WORKSPACES_HEADING_ID]);
});
