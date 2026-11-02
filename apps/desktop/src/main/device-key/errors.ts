// The errors of the device key store. Every message is fixed per code, so no
// caller can put a passphrase, a key, or file content into one: an error may
// reach a log, and nothing secret may (ADR 0014).

/** Why a device key operation failed. */
export const DEVICE_KEY_ERROR_CODES = Object.freeze([
  "local_data_folder_missing",
  "system_protection_unavailable",
  "system_protection_available",
  "unprotected_not_accepted",
  "passphrase_required",
  "passphrase_invalid",
  "wrong_passphrase",
  "unreadable",
  "corrupt",
  "newer_format",
  "key_exists",
  "not_loaded",
  "replacement_pending",
  "no_replacement",
  "key_retired",
] as const);
export type DeviceKeyErrorCode = (typeof DEVICE_KEY_ERROR_CODES)[number];

const MESSAGES: Readonly<Record<DeviceKeyErrorCode, string>> = Object.freeze({
  local_data_folder_missing:
    "LOCALAPPDATA is not set to an absolute folder, so the device key has no local data folder.",
  system_protection_unavailable: "The system cannot protect the device key.",
  system_protection_available:
    "The system protects the device key, so it is stored neither with a passphrase nor unprotected.",
  unprotected_not_accepted:
    "An unprotected device key needs an explicit choice after a warning.",
  passphrase_required: "The device key is protected by a passphrase.",
  passphrase_invalid: "The passphrase must have 1 to 1024 characters.",
  wrong_passphrase: "The passphrase does not open the device key.",
  unreadable: "The system could not decrypt the device key.",
  corrupt: "The device key file is damaged or in an unknown format.",
  newer_format:
    "A newer version of the application wrote the device key file in a format that this version cannot read.",
  key_exists: "A device key is already stored.",
  not_loaded: "The device key is not loaded.",
  replacement_pending:
    "The previous device key is still kept until the new key authenticates once.",
  no_replacement: "No previous device key is kept.",
  key_retired: "This device key is no longer held.",
});

/** A device key operation failed. The message names the reason, never a value. */
export class DeviceKeyError extends Error {
  readonly code: DeviceKeyErrorCode;

  constructor(code: DeviceKeyErrorCode) {
    super(MESSAGES[code]);
    this.name = "DeviceKeyError";
    this.code = code;
  }
}

/** Whether `error` is a `DeviceKeyError` with `code`. */
export function isDeviceKeyError(
  error: unknown,
  code?: DeviceKeyErrorCode,
): error is DeviceKeyError {
  return (
    error instanceof DeviceKeyError &&
    (code === undefined || error.code === code)
  );
}
