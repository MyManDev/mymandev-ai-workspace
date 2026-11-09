// Checks of the renderer's copies of protocol values. They live here, with
// the Node.js types, because the renderer's own tests cannot import the
// protocol package, whose device authentication uses Node.js.
import { MEMBER_ROLES, RUN_CANCEL_REASONS } from "@mymandev/protocol";
import { expect, test } from "vitest";
import { RUN_CANCEL_MESSAGES } from "../src/renderer/agent-view.ts";
import { ROLE_LABELS } from "../src/renderer/people-view.ts";

test("the agent panel has its own text for every cancellation code of the protocol, and for no other", () => {
  expect(Object.keys(RUN_CANCEL_MESSAGES).sort()).toEqual(
    [...RUN_CANCEL_REASONS].sort(),
  );
});

test("the people screen has a text for every role of the protocol, and for no other", () => {
  expect(Object.keys(ROLE_LABELS).sort()).toEqual([...MEMBER_ROLES].sort());
});
