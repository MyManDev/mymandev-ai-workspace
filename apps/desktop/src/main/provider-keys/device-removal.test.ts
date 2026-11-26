import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { deletingProviderKeys } from "./device-removal.ts";
import { ProviderKeyError } from "./errors.ts";

// Removing the device deletes every provider key file, as it deletes the
// device key (#33, D4). The session tests run the real device session with
// this wrapper: a removal deletes them, a sign-out keeps them.

function fakeStores() {
  const calls: string[] = [];
  const reports: string[] = [];
  const state = { failDevice: false, failProvider: false };
  const keyStore = {
    keys: () => "held",
    delete: async () => {
      calls.push("device.delete");
      await Promise.resolve();
      if (state.failDevice) {
        throw new Error("the device key could not be deleted");
      }
    },
  };
  const providerKeys = {
    removeAll: async () => {
      calls.push("provider.removeAll");
      await Promise.resolve();
      if (state.failProvider) {
        throw new ProviderKeyError("delete_failed");
      }
    },
  };
  const wrapped = deletingProviderKeys(keyStore, providerKeys, (message) =>
    reports.push(message),
  );
  return { calls, reports, state, wrapped };
}

test("deleting the device key deletes every provider key file after it, and keeps every other member", async () => {
  const { calls, reports, wrapped } = fakeStores();
  expect(wrapped.keys()).toBe("held");
  expect(Object.isFrozen(wrapped)).toBe(true);
  expect(calls).toEqual([]);
  await wrapped.delete();
  expect(calls).toEqual(["device.delete", "provider.removeAll"]);
  expect(reports).toEqual([]);
});

test("a device key that cannot be deleted keeps the provider keys, because the device stays", async () => {
  const { calls, state, wrapped } = fakeStores();
  state.failDevice = true;
  await expect(wrapped.delete()).rejects.toThrow(
    "the device key could not be deleted",
  );
  expect(calls).toEqual(["device.delete"]);
});

test("a provider key file that cannot be deleted is reported with fixed text and does not undo the device key's deletion", async () => {
  const { calls, reports, state, wrapped } = fakeStores();
  state.failProvider = true;
  await expect(wrapped.delete()).resolves.toBeUndefined();
  expect(calls).toEqual(["device.delete", "provider.removeAll"]);
  expect(reports).toEqual([
    "The provider keys could not be deleted with the device key.",
  ]);
});

/** `source` without its block and line comments. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function mainSource(file: string): string {
  return withoutComments(readFileSync(new URL(file, import.meta.url), "utf8"));
}

test("production wraps the one device key store that the flow and the session use, and the entry point passes the provider key store to it and to the connections", () => {
  // account-system.ts and index.ts start Electron, so no test runs them;
  // their wiring is read from the source, as enforcement-wiring.test.ts
  // does.
  const accountSystem = mainSource("../account-system.ts");
  expect(accountSystem.match(/\bcreateSystemDeviceKeyStore\(/g)).toHaveLength(
    1,
  );
  expect(accountSystem).toMatch(
    /const keyStore = deletingProviderKeys\(\s*createSystemDeviceKeyStore\(options\.onError\),\s*options\.providerKeys,/,
  );
  expect(accountSystem).toMatch(/\breturn \{\s*keyStore,/);

  const entry = mainSource("../index.ts");
  expect(entry.match(/\bcreateSystemProviderKeyStore\(/g)).toHaveLength(1);
  expect(entry).toMatch(/const providerKeys = createSystemProviderKeyStore\(/);
  expect(entry).toMatch(
    /createSystemAccountService\(\{[\s\S]*?\n\s*providerKeys,\n[\s\S]*?\}\);/,
  );
  expect(entry).toMatch(
    /createProviderConnectionService\(\{[\s\S]*?\n\s*keys: providerKeys,\n[\s\S]*?\}\);/,
  );
  // The store is created before the account service, which needs it.
  expect(entry.indexOf("createSystemProviderKeyStore(")).toBeLessThan(
    entry.indexOf("createSystemAccountService("),
  );
});
