// The credential of a Claude connection for a run (#30, the Project
// Manager's decisions of 2026-11-26): its API key and the model that the
// person chose for it on this device, read from the provider key store when
// a run starts. It is for the main process only: the executor that calls
// the Claude API holds the key for that run and drops it. No result of a
// failure holds the key, and this module never logs; a failure is one of
// a closed list of reasons.
//
// There is no default model. A key without a model of the closed list
// (models.ts), such as a key stored before models were chosen, is
// `model_missing`: the run fails, and the Account screen asks the person to
// choose one. The loader does not know the connection's kind; it is meant
// for the executor of Claude connections, which reads only their keys.
import { isProviderKeyError } from "./errors.ts";
import { type ClaudeModel, isClaudeModel } from "./models.ts";
import type { ProviderKeyStore } from "./store.ts";

/**
 * Why a Claude credential could not be loaded:
 *
 * - `not_signed_in`: no signed-in device, so no key can be opened.
 * - `invalid_connection`: the connection ID is not a lowercase UUIDv7.
 * - `credential_missing`: no usable key on this device: no key file, or one
 *   that is damaged or bound to another device or connection, as the
 *   connection's status `credential_missing` says.
 * - `model_missing`: a key is stored, but without a model of the closed
 *   list, as the connection's status `model_missing` says.
 * - `unreadable`: the key could not be read now, which may pass later: the
 *   system could not decrypt it, the folder or the file could not be read,
 *   or a newer version of the application wrote it.
 */
export const CLAUDE_CREDENTIAL_FAILURES = Object.freeze([
  "not_signed_in",
  "invalid_connection",
  "credential_missing",
  "model_missing",
  "unreadable",
] as const);
export type ClaudeCredentialFailure =
  (typeof CLAUDE_CREDENTIAL_FAILURES)[number];

/** A loaded credential, or the reason why there is none; never a key in a failure. */
export type ClaudeCredentialResult =
  | {
      readonly ok: true;
      readonly apiKey: string;
      readonly model: ClaudeModel;
    }
  | { readonly ok: false; readonly reason: ClaudeCredentialFailure };

/**
 * Loads the API key and the model of a Claude connection of this device.
 * Decrypts the key file at each call; nothing is cached. Never rejects.
 */
export type LoadClaudeCredential = (
  providerConnectionId: string,
) => Promise<ClaudeCredentialResult>;

export interface ClaudeCredentialLoaderOptions {
  /** The provider key store; only `read` is used. */
  readonly keys: Pick<ProviderKeyStore, "read">;
  /**
   * The ID of the device signed in now, or null; in production
   * `signedInDevice(account.status())` of the grant store. It may throw,
   * which counts as no device.
   */
  readonly deviceId: () => string | null;
}

function failed(reason: ClaudeCredentialFailure): ClaudeCredentialResult {
  return Object.freeze({ ok: false, reason });
}

/** The reason of a key store failure while a credential is read. */
function failureOf(error: unknown): ClaudeCredentialFailure {
  if (isProviderKeyError(error, "invalid_binding")) {
    return "invalid_connection";
  }
  if (
    isProviderKeyError(error, "missing") ||
    isProviderKeyError(error, "corrupt") ||
    isProviderKeyError(error, "bound_elsewhere")
  ) {
    return "credential_missing";
  }
  return "unreadable";
}

/**
 * The `loadClaudeCredential` of the main process: reads the connection's
 * key file for the device signed in now and returns the key and the model,
 * or a fixed reason.
 */
export function createClaudeCredentialLoader(
  options: ClaudeCredentialLoaderOptions,
): LoadClaudeCredential {
  const { keys } = options;
  return async (providerConnectionId: string) => {
    let deviceId: string | null;
    try {
      deviceId = options.deviceId();
    } catch {
      deviceId = null;
    }
    if (deviceId === null) {
      return failed("not_signed_in");
    }
    let credential: Awaited<ReturnType<ProviderKeyStore["read"]>>;
    try {
      credential = await keys.read({ deviceId, providerConnectionId });
    } catch (error) {
      return failed(failureOf(error));
    }
    if (!isClaudeModel(credential.model)) {
      return failed("model_missing");
    }
    return Object.freeze({
      ok: true,
      apiKey: credential.key,
      model: credential.model,
    });
  };
}
