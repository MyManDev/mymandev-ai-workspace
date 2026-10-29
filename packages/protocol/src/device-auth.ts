// Device authentication (ADR 0014): the wire formats of keys, signatures,
// nonces, and codes, the signed input, and the pairing code. Plain constants
// and functions without a zod import. Signing and verification use
// `node:crypto` in the desktop main process and in the API, not this package.

import { UUIDV7_PATTERN } from "./model.ts";
import { privatePattern } from "./private-pattern.ts";

/**
 * 32 bytes as 43 base64url characters without padding, in the canonical form
 * that every encoder writes: the unused low bits of the last character are
 * zero. Server nonces, PKCE states, verifiers, and challenges use it.
 */
export const BASE64URL_32_BYTES_PATTERN =
  /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;

/** An Ed25519 signature: 64 bytes as 86 canonical base64url characters. */
export const DEVICE_SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{85}[AQgw]$/u;

/**
 * An Ed25519 public key: the raw 32-byte key of RFC 8032, not its SPKI form,
 * as 64 lowercase hexadecimal characters, the form in which the server
 * stores it.
 */
export const DEVICE_PUBLIC_KEY_PATTERN = /^[0-9a-f]{64}$/u;

/** A sign-in code: `mmdc_` and 32 random bytes as canonical base64url. */
export const SIGN_IN_CODE_PATTERN =
  /^mmdc_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;

/** An access token: `mmda_` and 32 random bytes as canonical base64url. */
export const ACCESS_TOKEN_PATTERN =
  /^mmda_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;

/** An invitation code: `mmdi_` and 32 random bytes as canonical base64url. */
export const INVITATION_CODE_PATTERN =
  /^mmdi_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;

/**
 * The audience of a signature: the API's public origin, written as
 * `scheme://host[:port]` the way a URL parser serializes it, so in lowercase
 * and without the default port. The host is a DNS name or an IPv4 address.
 */
export const DEVICE_AUTH_AUDIENCE_PATTERN =
  /^https?:\/\/(?=[a-z0-9.-]{1,253}(?::|$))[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::(?:[1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5]))?$/u;

/** The first line of every signed input. */
export const DEVICE_AUTH_CONTEXT = "mymandev-device-auth-v0";

/** What a signature is for. A signature for one purpose never counts for another. */
export const DEVICE_AUTH_PURPOSES = Object.freeze([
  "ws",
  "http",
  "sign-in",
] as const);
export type DeviceAuthPurpose = (typeof DEVICE_AUTH_PURPOSES)[number];

/** The values that a device signs, by purpose. Every value is a string as sent on the wire. */
export type DeviceAuthInput =
  | {
      readonly purpose: "ws";
      /** The API's public origin. */
      readonly audience: string;
      /** The server nonce of `auth.challenge`. */
      readonly nonce: string;
      readonly deviceId: string;
      /** The connection ID of `auth.challenge`. */
      readonly connectionId: string;
    }
  | {
      readonly purpose: "http";
      readonly audience: string;
      /** The nonce of `POST /auth/challenge`. */
      readonly nonce: string;
      readonly deviceId: string;
      /** The challenge ID of `POST /auth/challenge`. */
      readonly challengeId: string;
    }
  | {
      readonly purpose: "sign-in";
      readonly audience: string;
      readonly signInCode: string;
      /** null for a new device. */
      readonly deviceId: string | null;
      /** The public key that this sign-in registers. */
      readonly newPublicKey: string;
    };

const base64url32 = privatePattern(BASE64URL_32_BYTES_PATTERN);
const publicKeyPattern = privatePattern(DEVICE_PUBLIC_KEY_PATTERN);
const signInCodePattern = privatePattern(SIGN_IN_CODE_PATTERN);
const audiencePattern = privatePattern(DEVICE_AUTH_AUDIENCE_PATTERN);
const uuidV7Pattern = privatePattern(UUIDV7_PATTERN);

/** Returns the value if it is a string that matches; the error names the field, never the value. */
function checked(field: string, value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new TypeError(`Invalid ${field}`);
  }
  return value;
}

/** A URL parser drops the default port, so an origin that names it never equals the API's origin. */
function checkedAudience(value: unknown): string {
  const audience = checked("audience", value, audiencePattern);
  if (
    (audience.startsWith("https:") && audience.endsWith(":443")) ||
    (audience.startsWith("http:") && audience.endsWith(":80"))
  ) {
    throw new TypeError("Invalid audience");
  }
  return audience;
}

/**
 * Builds the input that a device signs, as a string of six lines joined with
 * a single line feed, without a final line feed. Sign and verify its UTF-8
 * bytes. Every line has a fixed character set without a line break, so the
 * input is unambiguous. Throws a `TypeError` for a value outside its format,
 * so a caller never signs or verifies an input that a peer would build
 * differently.
 *
 * 1. `mymandev-device-auth-v0`
 * 2. the purpose: `ws`, `http`, or `sign-in`
 * 3. the audience: the API's public origin
 * 4. the server nonce, or the sign-in code
 * 5. the device ID, or empty for a new device
 * 6. the connection ID (`ws`), the challenge ID (`http`), or the new public key (`sign-in`)
 */
export function deviceAuthInput(input: DeviceAuthInput): string {
  const purpose: unknown = input.purpose;
  const audience = checkedAudience(input.audience);
  switch (purpose) {
    case "ws":
    case "http": {
      const values = input as Extract<
        DeviceAuthInput,
        { purpose: "ws" | "http" }
      >;
      const nonce = checked("nonce", values.nonce, base64url32);
      const deviceId = checked("device ID", values.deviceId, uuidV7Pattern);
      const binding =
        purpose === "ws"
          ? checked(
              "connection ID",
              (values as Extract<DeviceAuthInput, { purpose: "ws" }>)
                .connectionId,
              uuidV7Pattern,
            )
          : checked(
              "challenge ID",
              (values as Extract<DeviceAuthInput, { purpose: "http" }>)
                .challengeId,
              uuidV7Pattern,
            );
      return [
        DEVICE_AUTH_CONTEXT,
        purpose,
        audience,
        nonce,
        deviceId,
        binding,
      ].join("\n");
    }
    case "sign-in": {
      const values = input as Extract<DeviceAuthInput, { purpose: "sign-in" }>;
      const code = checked(
        "sign-in code",
        values.signInCode,
        signInCodePattern,
      );
      const rawDeviceId: unknown = values.deviceId;
      const deviceId =
        rawDeviceId === null
          ? ""
          : checked("device ID", rawDeviceId, uuidV7Pattern);
      const newPublicKey = checked(
        "new public key",
        values.newPublicKey,
        publicKeyPattern,
      );
      return [
        DEVICE_AUTH_CONTEXT,
        purpose,
        audience,
        code,
        deviceId,
        newPublicKey,
      ].join("\n");
    }
    default:
      throw new TypeError("Invalid purpose for the signed input");
  }
}

const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * The pairing code that the desktop and the API's confirmation page show for
 * one sign-in: the first 4 bytes of the decoded PKCE `code_challenge`, read
 * as an unsigned big-endian integer, modulo 1,000,000, written as 6 digits.
 * It is not secret. Throws a `TypeError` unless the challenge is 43 canonical
 * base64url characters.
 */
export function pairingCode(codeChallenge: string): string {
  const challenge = checked("code challenge", codeChallenge, base64url32);
  // Six characters carry 36 bits; the first 32 of them are the first 4 bytes.
  let bits = 0;
  for (let index = 0; index < 6; index += 1) {
    bits = bits * 64 + BASE64URL_ALPHABET.indexOf(challenge.charAt(index));
  }
  const firstFourBytes = Math.floor(bits / 16);
  return String(firstFourBytes % 1_000_000).padStart(6, "0");
}
