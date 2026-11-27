// The errors of the provider key store (#33). Every message is fixed per
// code and no error carries a `cause`, so no caller can put an API key, a
// decrypted payload, or file content into one: an error may reach a log,
// and no key may.
import { PROVIDER_KEY_LIMITS } from "../../shared/ipc-contract.ts";

/** Why a provider key operation failed. */
export const PROVIDER_KEY_ERROR_CODES = Object.freeze([
  "folder_unavailable",
  "system_protection_unavailable",
  "invalid_key",
  "invalid_model",
  "invalid_binding",
  "missing",
  "unreadable",
  "corrupt",
  "newer_format",
  "bound_elsewhere",
  "read_failed",
  "write_failed",
  "delete_failed",
] as const);
export type ProviderKeyErrorCode = (typeof PROVIDER_KEY_ERROR_CODES)[number];

const MESSAGES: Readonly<Record<ProviderKeyErrorCode, string>> = Object.freeze({
  folder_unavailable:
    "The local data folder of the provider keys is not available.",
  system_protection_unavailable:
    "The system cannot protect a provider key, so none is stored.",
  invalid_key: `The provider key must be 1 to ${String(PROVIDER_KEY_LIMITS.key)} characters without white space or control characters.`,
  invalid_model: "The model is not one of the models that can be chosen.",
  invalid_binding: "The device ID or the provider connection ID is not valid.",
  missing: "No provider key is stored for this connection.",
  unreadable: "The system could not decrypt the provider key.",
  corrupt: "The provider key file is damaged or in an unknown format.",
  newer_format:
    "A newer version of the application wrote the provider key file in a format that this version cannot read.",
  bound_elsewhere:
    "The provider key file belongs to another device or another connection.",
  read_failed: "The provider key file could not be read.",
  write_failed: "The provider key file could not be written.",
  delete_failed: "A provider key file could not be deleted.",
});

/** A provider key operation failed. The message names the reason, never a value. */
export class ProviderKeyError extends Error {
  readonly code: ProviderKeyErrorCode;

  constructor(code: ProviderKeyErrorCode) {
    super(MESSAGES[code]);
    this.name = "ProviderKeyError";
    this.code = code;
  }
}

/** Whether `error` is a `ProviderKeyError` with `code`. */
export function isProviderKeyError(
  error: unknown,
  code?: ProviderKeyErrorCode,
): error is ProviderKeyError {
  return (
    error instanceof ProviderKeyError &&
    (code === undefined || error.code === code)
  );
}
