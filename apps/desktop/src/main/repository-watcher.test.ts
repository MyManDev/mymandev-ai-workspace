import path from "node:path";
import { expect, test } from "vitest";
import type { RepositoryLocation } from "./git-inspector.ts";
import {
  isRelevantChange,
  relativeInside,
  watchRepository,
  type FileWatcher,
  type WatchFunction,
  type WatchOptions,
} from "./repository-watcher.ts";

interface FakeWatcher extends FileWatcher {
  readonly path: string;
  readonly options: WatchOptions;
  closed: boolean;
  emit(eventType: string, filename: string | null): void;
  fail(error: Error): void;
}

/** An fs.watch that records its watchers; `refuse` makes a call throw. */
function fakeWatch(
  refuse: (path: string, options: WatchOptions) => boolean = () => false,
) {
  const watchers: FakeWatcher[] = [];
  const watch: WatchFunction = (watchedPath, options, listener) => {
    if (refuse(watchedPath, options)) {
      throw Object.assign(new Error("not available"), {
        code: "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM",
      });
    }
    const errorListeners: ((error: Error) => void)[] = [];
    const watcher: FakeWatcher = {
      path: watchedPath,
      options,
      closed: false,
      close() {
        this.closed = true;
      },
      on(_event, errorListener) {
        errorListeners.push(errorListener);
        return this;
      },
      emit(eventType, filename) {
        if (!this.closed) {
          listener(eventType, filename);
        }
      },
      fail(error) {
        for (const errorListener of errorListeners) {
          errorListener(error);
        }
      },
    };
    watchers.push(watcher);
    return watcher;
  };
  return { watch, watchers };
}

const LOCATION: RepositoryLocation = {
  topLevel: "/home/user/project",
  gitDir: "/home/user/project/.git",
  commonDir: "/home/user/project/.git",
};

function start(
  location: RepositoryLocation = LOCATION,
  fake = fakeWatch(),
  pathApi = path.posix,
) {
  let changes = 0;
  const errors: unknown[] = [];
  const handle = watchRepository(
    location,
    {
      onChange: () => {
        changes += 1;
      },
      onError: (error) => errors.push(error),
    },
    { watch: fake.watch, pathApi },
  );
  return { handle, fake, errors, changes: () => changes };
}

test("the working tree is watched recursively and never keeps the process alive", () => {
  const { handle, fake } = start();

  expect(handle?.recursive).toBe(true);
  expect(
    fake.watchers.map(({ path: watched, options }) => [watched, options]),
  ).toEqual([
    [
      "/home/user/project",
      { recursive: true, persistent: false, encoding: "utf8" },
    ],
  ]);
});

test("changes in the working tree and of HEAD, the index, and refs are reported", () => {
  const { fake, changes } = start();
  const [workTree] = fake.watchers;

  for (const name of [
    "src/index.ts",
    "with space.txt",
    `caf${String.fromCodePoint(0xe9)}.txt`,
    ".gitignore",
    ".git",
    ".git/HEAD",
    ".git/index",
    ".git/refs/heads/main",
    ".git/packed-refs",
    ".git/FETCH_HEAD",
    null,
  ]) {
    workTree?.emit("change", name);
  }

  expect(changes()).toBe(11);
});

test("object store, reflog, and lock file churn in the Git directory is ignored", () => {
  const { fake, changes } = start();
  const [workTree] = fake.watchers;

  for (const name of [
    ".git/objects/ab/cdef0123",
    ".git/objects/pack/pack-1.pack",
    ".git/logs/HEAD",
    ".git/logs/refs/heads/main",
    ".git/index.lock",
    ".git/refs/heads/main.lock",
  ]) {
    workTree?.emit("rename", name);
  }

  expect(changes()).toBe(0);
});

test("on Windows, event names with backslashes are split the same way", () => {
  const pathApi = path.win32;
  const location: RepositoryLocation = {
    topLevel: "C:\\Users\\user\\project",
    gitDir: "C:\\Users\\user\\project\\.git",
    commonDir: "C:\\Users\\user\\project\\.git",
  };
  const { fake, changes } = start(location, fakeWatch(), pathApi);
  const [workTree] = fake.watchers;

  workTree?.emit("change", ".git\\objects\\ab\\cdef");
  workTree?.emit("change", ".git\\index.lock");
  expect(changes()).toBe(0);
  workTree?.emit("change", ".git\\index");
  workTree?.emit("change", "src\\main.ts");
  expect(changes()).toBe(2);

  expect(isRelevantChange(".git\\logs\\HEAD", ".git", pathApi)).toBe(false);
  expect(isRelevantChange(".git/logs/HEAD", ".git", pathApi)).toBe(false);
  // On Linux and macOS a backslash is part of a file name.
  expect(isRelevantChange(".git\\logs\\HEAD", ".git", path.posix)).toBe(true);
});

test("relativeInside tells folders inside the working tree from those outside", () => {
  expect(
    relativeInside("/home/user/project", "/home/user/project/.git", path.posix),
  ).toBe(".git");
  expect(
    relativeInside("/home/user/feature", "/home/user/project/.git", path.posix),
  ).toBeUndefined();
  expect(
    relativeInside("/home/user/project", "/home/user/project", path.posix),
  ).toBeUndefined();
  expect(
    relativeInside(
      "C:\\Users\\user\\project",
      "C:\\Users\\user\\project\\.git",
      path.win32,
    ),
  ).toBe(".git");
  expect(
    relativeInside("C:\\project", "D:\\project\\.git", path.win32),
  ).toBeUndefined();
  expect(
    relativeInside(
      "/home/user/project",
      "/home/user/project-old/.git",
      path.posix,
    ),
  ).toBeUndefined();
});

test("a linked worktree also watches its Git directory and the common one, without subfolders", () => {
  const { fake, changes } = start({
    topLevel: "/home/user/feature",
    gitDir: "/home/user/project/.git/worktrees/feature",
    commonDir: "/home/user/project/.git",
  });

  expect(
    fake.watchers.map(({ path: watched, options }) => [
      watched,
      options.recursive,
    ]),
  ).toEqual([
    ["/home/user/feature", true],
    ["/home/user/project/.git/worktrees/feature", false],
    ["/home/user/project/.git", false],
  ]);
  const [workTree, gitDir, commonDir] = fake.watchers;
  // In the working tree, a ".git" file is a file like any other.
  workTree?.emit("change", ".git");
  gitDir?.emit("change", "HEAD");
  gitDir?.emit("change", "index.lock");
  commonDir?.emit("change", "packed-refs");
  commonDir?.emit("change", "objects");
  commonDir?.emit("change", "logs");
  expect(changes()).toBe(3);
});

test("without recursive watching, the top-level folder alone is watched", () => {
  const fake = fakeWatch((_path, options) => options.recursive);
  const { handle } = start(LOCATION, fake);

  expect(handle?.recursive).toBe(false);
  expect(fake.watchers).toHaveLength(1);
  expect(fake.watchers[0]?.options.recursive).toBe(false);
});

test("when the working tree cannot be watched at all, there is no watch", () => {
  const { handle } = start(
    LOCATION,
    fakeWatch(() => true),
  );

  expect(handle).toBeUndefined();
});

test("close stops every watcher and later events report nothing", () => {
  const { handle, fake, changes } = start({
    topLevel: "/home/user/feature",
    gitDir: "/home/user/project/.git/worktrees/feature",
    commonDir: "/home/user/project/.git",
  });

  handle?.close();
  handle?.close();

  expect(fake.watchers.every(({ closed }) => closed)).toBe(true);
  fake.watchers[0]?.emit("change", "file.txt");
  expect(changes()).toBe(0);
});

test("an error of the working tree watcher closes everything and is reported once", () => {
  const { fake, errors, changes } = start({
    topLevel: "/home/user/feature",
    gitDir: "/home/user/project/.git/worktrees/feature",
    commonDir: "/home/user/project/.git",
  });
  const failure = new Error("EPERM");

  fake.watchers[0]?.fail(failure);

  expect(errors).toEqual([failure]);
  expect(fake.watchers.every(({ closed }) => closed)).toBe(true);
  fake.watchers[1]?.emit("change", "HEAD");
  expect(changes()).toBe(0);
});
