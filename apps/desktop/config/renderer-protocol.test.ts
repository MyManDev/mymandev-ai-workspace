// Checks of the renderer's copies of protocol values. They live here, with
// the Node.js types, because the renderer's own tests cannot import the
// protocol package, whose device authentication uses Node.js.
import {
  CreateProjectRequestSchema,
  CreateWorkspaceRequestSchema,
  INVITATION_CODE_PATTERN,
  INVITATION_COUNT_LIMITS,
  INVITATION_LIFETIME_SECONDS,
  LIMITS,
  MEMBER_ROLES,
  normalizeProjectName,
  OWN_JOIN_REQUEST_DECISIONS,
  RUN_CANCEL_REASONS,
  UUIDV7_PATTERN,
  WorkspaceIdSchema,
} from "@mymandev/protocol";
import { expect, test } from "vitest";
import { RUN_CANCEL_MESSAGES } from "../src/renderer/agent-view.ts";
import {
  MAX_NEW_NAME_LENGTH,
  nameToSend,
  newNamePrompt,
} from "../src/renderer/creation-view.ts";
import {
  INVITATION_LIFETIME_DAYS,
  MAX_LIVE_INVITATIONS,
} from "../src/renderer/invitations-view.ts";
import { INVITATION_CODE_PATTERN as JOIN_CODE_PATTERN } from "../src/renderer/join-invitation-view.ts";
import {
  OWN_JOIN_REQUEST_OUTCOME_LABELS,
  WORKSPACE_ID_PATTERN,
  workspaceIdToSend,
} from "../src/renderer/own-join-requests-view.ts";
import { ROLE_LABELS } from "../src/renderer/people-view.ts";

test("the agent panel has its own text for every cancellation code of the protocol, and for no other", () => {
  expect(Object.keys(RUN_CANCEL_MESSAGES).sort()).toEqual(
    [...RUN_CANCEL_REASONS].sort(),
  );
});

test("the people screen has a text for every role of the protocol, and for no other", () => {
  expect(Object.keys(ROLE_LABELS).sort()).toEqual([...MEMBER_ROLES].sort());
});

test("the join screen checks a pasted code with the protocol's invitation code pattern", () => {
  expect(JOIN_CODE_PATTERN.source).toBe(INVITATION_CODE_PATTERN.source);
  expect(JOIN_CODE_PATTERN.flags).toBe(INVITATION_CODE_PATTERN.flags);
});

test("the join screen checks a workspace ID with the protocol's UUIDv7 pattern, and sends only what the protocol's workspace ID accepts", () => {
  expect(WORKSPACE_ID_PATTERN.source).toBe(UUIDV7_PATTERN.source);
  expect(WORKSPACE_ID_PATTERN.flags).toBe(UUIDV7_PATTERN.flags);
  const id = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3";
  for (const typed of [
    id,
    id.toUpperCase(),
    ` ${id}
`,
    "0192f2a0-7c3e-4a1b-8c4d-5e6f708192a3",
    `${id}0`,
    "",
  ]) {
    const sent = workspaceIdToSend(typed);
    if (sent !== undefined) {
      expect(WorkspaceIdSchema.safeParse(sent).success, typed).toBe(true);
    }
  }
  expect(workspaceIdToSend(id.toUpperCase())).toBe(id);
});

test("the join screen has a text for every way the protocol says that an own join request ended, and for no other", () => {
  expect(Object.keys(OWN_JOIN_REQUEST_OUTCOME_LABELS).sort()).toEqual(
    [...OWN_JOIN_REQUEST_DECISIONS].sort(),
  );
});

test("the question before an invitation names the protocol's default lifetime, which applies because the screen sends none", () => {
  expect(INVITATION_LIFETIME_DAYS * 24 * 60 * 60).toBe(
    INVITATION_LIFETIME_SECONDS.default,
  );
});

test("the sentence about a refused invitation names the protocol's limit of live invitations", () => {
  expect(MAX_LIVE_INVITATIONS).toBe(INVITATION_COUNT_LIMITS.live);
});

test("the creates count a name as the protocol does, up to its limit of a workspace's and a project's name", () => {
  expect(MAX_NEW_NAME_LENGTH).toBe(LIMITS.name);
  const longest = "\u{1F600}".repeat(LIMITS.name);
  const checks = [
    [
      "workspace",
      (name: string) =>
        CreateWorkspaceRequestSchema.safeParse({ name, displayName: "Ada" })
          .success,
    ],
    [
      "project",
      (name: string) => CreateProjectRequestSchema.safeParse({ name }).success,
    ],
  ] as const;
  for (const [kind, accepts] of checks) {
    for (const typed of [longest, longest + "a", "Team", " Team "]) {
      const name = nameToSend(kind, typed);
      expect(newNamePrompt(name) === undefined, `${kind} ${typed}`).toBe(
        accepts(name),
      );
    }
  }
});

test("the creates send a project's name as the protocol normalizes it", () => {
  for (const typed of [
    "  Cafe\u0301 ",
    "e\u0301".repeat(LIMITS.name),
    "\tLaunch Plan\u00a0",
    "\u1100\u1161",
  ]) {
    expect(nameToSend("project", typed)).toBe(normalizeProjectName(typed));
  }
});
