import { createPublicKey, randomBytes, verify } from "node:crypto";
import {
  type AuthChallengeFrame,
  AuthResponseFrameSchema,
  type ConnectionId,
  deviceAuthInput,
  type DeviceId,
  newUuidV7,
  PROTOCOL_VERSION,
} from "@mymandev/protocol";
import { expect, test } from "vitest";
import { generateDeviceKey } from "../device-key/signing-key.ts";
import { webSocketAuthResponse } from "./websocket-auth.ts";

const AUDIENCE = "https://api.mymandev.example";
const DEVICE_ID = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3" as DeviceId;
const SPKI_ED25519_PREFIX = "302a300506032b6570032100";

function challenge(): AuthChallengeFrame {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "auth.challenge",
    nonce: randomBytes(32).toString("base64url"),
    connectionId: newUuidV7() as ConnectionId,
  };
}

test("the auth.response frame carries a ws signature over the challenge", async () => {
  const { key } = await generateDeviceKey();
  const frame = challenge();

  const response = webSocketAuthResponse(key, {
    audience: AUDIENCE,
    deviceId: DEVICE_ID,
    challenge: frame,
  });

  expect(AuthResponseFrameSchema.parse(response)).toEqual(response);
  expect(Object.keys(response).sort()).toEqual([
    "deviceId",
    "protocolVersion",
    "signature",
    "type",
  ]);
  const publicKey = createPublicKey({
    key: Buffer.from(`${SPKI_ED25519_PREFIX}${key.publicKey}`, "hex"),
    format: "der",
    type: "spki",
  });
  const input = {
    audience: AUDIENCE,
    nonce: frame.nonce,
    deviceId: DEVICE_ID,
  };
  expect(
    verify(
      null,
      Buffer.from(
        deviceAuthInput({
          purpose: "ws",
          ...input,
          connectionId: frame.connectionId,
        }),
      ),
      publicKey,
      Buffer.from(response.signature, "base64url"),
    ),
  ).toBe(true);
  // Never valid as an http signature over the same values.
  expect(
    verify(
      null,
      Buffer.from(
        deviceAuthInput({
          purpose: "http",
          ...input,
          challengeId: frame.connectionId,
        }),
      ),
      publicKey,
      Buffer.from(response.signature, "base64url"),
    ),
  ).toBe(false);
});

test("a value outside the format is refused before anything is signed", async () => {
  const { key } = await generateDeviceKey();
  let signed = 0;
  const counting = {
    sign: (input: Parameters<typeof key.sign>[0]) => {
      const signature = key.sign(input);
      signed += 1;
      return signature;
    },
  };
  for (const input of [
    {
      audience: "https://API.example",
      deviceId: DEVICE_ID,
      challenge: challenge(),
    },
    { audience: AUDIENCE, deviceId: "x" as DeviceId, challenge: challenge() },
    {
      audience: AUDIENCE,
      deviceId: DEVICE_ID,
      challenge: { ...challenge(), nonce: "short" },
    },
  ]) {
    expect(() => webSocketAuthResponse(counting, input)).toThrow(TypeError);
  }
  expect(signed).toBe(0);
});
