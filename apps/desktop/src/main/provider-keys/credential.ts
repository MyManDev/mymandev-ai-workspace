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
// choose one.
//
// The loader fails closed: it opens a key only for a connection that the
// provider connection service lists now, whose kind is `claude`, and whose
// removal the server did not confirm, and it asks again once the read
// answered, so that a removal confirmed while the key was read still
// withholds the key. A key file that outlived its connection, such as one
// whose deletion failed after a confirmed removal, or the key of a
// connection of another kind is never read for a run.
import { isProviderKeyError } from "./errors.ts";
import { checkConnectionId } from "./key-file.ts";
import { type ClaudeModel, isClaudeModel } from "./models.ts";
import type { ProviderKeyStore } from "./store.ts";

/**
 * Why a Claude credential could not be loaded:
 *
 * - `invalid_connection`: the connection ID is not a lowercase UUIDv7.
 * - `not_signed_in`: no signed-in device, or a device ID that is not one,
 *   so no key can be opened.
 * - `not_listed`: the provider connection service does not list the
 *   connection now, or the server confirmed its removal; nothing is read.
 * - `not_claude`: the connection is listed, but of another kind; nothing
 *   is read.
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
  "invalid_connection",
  "not_signed_in",
  "not_listed",
  "not_claude",
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
  /**
   * The kind of a connection that the provider connection service lists
   * now and whose removal the server did not confirm, or null; in
   * production `connectionKind` of the provider connection service. It may
   * throw, which counts as a connection that is not listed.
   */
  readonly connectionKind: (providerConnectionId: string) => string | null;
}

function failed(reason: ClaudeCredentialFailure): ClaudeCredentialResult {
  return Object.freeze({ ok: false, reason });
}

/**
 * The reason of a key store failure while a credential is read. The
 * connection ID was checked before the read, so an `invalid_binding` can
 * only come from the device ID: a device ID that is not one is no
 * signed-in device whose key can be opened.
 */
function failureOf(error: unknown): ClaudeCredentialFailure {
  if (isProviderKeyError(error, "invalid_binding")) {
    return "not_signed_in";
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

/** Whether `providerConnectionId` is a lowercase UUIDv7. */
function isConnectionId(providerConnectionId: string): boolean {
  try {
    checkConnectionId(providerConnectionId);
    return true;
  } catch {
    return false;
  }
}

/**
 * The `loadClaudeCredential` of the main process: checks the connection ID,
 * the signed-in device, and that the connection is a listed Claude
 * connection, then reads the connection's key file for that device, checks
 * the connection's kind again once the read answered, and returns the key
 * and the model, or a fixed reason.
 */
export function createClaudeCredentialLoader(
  options: ClaudeCredentialLoaderOptions,
): LoadClaudeCredential {
  const { keys } = options;

  /** Why the connection is not a listed Claude connection now, or null. */
  function kindRefusal(
    providerConnectionId: string,
  ): "not_listed" | "not_claude" | null {
    let kind: string | null;
    try {
      kind = options.connectionKind(providerConnectionId);
    } catch {
      kind = null;
    }
    if (kind === null) {
      return "not_listed";
    }
    return kind === "claude" ? null : "not_claude";
  }

  return async (providerConnectionId: string) => {
    if (!isConnectionId(providerConnectionId)) {
      return failed("invalid_connection");
    }
    let deviceId: string | null;
    try {
      deviceId = options.deviceId();
    } catch {
      deviceId = null;
    }
    if (deviceId === null) {
      return failed("not_signed_in");
    }
    const before = kindRefusal(providerConnectionId);
    if (before !== null) {
      return failed(before);
    }
    let credential: Awaited<ReturnType<ProviderKeyStore["read"]>>;
    try {
      credential = await keys.read({ deviceId, providerConnectionId });
    } catch (error) {
      return failed(failureOf(error));
    }
    // The read waits for the store's queue and the system's decryption: a
    // removal that the server confirmed meanwhile must not hand out the key.
    const after = kindRefusal(providerConnectionId);
    if (after !== null) {
      return failed(after);
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
