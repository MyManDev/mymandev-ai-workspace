// The device's answer to the WebSocket `auth.challenge` (ADR 0014, "Device
// key and authentication", WebSocket step 2). The WebSocket client of #26
// sends it as its only frame before `auth.ok`. Signing needs no prompt and
// no request, so it fits into the 10-second handshake.
import {
  type AuthChallengeFrame,
  type AuthResponseFrame,
  type DeviceId,
  PROTOCOL_VERSION,
} from "@mymandev/protocol";
import type { DeviceKey } from "../device-key/signing-key.ts";

export interface WebSocketAuthInput {
  /** The API origin, the audience of every signature. */
  readonly audience: string;
  readonly deviceId: DeviceId;
  /** The server's `auth.challenge`, parsed with `AuthChallengeFrameSchema`. */
  readonly challenge: AuthChallengeFrame;
}

/**
 * Signs the challenge's nonce and connection ID with the purpose `ws` and
 * returns the `auth.response` frame. Throws the `TypeError` of
 * `deviceAuthInput` for a value outside the protocol's format, and the key's
 * `DeviceKeyError` once the store no longer holds it. The frame carries a
 * signature: send it, and never log it.
 */
export function webSocketAuthResponse(
  key: Pick<DeviceKey, "sign">,
  input: WebSocketAuthInput,
): AuthResponseFrame {
  const signature = key.sign({
    purpose: "ws",
    audience: input.audience,
    nonce: input.challenge.nonce,
    deviceId: input.deviceId,
    connectionId: input.challenge.connectionId,
  });
  return Object.freeze({
    protocolVersion: PROTOCOL_VERSION,
    type: "auth.response",
    deviceId: input.deviceId,
    signature,
  });
}
