// Checks of the renderer's copies of protocol values. They live here, with
// the Node.js types, because the renderer's own tests cannot import the
// protocol package, whose device authentication uses Node.js.
import {
  INVITATION_CODE_PATTERN,
  INVITATION_LIFETIME_SECONDS,
  MEMBER_ROLES,
  RUN_CANCEL_REASONS,
} from "@mymandev/protocol";
import { expect, test } from "vitest";
import { RUN_CANCEL_MESSAGES } from "../src/renderer/agent-view.ts";
import { INVITATION_LIFETIME_DAYS } from "../src/renderer/invitations-view.ts";
import { INVITATION_CODE_PATTERN as JOIN_CODE_PATTERN } from "../src/renderer/join-invitation-view.ts";
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

test("the question before an invitation names the protocol's default lifetime, which applies because the screen sends none", () => {
  expect(INVITATION_LIFETIME_DAYS * 24 * 60 * 60).toBe(
    INVITATION_LIFETIME_SECONDS.default,
  );
});
