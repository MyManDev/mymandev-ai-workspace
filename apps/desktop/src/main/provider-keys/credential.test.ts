import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PROVIDER_KINDS } from "@mymandev/protocol";
import { afterEach, beforeEach, expect, test } from "vitest";
import { CLAUDE_MODEL_VIEWS } from "../../shared/ipc-contract.ts";
import type { SystemKeyProtection } from "../device-key/store.ts";
import {
  CLAUDE_CREDENTIAL_FAILURES,
  type ClaudeCredentialResult,
  createClaudeCredentialLoader,
} from "./credential.ts";
import {
  PROVIDER_KEY_ERROR_CODES,
  ProviderKeyError,
  type ProviderKeyErrorCode,
} from "./errors.ts";
import type { ProviderCredential } from "./key-file.ts";
import {
  CLAUDE_MODELS,
  type ClaudeModel,
  isClaudeModel,
  isStorableModel,
  kindNeedsModel,
} from "./models.ts";
import { createProviderKeyStore } from "./store.ts";

// The credential of a Claude connection for slice A of #30: the key and the
// model chosen with it, read when a run starts, with a closed list of
// failures that never hold the key, and no default model.

/** An obvious fake key that no failure may hold. */
const SENTINEL_KEY = "FAKE-CLAUDE-KEY-SENTINEL-0123456789";
const DEVICE_ID = "0192f0a0-7b3c-7d4e-8f50-000000000004";
const OTHER_DEVICE_ID = "0192f0a0-7b3c-7d4e-8f50-000000000014";
const CONNECTION = "0192f0a0-7b3c-7d4e-8f50-000000000101";

/** The provider connection service's answer for a listed Claude connection. */
const listedClaude = () => "claude";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mymandev-claude-credential-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * A `safeStorage` stand-in for Windows that reverses the bytes: enough for
 * a round trip through the real store, which these tests are about, not
 * the encryption, which store.test.ts covers.
 */
const reversingSafeStorage: SystemKeyProtection = {
  isAsyncEncryptionAvailable: () => Promise.resolve(true),
  getSelectedStorageBackend: () => "unknown",
  encryptStringAsync: (plainText) =>
    Promise.resolve(Buffer.from(plainText, "utf8").reverse()),
  decryptStringAsync: (encrypted) =>
    Promise.resolve({
      shouldReEncrypt: false,
      result: Buffer.from(encrypted).reverse().toString("utf8"),
    }),
};

function realStore() {
  return createProviderKeyStore({
    folder: () => path.join(root, "MyManDev"),
    platform: "win32",
    systemProtection: reversingSafeStorage,
  });
}

/** Every result of a test, to check that no failure names the key. */
function expectNoKeyIn(result: ClaudeCredentialResult): void {
  if (!result.ok) {
    expect(JSON.stringify(result)).not.toContain(SENTINEL_KEY);
    expect(Object.keys(result)).toEqual(["ok", "reason"]);
    expect(CLAUDE_CREDENTIAL_FAILURES).toContain(result.reason);
  }
}

test("the closed list of Claude models is the contract's, Fable 5.2 and the current Opus, Sonnet, and Haiku, and nothing else is a model", () => {
  expect(CLAUDE_MODELS).toEqual([
    "claude-fable-5-2",
    "claude-opus-5-5",
    "claude-sonnet-5-5",
    "claude-haiku-5-5",
  ]);
  expect(CLAUDE_MODELS).toBe(CLAUDE_MODEL_VIEWS);
  expect(Object.isFrozen(CLAUDE_MODELS)).toBe(true);
  for (const model of CLAUDE_MODELS) {
    expect(isClaudeModel(model)).toBe(true);
    expect(isStorableModel(model)).toBe(true);
  }
  expect(isStorableModel(null)).toBe(true);
  for (const value of [
    null,
    undefined,
    "",
    "claude-opus-5-5 ",
    "CLAUDE-OPUS-5-5",
    "claude-opus-5-5-20260401",
    "claude-opus-4-8",
    "claude-fable-5-1",
    "claude-mythos-5-2",
    "claude",
    7,
    ["claude-opus-5-5"],
  ]) {
    expect(isClaudeModel(value), String(value)).toBe(false);
  }
  expect(isStorableModel(undefined)).toBe(false);
  expect(isStorableModel("claude-opus-4-8")).toBe(false);
  // Only a Claude connection has a model to choose, so far.
  expect(PROVIDER_KINDS.filter(kindNeedsModel)).toEqual(["claude"]);
});

test("loadClaudeCredential returns the key and the model of a key stored with a model, and decrypts at each call", async () => {
  const store = realStore();
  let reads = 0;
  const load = createClaudeCredentialLoader({
    keys: {
      read: (binding) => {
        reads += 1;
        return store.read(binding);
      },
    },
    deviceId: () => DEVICE_ID,
    connectionKind: listedClaude,
  });
  await store.save(
    { deviceId: DEVICE_ID, providerConnectionId: CONNECTION },
    SENTINEL_KEY,
    "claude-sonnet-5-5",
  );
  expect(await load(CONNECTION)).toEqual({
    ok: true,
    apiKey: SENTINEL_KEY,
    model: "claude-sonnet-5-5",
  });
  await store.setModel(
    { deviceId: DEVICE_ID, providerConnectionId: CONNECTION },
    "claude-haiku-5-5",
  );
  expect(await load(CONNECTION)).toEqual({
    ok: true,
    apiKey: SENTINEL_KEY,
    model: "claude-haiku-5-5",
  });
  expect(reads).toBe(2);
});

test("there is no default model: a key without a model of the closed list is model_missing", async () => {
  const store = realStore();
  const load = createClaudeCredentialLoader({
    keys: store,
    deviceId: () => DEVICE_ID,
    connectionKind: listedClaude,
  });
  await store.save(
    { deviceId: DEVICE_ID, providerConnectionId: CONNECTION },
    SENTINEL_KEY,
    null,
  );
  const missing = await load(CONNECTION);
  expect(missing).toEqual({ ok: false, reason: "model_missing" });
  expectNoKeyIn(missing);

  // A key stored before models were chosen, and a model that this version
  // no longer offers.
  for (const model of [null, "claude-opus-4-8", "claude-opus-9-9"]) {
    const fake = createClaudeCredentialLoader({
      keys: {
        read: () =>
          Promise.resolve<ProviderCredential>({ key: SENTINEL_KEY, model }),
      },
      deviceId: () => DEVICE_ID,
      connectionKind: listedClaude,
    });
    const result = await fake(CONNECTION);
    expect(result, String(model)).toEqual({
      ok: false,
      reason: "model_missing",
    });
    expectNoKeyIn(result);
  }
});

test("loadClaudeCredential maps every failure to a fixed reason that never holds the key", async () => {
  const store = realStore();
  // Signed out: nothing is read.
  for (const deviceId of [
    () => null,
    () => {
      throw new Error(`no device ${SENTINEL_KEY}`);
    },
  ]) {
    let read = false;
    const load = createClaudeCredentialLoader({
      keys: {
        read: () => {
          read = true;
          return Promise.reject(new Error("unreachable"));
        },
      },
      deviceId,
      connectionKind: listedClaude,
    });
    expect(await load(CONNECTION)).toEqual({
      ok: false,
      reason: "not_signed_in",
    });
    expect(read).toBe(false);
  }

  const load = createClaudeCredentialLoader({
    keys: store,
    deviceId: () => DEVICE_ID,
    connectionKind: listedClaude,
  });
  // No file, an ID outside the format, and a file of another device.
  expect(await load(CONNECTION)).toEqual({
    ok: false,
    reason: "credential_missing",
  });
  for (const id of ["", "not-an-id", CONNECTION.toUpperCase()]) {
    expect(await load(id), id).toEqual({
      ok: false,
      reason: "invalid_connection",
    });
  }
  await store.save(
    { deviceId: OTHER_DEVICE_ID, providerConnectionId: CONNECTION },
    SENTINEL_KEY,
    "claude-opus-5-5",
  );
  const elsewhere = await load(CONNECTION);
  expect(elsewhere).toEqual({ ok: false, reason: "credential_missing" });
  expectNoKeyIn(elsewhere);

  // Each code of the store, and an error that is not the store's.
  const expected: Record<ProviderKeyErrorCode, string> = {
    folder_unavailable: "unreadable",
    system_protection_unavailable: "unreadable",
    invalid_key: "unreadable",
    invalid_model: "unreadable",
    // The connection ID was checked before the read: only the device ID
    // can be invalid there.
    invalid_binding: "not_signed_in",
    missing: "credential_missing",
    unreadable: "unreadable",
    corrupt: "credential_missing",
    newer_format: "unreadable",
    bound_elsewhere: "credential_missing",
    read_failed: "unreadable",
    write_failed: "unreadable",
    delete_failed: "unreadable",
  };
  expect(Object.keys(expected).sort()).toEqual(
    [...PROVIDER_KEY_ERROR_CODES].sort(),
  );
  for (const code of PROVIDER_KEY_ERROR_CODES) {
    const failing = createClaudeCredentialLoader({
      keys: { read: () => Promise.reject(new ProviderKeyError(code)) },
      deviceId: () => DEVICE_ID,
      connectionKind: listedClaude,
    });
    const result = await failing(CONNECTION);
    expect(result, code).toEqual({ ok: false, reason: expected[code] });
    expectNoKeyIn(result);
  }
  const strange = createClaudeCredentialLoader({
    keys: {
      read: () => Promise.reject(new Error(`decrypted ${SENTINEL_KEY}`)),
    },
    deviceId: () => DEVICE_ID,
    connectionKind: listedClaude,
  });
  const result = await strange(CONNECTION);
  expect(result).toEqual({ ok: false, reason: "unreadable" });
  expectNoKeyIn(result);
});

test("the loader fails closed: no key is read for an invalid ID, without a device, or for a connection that is not a listed Claude connection", async () => {
  const store = realStore();
  await store.save(
    { deviceId: DEVICE_ID, providerConnectionId: CONNECTION },
    SENTINEL_KEY,
    "claude-opus-5-5",
  );
  const asked: string[] = [];
  function loaderWith(
    deviceId: () => string | null,
    connectionKind: (id: string) => string | null,
  ) {
    return createClaudeCredentialLoader({
      keys: {
        read: (binding) => {
          asked.push(`read:${binding.providerConnectionId}`);
          return store.read(binding);
        },
      },
      deviceId: () => {
        asked.push("device");
        return deviceId();
      },
      connectionKind: (id) => {
        asked.push(`kind:${id}`);
        return connectionKind(id);
      },
    });
  }

  // An ID outside the format: nothing else is asked.
  const listed = loaderWith(() => DEVICE_ID, listedClaude);
  for (const id of [
    "",
    "not-an-id",
    CONNECTION.toUpperCase(),
    `${CONNECTION}/`,
  ]) {
    expect(await listed(id), id).toEqual({
      ok: false,
      reason: "invalid_connection",
    });
  }
  expect(asked).toEqual([]);

  // Signed out: the service is not asked, and nothing is read.
  expect(await loaderWith(() => null, listedClaude)(CONNECTION)).toEqual({
    ok: false,
    reason: "not_signed_in",
  });
  expect(asked).toEqual(["device"]);
  asked.length = 0;

  // Not listed (also after a confirmed removal, whose key file may stay),
  // a lookup that throws, and a connection of another kind: the key file
  // exists, but it is never read.
  const refusals: [(id: string) => string | null, string][] = [
    [() => null, "not_listed"],
    [
      () => {
        throw new Error(`lookup failed ${SENTINEL_KEY}`);
      },
      "not_listed",
    ],
    [() => "codex", "not_claude"],
    [() => "", "not_claude"],
    [() => "Claude", "not_claude"],
  ];
  for (const [connectionKind, reason] of refusals) {
    const result = await loaderWith(
      () => DEVICE_ID,
      connectionKind,
    )(CONNECTION);
    expect(result, reason).toEqual({ ok: false, reason });
    expectNoKeyIn(result);
  }
  expect(asked.filter((entry) => entry.startsWith("read:"))).toEqual([]);
  expect(asked.filter((entry) => entry.startsWith("kind:"))).toEqual(
    refusals.map(() => `kind:${CONNECTION}`),
  );
  asked.length = 0;

  // A listed Claude connection: the key is read, after the checks.
  expect(await listed(CONNECTION)).toEqual({
    ok: true,
    apiKey: SENTINEL_KEY,
    model: "claude-opus-5-5",
  });
  expect(asked).toEqual(["device", `kind:${CONNECTION}`, `read:${CONNECTION}`]);
});

test("a device ID that is not one is not_signed_in, never invalid_connection", async () => {
  const store = realStore();
  for (const deviceId of ["", "not-a-device", DEVICE_ID.toUpperCase()]) {
    const load = createClaudeCredentialLoader({
      keys: store,
      deviceId: () => deviceId,
      connectionKind: listedClaude,
    });
    const result = await load(CONNECTION);
    expect(result, deviceId).toEqual({ ok: false, reason: "not_signed_in" });
    expectNoKeyIn(result);
  }
});

test("the loader's module never logs, and never imports Electron or anything of the renderer", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const name of ["credential.ts", "models.ts"]) {
    const text = readFileSync(path.join(here, name), "utf8");
    expect(text, name).not.toMatch(/\bconsole\./);
    expect(text, name).not.toMatch(/from "electron"/);
    expect(text, name).not.toMatch(/renderer\//);
  }
  // The type of a model is the contract's.
  const model: ClaudeModel = "claude-opus-5-5";
  expect(isClaudeModel(model)).toBe(true);
});
