// The file list of a run's context on the real file system, in a small
// temporary folder that each test removes, through the context builder, with
// the walk's record written by the file recorder to the same temporary
// folder. Folder links are junctions on Windows, which need no privilege,
// and symbolic links elsewhere.
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ChatMessage,
  MessageId,
  ProjectId,
  RepositoryId,
  WorkspaceId,
} from "@mymandev/protocol";
import { afterEach, expect, test } from "vitest";
import { createRunContextBuilder } from "../agents/run-context.ts";
import type { RunActionCheck } from "../agents/run-executor.ts";
import type { HeldRun } from "../permissions/enforcement.ts";
import {
  createFileEnforcementRecorder,
  type FileEnforcementRecorder,
} from "../permissions/file-recorder.ts";
import { createSystemReadToolFileSystem } from "./read-tools.ts";
import { createRepositoryWalkLister } from "./repository-files.ts";

const REPOSITORY_ID = "0192f0a0-7b3c-7d4e-8f50-000000000009" as RepositoryId;
const PROJECT_ID = "0192f0a0-7b3c-7d4e-8f50-000000000006" as ProjectId;
const WORKSPACE_ID = "0192f0a0-7b3c-7d4e-8f50-000000000007" as WorkspaceId;
const MESSAGE_ID = "0192f0a0-7b3c-7d4e-8f50-00000000000c" as MessageId;
const AGENT_ID = "0192f0a0-7b3c-7d4e-8f50-000000000002";
const RUN: HeldRun = Object.freeze({
  runId: "0192f0a0-7b3c-7d4e-8f50-000000000001",
  agentId: AGENT_ID,
  hostDeviceId: "0192f0a0-7b3c-7d4e-8f50-000000000004",
  repositoryId: REPOSITORY_ID,
  providerConnectionId: null,
}) as HeldRun;
const MESSAGE = {
  id: MESSAGE_ID,
  projectId: PROJECT_ID,
  seq: 1,
  author: { kind: "member", memberId: "0192f0a0-7b3c-7d4e-8f50-00000000000d" },
  body: "List the files.",
  createdAt: "2026-11-26T11:00:00.000Z",
} as ChatMessage;

const bases: string[] = [];
const recorders: FileEnforcementRecorder[] = [];

afterEach(async () => {
  for (const recorder of recorders.splice(0)) {
    recorder.close();
  }
  for (const base of bases.splice(0)) {
    await rm(base, { recursive: true, force: true });
  }
});

async function layout() {
  const base = await realpath(
    await mkdtemp(path.join(tmpdir(), "mymandev-repository-files-")),
  );
  bases.push(base);
  const repo = path.join(base, "repo");
  const outside = path.join(base, "outside");
  for (const folder of [
    ".git",
    ".github",
    "src/sub",
    "node_modules/dep",
    "dist",
    "out",
    "build",
    "src/build",
  ]) {
    await mkdir(path.join(repo, folder), { recursive: true });
  }
  await mkdir(outside);
  const files = [
    ".git/config",
    ".github/ci.yml",
    ".env",
    "README.md",
    "src/a.ts",
    "src/sub/b.txt",
    "src/out",
    "node_modules/dep/index.js",
    "dist/app.js",
    "out/main.js",
    "build/x.o",
    "src/build/generated.ts",
  ];
  for (const file of files) {
    await writeFile(path.join(repo, file), "x\n");
  }
  await writeFile(path.join(outside, "secret.txt"), "outside\n");
  await symlink(outside, path.join(repo, "linked"), "junction");
  return { repo, outside };
}

function builderFor(repo: string, allowed: boolean) {
  const ends: number[] = [];
  // The records, next to the repository in the temporary folder.
  const records = path.join(path.dirname(repo), "records");
  const recorder = createFileEnforcementRecorder({
    folder: () => records,
    platform: process.platform,
    log: () => undefined,
  });
  recorders.push(recorder);
  const builder = createRunContextBuilder({
    recorder,
    now: () => new Date("2026-11-26T12:00:00.000Z"),
    account: {
      readWorkspaceData: (async () => ({
        ok: true,
        value: { message: MESSAGE },
      })) as never,
    },
    resolveFolder: async (repositoryId) => {
      const stats = await lstat(repo, { bigint: true });
      return {
        ok: true,
        repositoryId,
        folder: repo,
        identity: { dev: stats.dev.toString(), ino: stats.ino.toString() },
      };
    },
    listFiles: createRepositoryWalkLister({
      files: createSystemReadToolFileSystem(),
    }),
  });
  const check = (): RunActionCheck =>
    allowed
      ? {
          allowed: true,
          request: {
            agentId: AGENT_ID,
            capability: "repo.read",
            repositoryId: REPOSITORY_ID,
          } as never,
          end: () => ends.push(1),
        }
      : { allowed: false, reason: "no_grant" };
  return {
    ends,
    records,
    build: () =>
      builder.build({
        run: RUN,
        workspaceId: WORKSPACE_ID,
        projectId: PROJECT_ID,
        inputMessageId: MESSAGE_ID,
        check,
        signal: new AbortController().signal,
      }),
  };
}

test("with repo.read, the context lists the repository's files, relative, without hidden names, links, or the skipped folders, and never its folder", async () => {
  const { repo } = await layout();
  const harness = builderFor(repo, true);
  const result = await harness.build();
  if (!result.ok) {
    throw new Error("the build failed");
  }
  expect(result.context.repository).toEqual({
    included: true,
    repositoryId: REPOSITORY_ID,
    files: ["README.md", "src/a.ts", "src/out", "src/sub/b.txt"],
    truncated: false,
  });
  expect(harness.ends).toEqual([1]);
  // One line in the series of the tool calls: the repository's folder,
  // `src`, and `src/sub` were listed; never a name or a path.
  expect(await readdir(harness.records)).toEqual([
    "enforcement-tool-calls-00000001.jsonl",
  ]);
  const line = await readFile(
    path.join(harness.records, "enforcement-tool-calls-00000001.jsonl"),
    "utf8",
  );
  expect(line).toBe(
    '{"version":1,"kind":"context_walk","result":"ok","files":4,' +
      '"folders":3,"truncated":false,' +
      `"runId":"${RUN.runId}","agentId":"${AGENT_ID}",` +
      `"repositoryId":"${REPOSITORY_ID}","providerConnectionId":null,` +
      '"at":"2026-11-26T12:00:00.000Z"}\n',
  );
  const json = JSON.stringify(result.context);
  for (const form of [
    repo,
    repo.replaceAll("\\", "/"),
    path.basename(path.dirname(repo)),
  ]) {
    expect(json.toLowerCase()).not.toContain(
      JSON.stringify(form).slice(1, -1).toLowerCase(),
    );
  }
});

test("without repo.read, the context holds the message only, and the folder is never listed", async () => {
  const { repo } = await layout();
  const harness = builderFor(repo, false);
  const result = await harness.build();
  expect(result.ok && result.context.repository).toEqual({
    included: false,
    reason: "denied",
  });
  expect(result.ok && result.context.message.body).toBe("List the files.");
  expect(harness.ends).toEqual([]);
  // No walk, so no record: the recorder never created its folder.
  await expect(readdir(harness.records)).rejects.toThrow();
});
