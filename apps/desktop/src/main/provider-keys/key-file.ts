// The provider key file (#33): one small versioned JSON object that holds
// one ciphertext of Electron's `safeStorage.encryptStringAsync` and nothing
// else. What `safeStorage` encrypts is the payload: a versioned JSON object
// with the device ID, the provider connection ID, the API key, and, from
// payload version 2, the model chosen for the connection (#30). The two IDs
// bind the key and the model to this device and this connection; a reader
// compares them with the ones it asks for, so a file copied from another
// device or another connection is refused. The model is not secret, but it
// lives in the same payload, so that it is written, bound, and deleted with
// the key.
//
// The file names the connection (`<connection ID>.json`), so that a
// removal finds it without decrypting anything, but holds no ID in the
// clear. Nothing here logs, and no error carries a value.
import { DeviceIdSchema, ProviderConnectionIdSchema } from "@mymandev/protocol";
import * as z from "zod";
import { PROVIDER_KEY_LIMITS } from "../../shared/ipc-contract.ts";
import { ProviderKeyError } from "./errors.ts";

/** The value of `format`, the first key of every provider key file. */
export const PROVIDER_KEY_FILE_FORMAT = "mymandev-provider-key";

/** The value of `format` of the encrypted payload. */
export const PROVIDER_KEY_PAYLOAD_FORMAT = "mymandev-provider-key-payload";

/** The format version of the file, which this code writes and reads. */
export const PROVIDER_KEY_FILE_VERSION = 1;

/**
 * The format version of the payload that this code writes: 2, which adds
 * `model` (#30). It still reads version 1, a payload without a model, which
 * opens with the model null, so that the person is asked to choose one; it
 * never picks one. A version above 2 is `newer_format`.
 */
export const PROVIDER_KEY_PAYLOAD_VERSION = 2;

/** The payload version before `model`, which this code reads and never writes. */
export const PROVIDER_KEY_PAYLOAD_VERSION_WITHOUT_MODEL = 1;

/** The longest key in UTF-16 code units. */
export const PROVIDER_KEY_MAX_LENGTH = PROVIDER_KEY_LIMITS.key;

/** The largest ciphertext in a key file, decoded. */
const MAX_CIPHERTEXT_BYTES = 8192;

/** The largest key file; a larger one is not a file of this format. */
export const MAX_PROVIDER_KEY_FILE_BYTES = 16_384;

/**
 * A character that a key never holds: white space (also Unicode spaces and
 * line breaks), control characters, and format characters such as a
 * zero-width space, which a copy from a web page can add unseen.
 */
const FORBIDDEN_KEY_CHARACTER = /[\s\p{Cc}\p{Cf}]/u;

/**
 * Whether `key` has the shape of an API key: a well-formed string of 1 to
 * `PROVIDER_KEY_MAX_LENGTH` code units without white space, control, or
 * format characters. The check is minimal on purpose: it says nothing about
 * whether a provider accepts the key, and it never names the key.
 */
export function isProviderKeyShape(key: unknown): key is string {
  return (
    typeof key === "string" &&
    key.length >= 1 &&
    key.length <= PROVIDER_KEY_MAX_LENGTH &&
    key.isWellFormed() &&
    !FORBIDDEN_KEY_CHARACTER.test(key)
  );
}

/** The longest model ID that a payload may hold. */
export const MAX_MODEL_ID_LENGTH = 64;

/**
 * The shape of a model ID in a payload that this code reads: lowercase
 * letters, digits, dots, and hyphens, as the Claude API's model IDs are.
 * Reading checks this shape only, so that a model that a later version
 * offers, or that this version no longer offers, keeps the key readable;
 * whether it is one of the closed list is checked where it is used
 * (models.ts). The store writes only a model of the closed list.
 */
const MODEL_ID_SHAPE = /^[a-z0-9][a-z0-9.-]*$/u;

/** What a key file holds once it is opened: the key and the model, or null. */
export interface ProviderCredential {
  readonly key: string;
  readonly model: string | null;
}

/** The device and the connection that a key belongs to. */
export interface ProviderKeyBinding {
  readonly deviceId: string;
  readonly providerConnectionId: string;
}

/** Throws `invalid_binding` unless both IDs are lowercase UUIDv7s. */
export function checkBinding(binding: ProviderKeyBinding): ProviderKeyBinding {
  const deviceId = DeviceIdSchema.safeParse(binding.deviceId);
  const providerConnectionId = ProviderConnectionIdSchema.safeParse(
    binding.providerConnectionId,
  );
  if (!deviceId.success || !providerConnectionId.success) {
    throw new ProviderKeyError("invalid_binding");
  }
  return Object.freeze({
    deviceId: deviceId.data,
    providerConnectionId: providerConnectionId.data,
  });
}

/** Throws `invalid_binding` unless `providerConnectionId` is a lowercase UUIDv7. */
export function checkConnectionId(providerConnectionId: unknown): string {
  const parsed = ProviderConnectionIdSchema.safeParse(providerConnectionId);
  if (!parsed.success) {
    throw new ProviderKeyError("invalid_binding");
  }
  return parsed.data;
}

/** The name of the key file of a connection in the provider key folder. */
export function providerKeyFileName(providerConnectionId: string): string {
  return `${providerConnectionId}.json`;
}

/** The connection ID that a key file name holds, or null for another name. */
export function connectionOfFileName(name: string): string | null {
  if (!name.endsWith(".json")) {
    return null;
  }
  const parsed = ProviderConnectionIdSchema.safeParse(
    name.slice(0, -".json".length),
  );
  return parsed.success ? parsed.data : null;
}

const FileSchema = z.strictObject({
  format: z.literal(PROVIDER_KEY_FILE_FORMAT),
  version: z.literal(PROVIDER_KEY_FILE_VERSION),
  ciphertext: z
    .string()
    .min(1)
    .max(Math.ceil((MAX_CIPHERTEXT_BYTES * 4) / 3))
    .regex(/^[A-Za-z0-9_-]*$/u),
});

const ModelIdSchema = z
  .string()
  .min(1)
  .max(MAX_MODEL_ID_LENGTH)
  .regex(MODEL_ID_SHAPE);

const PayloadFields = {
  format: z.literal(PROVIDER_KEY_PAYLOAD_FORMAT),
  deviceId: DeviceIdSchema,
  providerConnectionId: ProviderConnectionIdSchema,
  key: z.string().refine(isProviderKeyShape),
};

/**
 * Version 2, which this code writes, and version 1, which it only reads:
 * the same fields without `model`. Both are strict, so a version 1 payload
 * with a model, or a version 2 payload without one, is `corrupt`.
 */
const PayloadSchema = z.discriminatedUnion("version", [
  z.strictObject({
    ...PayloadFields,
    version: z.literal(PROVIDER_KEY_PAYLOAD_VERSION),
    model: ModelIdSchema.nullable(),
  }),
  z.strictObject({
    ...PayloadFields,
    version: z.literal(PROVIDER_KEY_PAYLOAD_VERSION_WITHOUT_MODEL),
  }),
]);

/** Whether `value` names `format` with a version above `version`. */
function isNewerFormat(
  value: unknown,
  format: string,
  version: number,
): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "format" in value &&
    value.format === format &&
    "version" in value &&
    typeof value.version === "number" &&
    Number.isSafeInteger(value.version) &&
    value.version > version
  );
}

/** Parses JSON text, or throws `corrupt` without the parser's message. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProviderKeyError("corrupt");
  }
}

/** The bytes of a key file: one line of JSON with a final line feed. */
export function encodeProviderKeyFile(ciphertext: Buffer): Buffer {
  return Buffer.from(
    `${JSON.stringify({
      format: PROVIDER_KEY_FILE_FORMAT,
      version: PROVIDER_KEY_FILE_VERSION,
      ciphertext: ciphertext.toString("base64url"),
    })}\n`,
    "utf8",
  );
}

/**
 * The ciphertext of a key file. Throws `newer_format` for a file of a later
 * version and `corrupt` for anything else that is not a key file of this
 * version, never with the file's content.
 */
export function decodeProviderKeyFile(bytes: Uint8Array): Buffer {
  if (bytes.length > MAX_PROVIDER_KEY_FILE_BYTES) {
    throw new ProviderKeyError("corrupt");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ProviderKeyError("corrupt");
  }
  const value = parseJson(text);
  const parsed = FileSchema.safeParse(value);
  if (!parsed.success) {
    throw new ProviderKeyError(
      isNewerFormat(value, PROVIDER_KEY_FILE_FORMAT, PROVIDER_KEY_FILE_VERSION)
        ? "newer_format"
        : "corrupt",
    );
  }
  const ciphertext = Buffer.from(parsed.data.ciphertext, "base64url");
  if (
    ciphertext.length === 0 ||
    ciphertext.length > MAX_CIPHERTEXT_BYTES ||
    ciphertext.toString("base64url") !== parsed.data.ciphertext
  ) {
    throw new ProviderKeyError("corrupt");
  }
  return ciphertext;
}

/**
 * The text that `safeStorage` encrypts: the binding, the key, and the
 * model, always of the current payload version.
 */
export function encodeProviderKeyPayload(
  binding: ProviderKeyBinding,
  key: string,
  model: string | null,
): string {
  return JSON.stringify({
    format: PROVIDER_KEY_PAYLOAD_FORMAT,
    version: PROVIDER_KEY_PAYLOAD_VERSION,
    deviceId: binding.deviceId,
    providerConnectionId: binding.providerConnectionId,
    key,
    model,
  });
}

/**
 * The key and the model of a decrypted payload, after its binding was
 * compared with `binding`; a version 1 payload has the model null. Throws
 * `corrupt` for text that is not a payload of a version that this code
 * reads (a tampered file whose ciphertext still decrypts lands here),
 * `newer_format` for a later version, and `bound_elsewhere` for a payload
 * of another device or another connection. No error holds the text.
 */
export function openProviderKeyPayload(
  text: string,
  binding: ProviderKeyBinding,
): ProviderCredential {
  const value = parseJson(text);
  const parsed = PayloadSchema.safeParse(value);
  if (!parsed.success) {
    throw new ProviderKeyError(
      isNewerFormat(
        value,
        PROVIDER_KEY_PAYLOAD_FORMAT,
        PROVIDER_KEY_PAYLOAD_VERSION,
      )
        ? "newer_format"
        : "corrupt",
    );
  }
  if (
    parsed.data.deviceId !== binding.deviceId ||
    parsed.data.providerConnectionId !== binding.providerConnectionId
  ) {
    throw new ProviderKeyError("bound_elsewhere");
  }
  return Object.freeze({
    key: parsed.data.key,
    model:
      parsed.data.version === PROVIDER_KEY_PAYLOAD_VERSION
        ? parsed.data.model
        : null,
  });
}
