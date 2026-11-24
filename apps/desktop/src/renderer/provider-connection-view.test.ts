import {
  LIMITS,
  PROVIDER_CONNECTION_COUNT_LIMITS,
  PROVIDER_KINDS,
  SAFE_TEXT_PATTERN,
} from "@mymandev/protocol";
import { expect, test } from "vitest";
import type {
  ProviderConnectionItemView,
  ProviderConnectionListView,
  RegisterProviderConnectionResult,
  RemoveProviderConnectionResult,
} from "../shared/ipc-contract.ts";
import {
  PROVIDER_CONNECTION_LIST_PROBLEMS,
  PROVIDER_CONNECTION_STATUSES,
  REGISTER_PROVIDER_CONNECTION_REFUSALS,
  REMOVE_PROVIDER_CONNECTION_REFUSALS,
  RegisterProviderConnectionResultSchema,
  RemoveProviderConnectionResultSchema,
} from "../shared/ipc-contract.ts";
import {
  createProviderConnectionActions,
  describeProviderConnections,
  describeRegisterProviderConnection,
  describeRemoveProviderConnection,
  followProviderConnections,
  IDLE_PROVIDER_CONNECTION_ACTIONS,
  initialProviderConnectionSectionView,
  LABEL_SAFE_PATTERN,
  MAX_NEW_PROVIDER_CONNECTIONS_PER_DAY,
  MAX_PROVIDER_CONNECTION_LABEL_LENGTH,
  MAX_PROVIDER_CONNECTIONS_PER_DEVICE,
  PROVIDER_CONNECTION_MESSAGES,
  PROVIDER_CONNECTION_NOT_SENT,
  PROVIDER_CONNECTION_PROBLEM_MESSAGES,
  PROVIDER_CONNECTION_STATUS_TEXTS,
  PROVIDER_KINDS_OFFERED,
  providerConnectionLabelPrompt,
  providerConnectionLabelToSend,
  type ProviderConnectionActionsView,
  type ProviderConnectionSectionView,
} from "./provider-connection-view.ts";

// The pure parts of the AI provider section of the Account screen (#32):
// what it shows for each state, the label's checks before a registration,
// the sentence for every answer, and the actions, one at a time.

const ID_1 = "0192f0a0-7b3c-7d4e-8f50-000000000101";
const ID_2 = "0192f0a0-7b3c-7d4e-8f50-000000000102";
const AT = "2026-11-24T09:00:00.000Z";

function item(
  id: string,
  label: string,
  overrides: Partial<ProviderConnectionItemView> = {},
): ProviderConnectionItemView {
  return {
    id,
    kind: "claude",
    label,
    createdAt: AT,
    status: "registered",
    ...overrides,
  };
}

function known(
  state: Partial<ProviderConnectionListView> = {},
): ProviderConnectionSectionView {
  return {
    kind: "known",
    state: {
      revision: 1,
      status: "ready",
      connections: [item(ID_1, "Work"), item(ID_2, "Home", { kind: "codex" })],
      ...state,
    } as ProviderConnectionListView,
  };
}

test("the section's values match the protocol's", () => {
  expect([...PROVIDER_KINDS_OFFERED]).toEqual([...PROVIDER_KINDS]);
  expect(MAX_PROVIDER_CONNECTION_LABEL_LENGTH).toBe(
    LIMITS.providerConnectionLabel,
  );
  expect(MAX_PROVIDER_CONNECTIONS_PER_DEVICE).toBe(
    PROVIDER_CONNECTION_COUNT_LIMITS.activePerDevice,
  );
  expect(MAX_NEW_PROVIDER_CONNECTIONS_PER_DAY).toBe(
    PROVIDER_CONNECTION_COUNT_LIMITS.perDay,
  );
  expect(LABEL_SAFE_PATTERN.source).toBe(SAFE_TEXT_PATTERN.source);
  expect(LABEL_SAFE_PATTERN.flags).toBe(SAFE_TEXT_PATTERN.flags);
  // Every status and problem of the contract has its text.
  expect(Object.keys(PROVIDER_CONNECTION_STATUS_TEXTS).sort()).toEqual(
    [...PROVIDER_CONNECTION_STATUSES].sort(),
  );
  expect(Object.keys(PROVIDER_CONNECTION_PROBLEM_MESSAGES).sort()).toEqual(
    [...PROVIDER_CONNECTION_LIST_PROBLEMS].sort(),
  );
});

test("the section says what it knows, lists the connections with their status, and offers the form only with a signed-in device", () => {
  expect(
    describeProviderConnections(initialProviderConnectionSectionView(false)),
  ).toEqual({
    status: PROVIDER_CONNECTION_MESSAGES.unavailable,
    rows: null,
    signedIn: false,
  });
  expect(
    describeProviderConnections(initialProviderConnectionSectionView(true)),
  ).toEqual({
    status: PROVIDER_CONNECTION_MESSAGES.pending,
    rows: null,
    signedIn: false,
  });
  expect(
    describeProviderConnections(
      known({ status: "signed_out", connections: [] }),
    ),
  ).toEqual({
    status: PROVIDER_CONNECTION_MESSAGES.signedOut,
    rows: null,
    signedIn: false,
  });
  expect(
    describeProviderConnections(known({ status: "loading", connections: [] })),
  ).toEqual({
    status: PROVIDER_CONNECTION_MESSAGES.loading,
    rows: null,
    signedIn: true,
  });
  expect(describeProviderConnections(known({ connections: [] }))).toEqual({
    status: PROVIDER_CONNECTION_MESSAGES.empty,
    rows: null,
    signedIn: true,
  });
  const ready = describeProviderConnections(known());
  expect(ready.status).toBe("");
  expect(ready.rows).toEqual([
    {
      id: ID_1,
      kind: "claude",
      kindName: "Claude",
      label: "Work",
      createdAt: AT,
      status: "registered",
      statusName: "Registered",
      statusText: PROVIDER_CONNECTION_STATUS_TEXTS.registered.text,
    },
    {
      id: ID_2,
      kind: "codex",
      kindName: "Codex",
      label: "Home",
      createdAt: AT,
      status: "registered",
      statusName: "Registered",
      statusText: PROVIDER_CONNECTION_STATUS_TEXTS.registered.text,
    },
  ]);
  // A failed read shows its problem with what was read before, unknown.
  for (const problem of PROVIDER_CONNECTION_LIST_PROBLEMS) {
    const model = describeProviderConnections(
      known({
        status: "unavailable",
        problem,
        connections: [item(ID_1, "Work", { status: "unknown" })],
      } as Partial<ProviderConnectionListView>),
    );
    expect(model.status).toBe(PROVIDER_CONNECTION_PROBLEM_MESSAGES[problem]);
    expect(model.rows?.[0]?.statusName).toBe("Unknown");
    expect(model.signedIn).toBe(true);
  }
  // No status claims that a provider works: no credential is checked yet.
  for (const texts of Object.values(PROVIDER_CONNECTION_STATUS_TEXTS)) {
    expect(texts.name).not.toMatch(/ready|working|connected/iu);
  }
});

test("a label is trimmed and checked as the protocol checks it, characters counted as code points", () => {
  expect(providerConnectionLabelToSend("  Work account \n")).toBe(
    "Work account",
  );
  expect(providerConnectionLabelPrompt("")).toBe(
    PROVIDER_CONNECTION_MESSAGES.labelMissing,
  );
  expect(
    providerConnectionLabelPrompt(providerConnectionLabelToSend("   ")),
  ).toBe(PROVIDER_CONNECTION_MESSAGES.labelMissing);
  expect(providerConnectionLabelPrompt("x".repeat(64))).toBeUndefined();
  expect(providerConnectionLabelPrompt("x".repeat(65))).toBe(
    PROVIDER_CONNECTION_MESSAGES.labelTooLong,
  );
  // 64 characters of two UTF-16 code units each are within the limit.
  expect(providerConnectionLabelPrompt("\u{1F600}".repeat(64))).toBeUndefined();
  expect(providerConnectionLabelPrompt("\u{1F600}".repeat(65))).toBe(
    PROVIDER_CONNECTION_MESSAGES.labelTooLong,
  );
  for (const unsafe of ["a\nb", "a\tb", "a\u202Eb", "a\u200Bb", "a\u0000b"]) {
    expect(providerConnectionLabelPrompt(unsafe), JSON.stringify(unsafe)).toBe(
      PROVIDER_CONNECTION_MESSAGES.labelUnsafe,
    );
  }
  // What the protocol allows passes: joiners, variation selectors, and
  // text in any script.
  for (const safe of [
    "Work \u{1F469}\u200D\u{1F4BB}",
    "\u2764\uFE0F Home",
    "\u0130\u015F hesab\u0131",
  ]) {
    expect(providerConnectionLabelPrompt(safe), safe).toBeUndefined();
  }
});

test("every answer of a registration and a removal has its own sentence, with the wait for too_soon and rate_limited", () => {
  const register = (result: RegisterProviderConnectionResult) =>
    describeRegisterProviderConnection(
      RegisterProviderConnectionResultSchema.parse(result),
    );
  const remove = (result: RemoveProviderConnectionResult) =>
    describeRemoveProviderConnection(
      RemoveProviderConnectionResultSchema.parse(result),
    );
  expect(register({ outcome: "ok" })).toBe("The connection was added.");
  expect(remove({ outcome: "ok" })).toBe(
    "The connection was removed, and the permissions that named it were revoked.",
  );
  expect(register({ outcome: "unknown" })).toMatch(/not known whether/u);
  expect(remove({ outcome: "unknown" })).toMatch(/not known whether/u);
  const seen = new Set<string>();
  for (const reason of REGISTER_PROVIDER_CONNECTION_REFUSALS) {
    const waits = reason === "too_soon" || reason === "rate_limited";
    const sentence = register({
      outcome: "refused",
      reason,
      retryAfterMs: waits ? 90_000 : null,
    });
    expect(sentence, reason).toMatch(/^The connection was not added\. \S/u);
    expect(sentence, reason).not.toContain("undefined");
    if (waits) {
      expect(sentence, reason).toContain("2 minutes");
    }
    seen.add(sentence);
  }
  expect(seen.size).toBe(REGISTER_PROVIDER_CONNECTION_REFUSALS.length);
  expect(
    register({
      outcome: "refused",
      reason: "provider_connection_limit",
      retryAfterMs: null,
    }),
  ).toContain("already has 10 AI provider connections");
  expect(
    register({
      outcome: "refused",
      reason: "rate_limited",
      retryAfterMs: 3_600_000,
    }),
  ).toContain("at most 20 AI provider connections in 24 hours");
  seen.clear();
  for (const reason of REMOVE_PROVIDER_CONNECTION_REFUSALS) {
    const waits = reason === "too_soon" || reason === "rate_limited";
    const sentence = remove({
      outcome: "refused",
      reason,
      retryAfterMs: waits ? 5_000 : null,
    });
    expect(sentence, reason).toMatch(/^The connection was not removed\. \S/u);
    expect(sentence, reason).not.toContain("undefined");
    if (waits) {
      expect(sentence, reason).toContain("5 seconds");
    }
    seen.add(sentence);
  }
  expect(seen.size).toBe(REMOVE_PROVIDER_CONNECTION_REFUSALS.length);
});

test("following the connections reports each state, and a refused subscription makes the view unavailable", () => {
  const views: ProviderConnectionSectionView[] = [];
  let listener: ((state: ProviderConnectionListView) => void) | undefined;
  let onError: (() => void) | undefined;
  const stop = followProviderConnections(
    {
      subscribeState: (next, error) => {
        listener = next;
        onError = error;
        return () => views.push({ kind: "pending" });
      },
    },
    (view) => views.push(view),
  );
  const state = (known() as { state: ProviderConnectionListView }).state;
  listener?.(state);
  onError?.();
  stop();
  expect(views).toEqual([
    { kind: "known", state },
    { kind: "unavailable" },
    { kind: "pending" },
  ]);
});

function fakeBridge() {
  const calls: string[] = [];
  const pending: {
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  }[] = [];
  const answer = () =>
    new Promise<never>((resolve, reject) => {
      pending.push({
        resolve: resolve as (value: unknown) => void,
        reject,
      });
    });
  return {
    calls,
    pending,
    bridge: {
      register: (kind: string, label: string) => {
        calls.push(`register ${kind} ${JSON.stringify(label)}`);
        return answer();
      },
      remove: (id: string) => {
        calls.push(`remove ${id}`);
        return answer();
      },
    },
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

test("a registration sends the chosen kind and the trimmed label once, keeps a problem without sending, and empties the field after ok", async () => {
  const fake = fakeBridge();
  const views: ProviderConnectionActionsView[] = [];
  const actions = createProviderConnectionActions(fake.bridge, (view) =>
    views.push(view),
  );
  actions.follow(describeProviderConnections(known()));
  await actions.register();
  expect(views.at(-1)?.labelProblem).toBe(
    PROVIDER_CONNECTION_MESSAGES.labelMissing,
  );
  actions.editLabel("a\nb");
  await actions.register();
  expect(views.at(-1)?.labelProblem).toBe(
    PROVIDER_CONNECTION_MESSAGES.labelUnsafe,
  );
  expect(fake.calls).toEqual([]);
  actions.editKind("gemini");
  expect(views.at(-1)?.draftKind).toBe("claude");
  actions.editKind("codex");
  actions.editLabel("  Home  ");
  expect(views.at(-1)?.labelProblem).toBeUndefined();
  const pending = actions.register();
  expect(views.at(-1)).toMatchObject({ running: true, message: undefined });
  // While it runs, nothing else starts.
  await actions.register();
  actions.askRemove(describeProviderConnections(known()).rows![0]!);
  expect(views.at(-1)?.question).toBeUndefined();
  expect(fake.calls).toEqual(['register codex "Home"']);
  fake.pending[0]?.resolve({ outcome: "ok" });
  await pending;
  expect(views.at(-1)).toEqual({
    ...IDLE_PROVIDER_CONNECTION_ACTIONS,
    draftKind: "codex",
    message: "The connection was added.",
  });
});

test("a refused registration keeps the label and says why; a call that throws says that nothing was sent", async () => {
  const fake = fakeBridge();
  const views: ProviderConnectionActionsView[] = [];
  const actions = createProviderConnectionActions(fake.bridge, (view) =>
    views.push(view),
  );
  actions.follow(describeProviderConnections(known()));
  actions.editLabel("Work");
  const refused = actions.register();
  fake.pending[0]?.resolve({
    outcome: "refused",
    reason: "provider_connection_limit",
    retryAfterMs: null,
  });
  await refused;
  expect(views.at(-1)?.draftLabel).toBe("Work");
  expect(views.at(-1)?.message).toContain("Remove one first");
  const thrown = actions.register();
  fake.pending[1]?.reject(new Error("refused by the contract"));
  await thrown;
  expect(views.at(-1)?.message).toBe(
    `The connection was not added. ${PROVIDER_CONNECTION_NOT_SENT}`,
  );
});

test("a removal asks first, sends the listed ID once on confirm, and a cancel sends nothing", async () => {
  const fake = fakeBridge();
  const views: ProviderConnectionActionsView[] = [];
  const actions = createProviderConnectionActions(fake.bridge, (view) =>
    views.push(view),
  );
  const model = describeProviderConnections(known());
  actions.follow(model);
  const row = model.rows![1]!;
  actions.askRemove(row);
  expect(views.at(-1)?.question).toEqual({
    id: ID_2,
    label: "Home",
    kindName: "Codex",
  });
  actions.cancel();
  expect(views.at(-1)?.question).toBeUndefined();
  await expect(actions.confirm()).resolves.toBe(false);
  expect(fake.calls).toEqual([]);
  // A row that the model no longer lists opens no question.
  actions.askRemove({ ...row, id: "0192f0a0-7b3c-7d4e-8f50-000000000999" });
  expect(views.at(-1)?.question).toBeUndefined();
  actions.askRemove(row);
  const removed = actions.confirm();
  expect(views.at(-1)).toMatchObject({ running: true, question: undefined });
  await expect(actions.confirm()).resolves.toBe(false);
  expect(fake.calls).toEqual([`remove ${ID_2}`]);
  fake.pending[0]?.resolve({ outcome: "ok" });
  await expect(removed).resolves.toBe(true);
  expect(views.at(-1)?.message).toContain("permissions that named it");
  // A refusal resolves to false, so the focus stays.
  actions.askRemove(model.rows![0]!);
  const conflict = actions.confirm();
  fake.pending[1]?.resolve({
    outcome: "refused",
    reason: "conflict",
    retryAfterMs: null,
  });
  await expect(conflict).resolves.toBe(false);
  expect(views.at(-1)?.message).toContain("removed already");
});

test("the question ends when its connection leaves the list, and a sign-out drops the question, the field, and an answer that comes after it", async () => {
  const fake = fakeBridge();
  const views: ProviderConnectionActionsView[] = [];
  const actions = createProviderConnectionActions(fake.bridge, (view) =>
    views.push(view),
  );
  const model = describeProviderConnections(known());
  actions.follow(model);
  actions.askRemove(model.rows![0]!);
  actions.follow(
    describeProviderConnections(
      known({ connections: [item(ID_2, "Home", { kind: "codex" })] }),
    ),
  );
  expect(views.at(-1)?.question).toBeUndefined();
  actions.editLabel("Work");
  const pending = actions.register();
  actions.follow(
    describeProviderConnections(
      known({ status: "signed_out", connections: [] }),
    ),
  );
  expect(views.at(-1)?.draftLabel).toBe("");
  fake.pending[0]?.resolve({ outcome: "ok" });
  await pending;
  await settle();
  expect(views.at(-1)).toMatchObject({ running: false, message: undefined });
});
