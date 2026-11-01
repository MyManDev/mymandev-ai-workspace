import path from "node:path";
import { expect, test } from "vitest";
import {
  REPOSITORY_LIMITS,
  RepositoryListSchema,
  type RepositoryList,
} from "../shared/ipc-contract.ts";
import type {
  GitInspector,
  InspectResult,
  LocateResult,
  RepositoryLocation,
} from "./git-inspector.ts";
import {
  createRepositoryService,
  type RepositoryServiceOptions,
  type Timers,
} from "./repositories.ts";
import type { RepositoryWatchCallbacks } from "./repository-watcher.ts";

const OID = "4398e47c585d12a2fa2d3d9f819a353092e8374c";

function ready(unstaged: number): InspectResult {
  return {
    kind: "ready",
    branch: {
      name: "main",
      commit: OID,
      upstream: null,
      ahead: null,
      behind: null,
    },
    changes: { staged: 0, unstaged, untracked: 0, conflicted: 0 },
    remotes: [],
  };
}

function locationOf(topLevel: string): RepositoryLocation {
  return {
    topLevel,
    gitDir: path.posix.join(topLevel, ".git"),
    commonDir: path.posix.join(topLevel, ".git"),
  };
}

/** Timers that run only when the test advances them. */
function fakeTimers() {
  let now = 1_000;
  let nextId = 1;
  const pending = new Map<number, { at: number; callback: () => void }>();
  const timers: Timers = {
    setTimeout: (callback, milliseconds) => {
      const id = nextId;
      nextId += 1;
      pending.set(id, { at: now + milliseconds, callback });
      return id;
    },
    clearTimeout: (handle) => {
      pending.delete(handle as number);
    },
    now: () => now,
  };
  return {
    timers,
    pending: () => pending.size,
    advance(milliseconds: number) {
      now += milliseconds;
      for (const [id, timer] of [...pending].sort(
        ([, a], [, b]) => a.at - b.at,
      )) {
        if (timer.at <= now) {
          pending.delete(id);
          timer.callback();
        }
      }
    },
  };
}

/** An inspector whose inspect calls the test settles one by one. */
function fakeInspector(locate: (folder: string) => LocateResult) {
  const inspections: {
    location: RepositoryLocation;
    signal: AbortSignal | undefined;
    resolve: (result: InspectResult) => void;
    reject: (error: unknown) => void;
  }[] = [];
  const inspector: GitInspector = {
    locate: async (folder) => locate(folder),
    inspect: (location, signal) =>
      new Promise((resolve, reject) => {
        inspections.push({ location, signal, resolve, reject });
      }),
  };
  return { inspector, inspections };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}

function setup(
  overrides: Partial<RepositoryServiceOptions> = {},
  locate: (folder: string) => LocateResult = (folder) => ({
    kind: "repository",
    location: locationOf(folder),
  }),
) {
  const clock = fakeTimers();
  const fake = fakeInspector(locate);
  const watches: {
    location: RepositoryLocation;
    callbacks: RepositoryWatchCallbacks;
    closed: number;
  }[] = [];
  const errors: string[] = [];
  let ids = 0;
  const service = createRepositoryService({
    inspector: fake.inspector,
    watch: (location, callbacks) => {
      const watch = { location, callbacks, closed: 0 };
      watches.push(watch);
      return {
        recursive: true,
        close: () => {
          watch.closed += 1;
        },
      };
    },
    pathApi: path.posix,
    caseInsensitivePaths: false,
    newMountId: () => {
      ids += 1;
      return `0b9e2f7c-5d0a-4c8e-9f3b-${String(ids).padStart(12, "0")}`;
    },
    timers: clock.timers,
    quietMs: 300,
    maxWaitMs: 2_000,
    onError: (message) => errors.push(message),
    ...overrides,
  });
  const lists: RepositoryList[] = [];
  service.onChange((list) => lists.push(list));
  return { service, clock, ...fake, watches, errors, lists };
}

test("mounting reads the repository, watches it, and publishes each change", async () => {
  const { service, inspections, watches, lists } = setup();

  const result = await service.mount("/home/user/project");

  expect(result).toEqual({
    outcome: "mounted",
    mountId: "0b9e2f7c-5d0a-4c8e-9f3b-000000000001",
  });
  expect(watches.map(({ location }) => location)).toEqual([
    locationOf("/home/user/project"),
  ]);
  expect(service.list()).toEqual({
    revision: 1,
    repositories: [
      {
        mountId: "0b9e2f7c-5d0a-4c8e-9f3b-000000000001",
        name: "project",
        path: "/home/user/project",
        watching: true,
        state: { kind: "loading" },
      },
    ],
  });
  expect(inspections).toHaveLength(1);

  inspections[0]?.resolve(ready(1));
  await settle();

  expect(lists.map(({ revision }) => revision)).toEqual([1, 2]);
  expect(lists[1]?.repositories[0]?.state).toEqual(ready(1));
  for (const list of lists) {
    expect(RepositoryListSchema.parse(list)).toEqual(list);
  }
});

test("a file change refreshes the status after a quiet period, once for a burst", async () => {
  const { service, clock, inspections, watches, lists } = setup();
  await service.mount("/home/user/project");
  inspections[0]?.resolve(ready(0));
  await settle();

  for (let index = 0; index < 5; index += 1) {
    watches[0]?.callbacks.onChange();
    clock.advance(100);
  }
  expect(inspections).toHaveLength(1);
  clock.advance(300);
  expect(inspections).toHaveLength(2);
  inspections[1]?.resolve(ready(3));
  await settle();

  expect(lists.at(-1)?.repositories[0]?.state).toEqual(ready(3));
});

test("continuous changes still refresh at the latest after the maximum wait", async () => {
  const { service, clock, inspections, watches } = setup();
  await service.mount("/home/user/project");
  inspections[0]?.resolve(ready(0));
  await settle();

  for (let elapsed = 0; elapsed < 2_000; elapsed += 100) {
    watches[0]?.callbacks.onChange();
    clock.advance(100);
  }

  expect(inspections).toHaveLength(2);
});

test("a change during a refresh refreshes once more afterwards, never in parallel", async () => {
  const { service, clock, inspections, watches } = setup();
  await service.mount("/home/user/project");

  watches[0]?.callbacks.onChange();
  clock.advance(300);
  watches[0]?.callbacks.onChange();
  clock.advance(300);
  expect(inspections).toHaveLength(1);

  inspections[0]?.resolve(ready(1));
  await settle();
  expect(inspections).toHaveLength(2);
  inspections[1]?.resolve(ready(2));
  await settle();
  expect(inspections).toHaveLength(2);
});

test("an unchanged status publishes nothing", async () => {
  const { service, clock, inspections, watches, lists } = setup();
  await service.mount("/home/user/project");
  inspections[0]?.resolve(ready(1));
  await settle();
  const published = lists.length;

  watches[0]?.callbacks.onChange();
  clock.advance(300);
  inspections[1]?.resolve(ready(1));
  await settle();

  expect(lists).toHaveLength(published);
});

test("unmounting stops watching, cancels Git, drops a late result, and publishes", async () => {
  const { service, clock, inspections, watches, lists } = setup();
  const result = await service.mount("/home/user/project");
  if (result.outcome !== "mounted") {
    throw new Error("expected a mount");
  }
  watches[0]?.callbacks.onChange();

  expect(service.unmount(result.mountId)).toBe(true);
  expect(service.unmount(result.mountId)).toBe(false);
  expect(watches[0]?.closed).toBe(1);
  expect(inspections[0]?.signal?.aborted).toBe(true);
  expect(clock.pending()).toBe(0);
  expect(service.list().repositories).toEqual([]);
  expect(lists.at(-1)?.repositories).toEqual([]);

  const count = lists.length;
  inspections[0]?.resolve(ready(5));
  watches[0]?.callbacks.onChange();
  clock.advance(5_000);
  await settle();
  expect(lists).toHaveLength(count);
  expect(inspections).toHaveLength(1);
});

test("refusals of the inspector pass through, and nothing is watched", async () => {
  const { service, watches, lists } = setup({}, () => ({
    kind: "refused",
    reason: "not-a-repository",
  }));

  expect(await service.mount("/home/user/notes")).toEqual({
    outcome: "refused",
    reason: "not-a-repository",
  });
  expect(watches).toEqual([]);
  expect(lists).toEqual([]);
});

test("a path that is relative, too long, or contains NUL is refused before Git runs", async () => {
  let located = 0;
  const { service } = setup({}, (folder) => {
    located += 1;
    return { kind: "repository", location: locationOf(folder) };
  });

  for (const folder of [
    "relative/project",
    "",
    `/${"x".repeat(REPOSITORY_LIMITS.path)}`,
    "/home/user/pro\0ject",
  ]) {
    expect(await service.mount(folder)).toEqual({
      outcome: "refused",
      reason: "unsupported-path",
    });
  }
  expect(located).toBe(0);
});

test("the same repository is mounted once, also through another folder name", async () => {
  const { service } = setup({}, () => ({
    kind: "repository",
    location: locationOf("/home/user/project"),
  }));

  expect((await service.mount("/home/user/project")).outcome).toBe("mounted");
  expect(await service.mount("/home/user/link-to-project")).toEqual({
    outcome: "refused",
    reason: "already-mounted",
  });
});

test("where paths ignore case, a repository in another case is the same", async () => {
  const { service } = setup(
    { caseInsensitivePaths: true, pathApi: path.win32 },
    (folder) => ({
      kind: "repository",
      location: {
        topLevel: folder,
        gitDir: path.win32.join(folder, ".git"),
        commonDir: path.win32.join(folder, ".git"),
      },
    }),
  );

  expect((await service.mount("C:\\Users\\user\\Project")).outcome).toBe(
    "mounted",
  );
  expect(service.list().repositories[0]).toMatchObject({
    name: "Project",
    path: "C:\\Users\\user\\Project",
  });
  expect(await service.mount("c:\\users\\user\\project")).toEqual({
    outcome: "refused",
    reason: "already-mounted",
  });
});

test("no more than the limit of repositories is mounted", async () => {
  const { service } = setup();

  for (let index = 0; index < REPOSITORY_LIMITS.mounted; index += 1) {
    expect((await service.mount(`/repos/r${index}`)).outcome).toBe("mounted");
  }
  expect(await service.mount("/repos/one-more")).toEqual({
    outcome: "refused",
    reason: "limit",
  });
  expect(RepositoryListSchema.safeParse(service.list()).success).toBe(true);
});

test("a repository that cannot be watched is still mounted, marked as not watching", async () => {
  const { service } = setup({ watch: () => undefined });

  await service.mount("/home/user/project");

  expect(service.list().repositories[0]?.watching).toBe(false);
});

test("a watcher error stops watching, publishes it, and refreshes the status", async () => {
  const { service, inspections, watches, lists, errors } = setup();
  await service.mount("/home/user/project");
  inspections[0]?.resolve(ready(0));
  await settle();

  watches[0]?.callbacks.onError(new Error("EPERM"));
  await settle();

  expect(errors).toEqual(["Watching a repository failed."]);
  expect(watches[0]?.closed).toBe(1);
  expect(lists.at(-1)?.repositories[0]?.watching).toBe(false);
  expect(inspections).toHaveLength(2);
  inspections[1]?.resolve({ kind: "unavailable", problem: "missing" });
  await settle();
  expect(lists.at(-1)?.repositories[0]?.state).toEqual({
    kind: "unavailable",
    problem: "missing",
  });
});

test("an inspector that throws marks the repository as failed", async () => {
  const { service, inspections, lists, errors } = setup();
  await service.mount("/home/user/project");

  inspections[0]?.reject(new Error("boom"));
  await settle();

  expect(lists.at(-1)?.repositories[0]?.state).toEqual({
    kind: "unavailable",
    problem: "failed",
  });
  expect(errors).toEqual(["Reading a repository failed."]);
});

test("names and paths are made safe to show", async () => {
  const bidi = String.fromCodePoint(0x202e);
  const { service } = setup();

  await service.mount(`/home/user/evil${bidi}txt.exe`);

  const [repository] = service.list().repositories;
  expect(repository?.name).toBe(`evil${String.fromCodePoint(0xfffd)}txt.exe`);
  expect(repository?.path).not.toContain(bidi);
});

test("close stops every watcher, cancels Git, and refuses later mounts", async () => {
  const { service, inspections, watches, lists } = setup();
  await service.mount("/repos/a");
  await service.mount("/repos/b");
  const count = lists.length;

  service.close();

  expect(watches.map(({ closed }) => closed)).toEqual([1, 1]);
  expect(inspections.every(({ signal }) => signal?.aborted === true)).toBe(
    true,
  );
  expect(service.list().repositories).toEqual([]);
  expect(await service.mount("/repos/c")).toEqual({
    outcome: "refused",
    reason: "failed",
  });
  expect(lists).toHaveLength(count);
});

test("a listener that throws is reported and stops nothing", async () => {
  const { service, errors } = setup();
  service.onChange(() => {
    throw new Error("listener");
  });
  const seen: number[] = [];
  service.onChange((list) => seen.push(list.revision));

  await service.mount("/home/user/project");

  expect(errors).toEqual(["A repository list listener failed."]);
  expect(seen).toEqual([1]);
});
