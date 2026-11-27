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
  PROVIDER_KEY_LIMITS,
  REGISTER_PROVIDER_CONNECTION_REFUSALS,
  REMOVE_PROVIDER_CONNECTION_REFUSALS,
  REMOVE_PROVIDER_KEY_REFUSALS,
  RegisterProviderConnectionResultSchema,
  RemoveProviderConnectionResultSchema,
  SAVE_PROVIDER_KEY_REFUSALS,
  CLAUDE_MODEL_VIEWS,
  SET_PROVIDER_MODEL_REFUSALS,
} from "../shared/ipc-contract.ts";
import {
  CLAUDE_MODELS_OFFERED,
  claudeModelName,
  describeSetProviderModel,
  providerModelPrompt,
  SET_PROVIDER_MODEL_REFUSAL_MESSAGES,
  createProviderConnectionActions,
  describeProviderConnections,
  describeRegisterProviderConnection,
  describeRemoveProviderConnection,
  describeRemoveProviderKey,
  describeSaveProviderKey,
  followProviderConnections,
  IDLE_PROVIDER_CONNECTION_ACTIONS,
  initialProviderConnectionSectionView,
  LABEL_SAFE_PATTERN,
  MAX_NEW_PROVIDER_CONNECTIONS_PER_DAY,
  MAX_PROVIDER_CONNECTION_LABEL_LENGTH,
  MAX_PROVIDER_CONNECTIONS_PER_DEVICE,
  MAX_PROVIDER_KEY_LENGTH,
  PROVIDER_CONNECTION_MESSAGES,
  PROVIDER_CONNECTION_NOT_SENT,
  PROVIDER_CONNECTION_PROBLEM_MESSAGES,
  PROVIDER_CONNECTION_STATUS_TEXTS,
  PROVIDER_KINDS_OFFERED,
  providerConnectionLabelPrompt,
  providerConnectionLabelToSend,
  providerKeyPrompt,
  providerKeyToSend,
  REMOVE_PROVIDER_KEY_REFUSAL_MESSAGES,
  SAVE_PROVIDER_KEY_REFUSAL_MESSAGES,
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
    status: "credential_missing",
    model: null,
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
  expect(MAX_PROVIDER_KEY_LENGTH).toBe(PROVIDER_KEY_LIMITS.key);
  // The models offered are the contract's closed list, in its order (#30).
  expect(CLAUDE_MODELS_OFFERED.map((model) => model.id)).toEqual([
    ...CLAUDE_MODEL_VIEWS,
  ]);
  expect(CLAUDE_MODELS_OFFERED.map((model) => model.name)).toEqual([
    "Claude Fable 5.2",
    "Claude Opus 5.5",
    "Claude Sonnet 5.5",
    "Claude Haiku 5.5",
  ]);
  expect(Object.keys(SET_PROVIDER_MODEL_REFUSAL_MESSAGES).sort()).toEqual(
    [...SET_PROVIDER_MODEL_REFUSALS].sort(),
  );
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
      status: "credential_missing",
      statusName: "No API key",
      statusText: PROVIDER_CONNECTION_STATUS_TEXTS.credential_missing.text,
      keyAction: "enter",
      keyMayExist: false,
      needsModel: true,
      model: null,
      modelName: "None chosen",
      modelAction: null,
    },
    {
      id: ID_2,
      kind: "codex",
      kindName: "Codex",
      label: "Home",
      createdAt: AT,
      status: "credential_missing",
      statusName: "No API key",
      statusText: PROVIDER_CONNECTION_STATUS_TEXTS.credential_missing.text,
      keyAction: "enter",
      keyMayExist: false,
      needsModel: false,
      model: null,
      modelName: null,
      modelAction: null,
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
  // A stored key is "Ready" and is replaced, an unknown one may exist.
  const keyed = describeProviderConnections(
    known({
      connections: [
        item(ID_1, "Work", { status: "ready" }),
        item(ID_2, "Home", { status: "unknown" }),
      ],
    }),
  );
  expect(
    keyed.rows?.map((row) => [row.statusName, row.keyAction, row.keyMayExist]),
  ).toEqual([
    ["Ready", "replace", true],
    ["Unknown", "enter", true],
  ]);
  // No status claims that the provider accepts the key: none is checked
  // with it.
  for (const texts of Object.values(PROVIDER_CONNECTION_STATUS_TEXTS)) {
    expect(texts.name).not.toMatch(/working|connected|valid|accepted/iu);
    expect(texts.text).not.toMatch(/\bworks\b|is valid|was accepted/iu);
  }
  expect(PROVIDER_CONNECTION_STATUS_TEXTS.ready.text).toContain(
    "Whether the provider accepts it",
  );
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
      saveKey: (id: string, key: string, model: string | null) => {
        calls.push(`saveKey ${id} ${key} ${String(model)}`);
        return answer();
      },
      setModel: (id: string, model: string) => {
        calls.push(`setModel ${id} ${model}`);
        return answer();
      },
      removeKey: (id: string) => {
        calls.push(`removeKey ${id}`);
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
    needsModel: false,
    action: "remove",
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

// ---- API keys (#33) ---------------------------------------------------------

/** An obvious fake key; once sent, no view of the section may hold it. */
const SENTINEL_KEY = "FAKE-PROVIDER-KEY-SENTINEL-0123456789";

test("a key is trimmed and checked as the main process checks it, and a problem never names the key", () => {
  expect(providerKeyToSend(`  ${SENTINEL_KEY}\n`)).toBe(SENTINEL_KEY);
  expect(providerKeyPrompt(SENTINEL_KEY)).toBeUndefined();
  expect(
    providerKeyPrompt("k".repeat(MAX_PROVIDER_KEY_LENGTH)),
  ).toBeUndefined();
  expect(providerKeyPrompt("")).toBe(PROVIDER_CONNECTION_MESSAGES.keyMissing);
  expect(providerKeyPrompt("k".repeat(MAX_PROVIDER_KEY_LENGTH + 1))).toBe(
    PROVIDER_CONNECTION_MESSAGES.keyTooLong,
  );
  for (const key of [
    `${SENTINEL_KEY} x`,
    `${SENTINEL_KEY}\tx`,
    `${SENTINEL_KEY}\u0000`,
    `${SENTINEL_KEY}\u00a0x`,
    `${SENTINEL_KEY}\u200b`,
    `${SENTINEL_KEY}\ud800`,
  ]) {
    expect(providerKeyPrompt(key), JSON.stringify(key)).toBe(
      PROVIDER_CONNECTION_MESSAGES.keyUnsafe,
    );
  }
  for (const message of [
    PROVIDER_CONNECTION_MESSAGES.keyMissing,
    PROVIDER_CONNECTION_MESSAGES.keyTooLong,
    PROVIDER_CONNECTION_MESSAGES.keyUnsafe,
  ]) {
    expect(message).not.toContain(SENTINEL_KEY);
  }
});

test("every answer of storing and removing a key has its own sentence, and none holds a key", () => {
  expect(Object.keys(SAVE_PROVIDER_KEY_REFUSAL_MESSAGES).sort()).toEqual(
    [...SAVE_PROVIDER_KEY_REFUSALS].sort(),
  );
  expect(Object.keys(REMOVE_PROVIDER_KEY_REFUSAL_MESSAGES).sort()).toEqual(
    [...REMOVE_PROVIDER_KEY_REFUSALS].sort(),
  );
  expect(describeSaveProviderKey({ outcome: "ok" })).toBe(
    "The API key was stored on this device.",
  );
  expect(describeRemoveProviderKey({ outcome: "ok" })).toBe(
    "The API key was deleted from this device.",
  );
  for (const reason of SAVE_PROVIDER_KEY_REFUSALS) {
    expect(
      describeSaveProviderKey({
        outcome: "refused",
        reason,
        retryAfterMs: null,
      }),
    ).toBe(
      `The API key was not stored. ${SAVE_PROVIDER_KEY_REFUSAL_MESSAGES[reason]}`,
    );
  }
  expect(
    describeSaveProviderKey({
      outcome: "refused",
      reason: "protection_unavailable",
      retryAfterMs: null,
    }),
  ).toContain("secret service");
  for (const reason of REMOVE_PROVIDER_KEY_REFUSALS) {
    expect(
      describeRemoveProviderKey({
        outcome: "refused",
        reason,
        retryAfterMs: null,
      }),
    ).toContain(REMOVE_PROVIDER_KEY_REFUSAL_MESSAGES[reason]);
  }
  for (const describe of [describeSaveProviderKey, describeRemoveProviderKey]) {
    expect(
      describe({ outcome: "refused", reason: "busy", retryAfterMs: null }),
    ).toContain(
      "Another change of the AI provider connections or their API keys is still running.",
    );
  }
});

test("the key form opens empty for a listed connection, sends the trimmed key once, and is cleared as it is sent; ok closes it", async () => {
  const fake = fakeBridge();
  const views: ProviderConnectionActionsView[] = [];
  const actions = createProviderConnectionActions(fake.bridge, (view) =>
    views.push(view),
  );
  const model = describeProviderConnections(known());
  actions.follow(model);
  const row = model.rows![0]!;

  // Typing without an open form keeps nothing.
  actions.editKey(SENTINEL_KEY);
  expect(views).toEqual([]);
  // A row that the model does not list opens nothing.
  actions.askKey({ ...row, id: "0192f0a0-7b3c-7d4e-8f50-000000000999" });
  expect(views).toEqual([]);

  actions.askKey(row);
  expect(views.at(-1)).toMatchObject({
    keyFor: { id: ID_1, label: "Work", kindName: "Claude", needsModel: true },
    draftKey: "",
    keyProblem: undefined,
    // No model is chosen for the person.
    draftModel: "",
    modelProblem: undefined,
  });
  actions.editKey(`  ${SENTINEL_KEY}  `);
  expect(views.at(-1)?.draftKey).toBe(`  ${SENTINEL_KEY}  `);
  actions.editModel("claude-haiku-5-5");
  expect(views.at(-1)?.draftModel).toBe("claude-haiku-5-5");
  const sentAt = views.length;
  const pending = actions.saveKey();
  // The field is empty before the main process answers.
  expect(views.at(-1)).toMatchObject({ draftKey: "", running: true });
  expect(fake.calls).toEqual([
    `saveKey ${ID_1} ${SENTINEL_KEY} claude-haiku-5-5`,
  ]);
  // While it runs, nothing else starts and nothing is sent again.
  await actions.saveKey();
  actions.askKey(model.rows![1]!);
  expect(fake.calls).toHaveLength(1);
  fake.pending[0]?.resolve({ outcome: "ok" });
  await pending;
  expect(views.at(-1)).toEqual({
    ...IDLE_PROVIDER_CONNECTION_ACTIONS,
    message: "The API key was stored on this device.",
  });
  // From the send on, no view holds the key.
  expect(JSON.stringify(views.slice(sentAt))).not.toContain(SENTINEL_KEY);
});

test("a key with a problem is not sent and its field is cleared; a refusal keeps the form open and empty; cancel empties it", async () => {
  const fake = fakeBridge();
  const views: ProviderConnectionActionsView[] = [];
  const actions = createProviderConnectionActions(fake.bridge, (view) =>
    views.push(view),
  );
  const model = describeProviderConnections(known());
  actions.follow(model);
  const row = model.rows![1]!;
  actions.askKey(row);
  await actions.saveKey();
  expect(views.at(-1)?.keyProblem).toBe(
    PROVIDER_CONNECTION_MESSAGES.keyMissing,
  );
  actions.editKey(`${SENTINEL_KEY} more`);
  expect(views.at(-1)?.keyProblem).toBeUndefined();
  const before = views.length;
  await actions.saveKey();
  expect(views.at(-1)).toMatchObject({
    draftKey: "",
    keyProblem: PROVIDER_CONNECTION_MESSAGES.keyUnsafe,
    keyFor: { id: ID_2 },
  });
  expect(fake.calls).toEqual([]);
  expect(JSON.stringify(views.slice(before))).not.toContain(SENTINEL_KEY);

  actions.editKey(SENTINEL_KEY);
  const refused = actions.saveKey();
  // A Codex connection sends no model.
  expect(fake.calls).toEqual([`saveKey ${ID_2} ${SENTINEL_KEY} null`]);
  fake.pending[0]?.resolve({
    outcome: "refused",
    reason: "protection_unavailable",
    retryAfterMs: null,
  });
  await refused;
  expect(views.at(-1)).toMatchObject({
    running: false,
    draftKey: "",
    keyFor: { id: ID_2 },
  });
  expect(views.at(-1)?.message).toContain("cannot protect it");

  actions.editKey(SENTINEL_KEY);
  const thrown = actions.saveKey();
  fake.pending[1]?.reject(new Error("refused by the contract"));
  await thrown;
  expect(views.at(-1)?.message).toBe(
    `The API key was not stored. ${PROVIDER_CONNECTION_NOT_SENT}`,
  );
  expect(views.at(-1)?.draftKey).toBe("");

  actions.editKey(SENTINEL_KEY);
  actions.cancelKey();
  expect(views.at(-1)).toMatchObject({
    keyFor: undefined,
    draftKey: "",
    keyProblem: undefined,
  });
});

test("removing a key asks first and sends the listed ID once; the focus stays", async () => {
  const fake = fakeBridge();
  const views: ProviderConnectionActionsView[] = [];
  const actions = createProviderConnectionActions(fake.bridge, (view) =>
    views.push(view),
  );
  const model = describeProviderConnections(
    known({ connections: [item(ID_1, "Work", { status: "ready" })] }),
  );
  actions.follow(model);
  actions.askRemoveKey(model.rows![0]!);
  expect(views.at(-1)?.question).toEqual({
    id: ID_1,
    label: "Work",
    kindName: "Claude",
    needsModel: true,
    action: "removeKey",
  });
  actions.cancel();
  expect(fake.calls).toEqual([]);
  actions.askRemoveKey(model.rows![0]!);
  const removing = actions.confirm();
  expect(fake.calls).toEqual([`removeKey ${ID_1}`]);
  fake.pending[0]?.resolve({ outcome: "ok" });
  await expect(removing).resolves.toBe(false);
  expect(views.at(-1)?.message).toBe(
    "The API key was deleted from this device.",
  );
});

test("a sign-out or a connection that leaves the list closes the key form and drops the typed key", () => {
  const fake = fakeBridge();
  const views: ProviderConnectionActionsView[] = [];
  const actions = createProviderConnectionActions(fake.bridge, (view) =>
    views.push(view),
  );
  const model = describeProviderConnections(known());
  actions.follow(model);
  actions.askKey(model.rows![0]!);
  actions.editKey(SENTINEL_KEY);
  actions.follow(
    describeProviderConnections(
      known({ connections: [item(ID_2, "Home", { kind: "codex" })] }),
    ),
  );
  expect(views.at(-1)).toMatchObject({ keyFor: undefined, draftKey: "" });

  actions.follow(model);
  actions.askKey(model.rows![1]!);
  actions.editKey(SENTINEL_KEY);
  actions.follow(
    describeProviderConnections(
      known({ status: "signed_out", connections: [] }),
    ),
  );
  expect(views.at(-1)).toMatchObject({ keyFor: undefined, draftKey: "" });
  expect(JSON.stringify(views.at(-1))).not.toContain(SENTINEL_KEY);
  expect(fake.calls).toEqual([]);
});

test("opening the key form of another connection never carries over what was typed", () => {
  const fake = fakeBridge();
  const views: ProviderConnectionActionsView[] = [];
  const actions = createProviderConnectionActions(fake.bridge, (view) =>
    views.push(view),
  );
  const model = describeProviderConnections(known());
  actions.follow(model);
  actions.askKey(model.rows![0]!);
  actions.editKey(SENTINEL_KEY);
  actions.askKey(model.rows![1]!);
  expect(views.at(-1)).toMatchObject({
    keyFor: { id: ID_2 },
    draftKey: "",
    keyProblem: undefined,
  });
  // Opening the same connection's form again starts empty too.
  actions.editKey(SENTINEL_KEY);
  actions.askKey(model.rows![1]!);
  expect(views.at(-1)?.draftKey).toBe("");
  expect(fake.calls).toEqual([]);
});

// ---- The model of a Claude connection (#30) ------------------------------

test("a Claude connection shows its model, offers to change it once its key is stored, and asks for one without it; another kind has none", () => {
  const model = describeProviderConnections(
    known({
      connections: [
        item(ID_1, "Work", { status: "ready", model: "claude-opus-5-5" }),
        item(ID_2, "Home", { status: "model_missing" }),
        item("0192f0a0-7b3c-7d4e-8f50-000000000103", "Codex", {
          kind: "codex",
          status: "ready",
        }),
        item("0192f0a0-7b3c-7d4e-8f50-000000000104", "New", {}),
      ],
    }),
  );
  expect(
    model.rows?.map((row) => [
      row.statusName,
      row.keyAction,
      row.keyMayExist,
      row.needsModel,
      row.model,
      row.modelName,
      row.modelAction,
    ]),
  ).toEqual([
    [
      "Ready",
      "replace",
      true,
      true,
      "claude-opus-5-5",
      "Claude Opus 5.5",
      "change",
    ],
    ["No model chosen", "replace", true, true, null, "None chosen", "choose"],
    ["Ready", "replace", true, false, null, null, null],
    ["No API key", "enter", false, true, null, "None chosen", null],
  ]);
  expect(PROVIDER_CONNECTION_STATUS_TEXTS.model_missing.text).toContain(
    "no model is chosen",
  );
  // A model that the renderer does not know is never shown by its ID.
  const strange = describeProviderConnections(
    known({
      connections: [
        item(ID_1, "Work", {
          status: "ready",
          model: "claude-unknown" as "claude-opus-5-5",
        }),
      ],
    }),
  );
  expect(strange.rows?.[0]?.modelName).toBe("None chosen");
});

test("a model is checked against the closed list before it is sent, and every answer of changing it has its own sentence", () => {
  expect(claudeModelName("claude-sonnet-5-5")).toBe("Claude Sonnet 5.5");
  expect(claudeModelName("claude-opus-4-8")).toBeUndefined();
  for (const model of CLAUDE_MODEL_VIEWS) {
    expect(providerModelPrompt(model)).toBeUndefined();
  }
  for (const model of ["", "claude-opus-4-8", "Claude Opus 5.5", "x"]) {
    expect(providerModelPrompt(model)).toBe(
      PROVIDER_CONNECTION_MESSAGES.modelMissing,
    );
  }
  expect(describeSetProviderModel({ outcome: "ok" })).toBe(
    "The model was stored on this device.",
  );
  for (const reason of SET_PROVIDER_MODEL_REFUSALS) {
    expect(
      describeSetProviderModel({
        outcome: "refused",
        reason,
        retryAfterMs: null,
      }),
    ).toBe(
      `The model was not stored. ${SET_PROVIDER_MODEL_REFUSAL_MESSAGES[reason]}`,
    );
  }
  expect(SAVE_PROVIDER_KEY_REFUSAL_MESSAGES.invalid_model).toContain(
    "Choose one of the models",
  );
});

test("a Claude key is never sent without a model: the person chooses one, nothing is chosen for them, and an earlier choice is kept", async () => {
  const fake = fakeBridge();
  const views: ProviderConnectionActionsView[] = [];
  const actions = createProviderConnectionActions(fake.bridge, (view) =>
    views.push(view),
  );
  const model = describeProviderConnections(
    known({
      connections: [
        item(ID_1, "Work"),
        item(ID_2, "Home", { status: "ready", model: "claude-opus-5-5" }),
      ],
    }),
  );
  actions.follow(model);
  actions.askKey(model.rows![0]!);
  actions.editKey(SENTINEL_KEY);
  await actions.saveKey();
  expect(views.at(-1)).toMatchObject({
    draftKey: "",
    keyProblem: undefined,
    modelProblem: PROVIDER_CONNECTION_MESSAGES.modelMissing,
    keyFor: { id: ID_1 },
  });
  // A value outside the list is not sent either.
  actions.editModel("claude-opus-4-8");
  expect(views.at(-1)?.modelProblem).toBeUndefined();
  actions.editKey(SENTINEL_KEY);
  await actions.saveKey();
  expect(views.at(-1)?.modelProblem).toBe(
    PROVIDER_CONNECTION_MESSAGES.modelMissing,
  );
  expect(fake.calls).toEqual([]);

  // Replacing the key of a connection with a model keeps its model chosen.
  actions.askKey(model.rows![1]!);
  expect(views.at(-1)).toMatchObject({
    keyFor: { id: ID_2 },
    draftModel: "claude-opus-5-5",
    draftKey: "",
  });
  actions.editKey(SENTINEL_KEY);
  const pending = actions.saveKey();
  expect(fake.calls).toEqual([
    `saveKey ${ID_2} ${SENTINEL_KEY} claude-opus-5-5`,
  ]);
  fake.pending[0]?.resolve({ outcome: "ok" });
  await pending;
  expect(views.at(-1)).toEqual({
    ...IDLE_PROVIDER_CONNECTION_ACTIONS,
    message: "The API key was stored on this device.",
  });
});

test("the model form changes the model of a stored key without the key, once, and closes on ok", async () => {
  const fake = fakeBridge();
  const views: ProviderConnectionActionsView[] = [];
  const actions = createProviderConnectionActions(fake.bridge, (view) =>
    views.push(view),
  );
  const model = describeProviderConnections(
    known({
      connections: [
        item(ID_1, "Work", { status: "ready", model: "claude-opus-5-5" }),
        item(ID_2, "Home", { status: "model_missing" }),
        item("0192f0a0-7b3c-7d4e-8f50-000000000103", "Codex", {
          kind: "codex",
          status: "ready",
        }),
        item("0192f0a0-7b3c-7d4e-8f50-000000000104", "New", {}),
      ],
    }),
  );
  actions.follow(model);
  // No model form for a row without a model action.
  actions.askModel(model.rows![2]!);
  actions.askModel(model.rows![3]!);
  expect(views).toEqual([]);

  // A key form open before is closed, and its key dropped.
  actions.askKey(model.rows![0]!);
  actions.editKey(SENTINEL_KEY);
  actions.askModel(model.rows![1]!);
  expect(views.at(-1)).toMatchObject({
    keyFor: undefined,
    draftKey: "",
    modelFor: { id: ID_2, label: "Home", needsModel: true },
    draftModel: "",
    modelProblem: undefined,
  });
  await actions.saveModel();
  expect(views.at(-1)?.modelProblem).toBe(
    PROVIDER_CONNECTION_MESSAGES.modelMissing,
  );
  expect(fake.calls).toEqual([]);

  actions.editModel("claude-sonnet-5-5");
  const refused = actions.saveModel();
  expect(views.at(-1)).toMatchObject({ running: true });
  // While it runs, nothing else is sent.
  await actions.saveModel();
  expect(fake.calls).toEqual([`setModel ${ID_2} claude-sonnet-5-5`]);
  fake.pending[0]?.resolve({
    outcome: "refused",
    reason: "credential_missing",
    retryAfterMs: null,
  });
  await refused;
  expect(views.at(-1)).toMatchObject({
    running: false,
    modelFor: { id: ID_2 },
    draftModel: "claude-sonnet-5-5",
  });
  expect(views.at(-1)?.message).toBe(
    `The model was not stored. ${SET_PROVIDER_MODEL_REFUSAL_MESSAGES.credential_missing}`,
  );

  const done = actions.saveModel();
  fake.pending[1]?.resolve({ outcome: "ok" });
  await done;
  expect(views.at(-1)).toEqual({
    ...IDLE_PROVIDER_CONNECTION_ACTIONS,
    message: "The model was stored on this device.",
  });

  // The model form of a ready connection starts with its model.
  actions.askModel(model.rows![0]!);
  expect(views.at(-1)?.draftModel).toBe("claude-opus-5-5");
  actions.cancelModel();
  expect(views.at(-1)).toMatchObject({ modelFor: undefined, draftModel: "" });
  expect(fake.calls).toHaveLength(2);
  // No view of the model form ever held the key typed before it opened.
  const opened = views.findIndex((view) => view.modelFor !== undefined);
  expect(JSON.stringify(views.slice(opened))).not.toContain(SENTINEL_KEY);
});

test("the model form closes when its connection leaves the list, loses its key, or the device signs out", () => {
  const fake = fakeBridge();
  const views: ProviderConnectionActionsView[] = [];
  const actions = createProviderConnectionActions(fake.bridge, (view) =>
    views.push(view),
  );
  const ready = describeProviderConnections(
    known({
      connections: [
        item(ID_1, "Work", { status: "ready", model: "claude-opus-5-5" }),
      ],
    }),
  );
  actions.follow(ready);
  actions.askModel(ready.rows![0]!);
  expect(views.at(-1)?.modelFor?.id).toBe(ID_1);
  // The key was removed elsewhere: no model to change.
  actions.follow(
    describeProviderConnections(known({ connections: [item(ID_1, "Work")] })),
  );
  expect(views.at(-1)).toMatchObject({ modelFor: undefined, draftModel: "" });

  actions.follow(ready);
  actions.askModel(ready.rows![0]!);
  actions.follow(describeProviderConnections(known({ connections: [] })));
  expect(views.at(-1)?.modelFor).toBeUndefined();

  actions.follow(ready);
  actions.askModel(ready.rows![0]!);
  actions.follow(
    describeProviderConnections(
      known({ status: "signed_out", connections: [] }),
    ),
  );
  expect(views.at(-1)).toMatchObject({ modelFor: undefined, draftModel: "" });
  expect(fake.calls).toEqual([]);
});
