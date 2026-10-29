import assert from "node:assert/strict";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  sign,
  verify,
} from "node:crypto";
import { test } from "node:test";
import {
  ACCESS_TOKEN_PATTERN,
  BASE64URL_32_BYTES_PATTERN,
  DEVICE_AUTH_AUDIENCE_PATTERN,
  DEVICE_AUTH_PURPOSES,
  DEVICE_PUBLIC_KEY_PATTERN,
  DEVICE_SIGNATURE_PATTERN,
  deviceAuthInput,
  type DeviceAuthInput,
  INVITATION_CODE_PATTERN,
  pairingCode,
  SIGN_IN_CODE_PATTERN,
} from "./device-auth.ts";

// RFC 8032, section 7.1, test 1.
const RFC8032_SECRET =
  "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const RFC8032_PUBLIC =
  "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
const PKCS8_ED25519_PREFIX = "302e020100300506032b657004220420";
const SPKI_ED25519_PREFIX = "302a300506032b6570032100";

const AUDIENCE = "https://api.mymandev.example";
const NONCE = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const SIGN_IN_CODE = "mmdc_ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8";
const DEVICE_ID = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3";
const OTHER_ID = "0192f2a0-7c3e-7d2e-9f10-112233445566";

function rfc8032Key(): KeyObject {
  return createPrivateKey({
    key: Buffer.from(PKCS8_ED25519_PREFIX + RFC8032_SECRET, "hex"),
    format: "der",
    type: "pkcs8",
  });
}

/** The raw public key in hexadecimal, as the server stores it. */
function rawPublicKey(privateKey: KeyObject): string {
  return createPublicKey(privateKey)
    .export({ type: "spki", format: "der" })
    .subarray(12)
    .toString("hex");
}

/** Verifies the way the API does: from the stored hexadecimal key and the base64url signature. */
function verifies(
  input: string,
  publicKeyHex: string,
  signature: string,
): boolean {
  const publicKey = createPublicKey({
    key: Buffer.from(SPKI_ED25519_PREFIX + publicKeyHex, "hex"),
    format: "der",
    type: "spki",
  });
  return verify(
    null,
    Buffer.from(input, "utf8"),
    publicKey,
    Buffer.from(signature, "base64url"),
  );
}

test("the signed input has six lines in a fixed order, joined without a final line feed", () => {
  assert.equal(
    deviceAuthInput({
      purpose: "ws",
      audience: AUDIENCE,
      nonce: NONCE,
      deviceId: DEVICE_ID,
      connectionId: OTHER_ID,
    }),
    [
      "mymandev-device-auth-v0",
      "ws",
      "https://api.mymandev.example",
      "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
      "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3",
      "0192f2a0-7c3e-7d2e-9f10-112233445566",
    ].join("\n"),
  );
  assert.equal(
    deviceAuthInput({
      purpose: "http",
      audience: "http://127.0.0.1:3000",
      nonce: NONCE,
      deviceId: DEVICE_ID,
      challengeId: OTHER_ID,
    }),
    `mymandev-device-auth-v0\nhttp\nhttp://127.0.0.1:3000\n${NONCE}\n${DEVICE_ID}\n${OTHER_ID}`,
  );
  const newDevice = deviceAuthInput({
    purpose: "sign-in",
    audience: AUDIENCE,
    signInCode: SIGN_IN_CODE,
    deviceId: null,
    newPublicKey: RFC8032_PUBLIC,
  });
  assert.equal(
    newDevice,
    `mymandev-device-auth-v0\nsign-in\n${AUDIENCE}\n${SIGN_IN_CODE}\n\n${RFC8032_PUBLIC}`,
  );
  assert.equal(
    newDevice.split("\n").length,
    6,
    "the empty device line still counts",
  );
  assert.equal(newDevice.endsWith("\n"), false);
  assert.equal(
    deviceAuthInput({
      purpose: "sign-in",
      audience: AUDIENCE,
      signInCode: SIGN_IN_CODE,
      deviceId: DEVICE_ID,
      newPublicKey: RFC8032_PUBLIC,
    }),
    `mymandev-device-auth-v0\nsign-in\n${AUDIENCE}\n${SIGN_IN_CODE}\n${DEVICE_ID}\n${RFC8032_PUBLIC}`,
  );
  assert.deepEqual(DEVICE_AUTH_PURPOSES, ["ws", "http", "sign-in"]);
  assert.equal(Object.isFrozen(DEVICE_AUTH_PURPOSES), true);
});

test("a fixed key gives a fixed signature that verifies from the stored public key", () => {
  const privateKey = rfc8032Key();
  assert.equal(rawPublicKey(privateKey), RFC8032_PUBLIC);
  const input = deviceAuthInput({
    purpose: "sign-in",
    audience: AUDIENCE,
    signInCode: SIGN_IN_CODE,
    deviceId: null,
    newPublicKey: RFC8032_PUBLIC,
  });
  // Ed25519 is deterministic, so the desktop and the API can share this vector.
  const signature = sign(null, Buffer.from(input, "utf8"), privateKey).toString(
    "base64url",
  );
  assert.equal(
    signature,
    "3Q6S3ufAr_C7P6m5_ddoMGvzKATs-jnnj8N4TtOP-hT_oJKy97BfCPxymyiiHu_jKRjgaH6OqjhG_b4ZUH5zAA",
  );
  assert.match(signature, DEVICE_SIGNATURE_PATTERN);
  assert.equal(verifies(input, RFC8032_PUBLIC, signature), true);
});

test("a signature for one purpose, audience, nonce, device, or binding does not verify for another", () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const publicKey = rawPublicKey(privateKey);
  assert.match(publicKey, DEVICE_PUBLIC_KEY_PATTERN);
  const base: DeviceAuthInput = {
    purpose: "http",
    audience: AUDIENCE,
    nonce: NONCE,
    deviceId: DEVICE_ID,
    challengeId: OTHER_ID,
  };
  const signed = deviceAuthInput(base);
  const signature = sign(
    null,
    Buffer.from(signed, "utf8"),
    privateKey,
  ).toString("base64url");
  assert.equal(verifies(signed, publicKey, signature), true);

  const variants: DeviceAuthInput[] = [
    {
      purpose: "ws",
      audience: AUDIENCE,
      nonce: NONCE,
      deviceId: DEVICE_ID,
      connectionId: OTHER_ID,
    },
    { ...base, audience: "https://staging.mymandev.example" },
    { ...base, nonce: randomBytes(32).toString("base64url") },
    { ...base, deviceId: OTHER_ID },
    { ...base, challengeId: DEVICE_ID },
  ];
  for (const variant of variants) {
    const other = deviceAuthInput(variant);
    assert.notEqual(other, signed);
    assert.equal(verifies(other, publicKey, signature), false, other);
  }
});

test("the builder rejects every value outside its format, without echoing it", () => {
  const ws = {
    purpose: "ws",
    audience: AUDIENCE,
    nonce: NONCE,
    deviceId: DEVICE_ID,
    connectionId: OTHER_ID,
  } as const;
  const signIn = {
    purpose: "sign-in",
    audience: AUDIENCE,
    signInCode: SIGN_IN_CODE,
    deviceId: null,
    newPublicKey: RFC8032_PUBLIC,
  } as const;
  const secret = "secret-value-never-echoed";
  const rejected: [label: string, input: unknown][] = [
    ["purpose", { ...ws, purpose: "wss" }],
    ["purpose in another case", { ...ws, purpose: "WS" }],
    ["line feed in the audience", { ...ws, audience: `${AUDIENCE}\nhttp` }],
    ["trailing slash", { ...ws, audience: `${AUDIENCE}/` }],
    ["path", { ...ws, audience: `${AUDIENCE}/api` }],
    ["uppercase host", { ...ws, audience: "https://API.mymandev.example" }],
    [
      "default https port",
      { ...ws, audience: "https://api.mymandev.example:443" },
    ],
    ["default http port", { ...ws, audience: "http://127.0.0.1:80" }],
    ["port 0", { ...ws, audience: "http://127.0.0.1:0" }],
    ["port 65536", { ...ws, audience: "http://127.0.0.1:65536" }],
    [
      "user info",
      { ...ws, audience: `https://${secret}@api.mymandev.example` },
    ],
    ["other scheme", { ...ws, audience: "wss://api.mymandev.example" }],
    ["IPv6 literal", { ...ws, audience: "http://[::1]:3000" }],
    ["nonce with a line feed", { ...ws, nonce: `${NONCE.slice(0, 42)}\n` }],
    ["nonce of 42 characters", { ...ws, nonce: NONCE.slice(0, 42) }],
    ["nonce of 44 characters", { ...ws, nonce: `${NONCE}A` }],
    ["nonce with padding", { ...ws, nonce: `${NONCE.slice(0, 42)}=` }],
    ["nonce in base64", { ...ws, nonce: `${NONCE.slice(0, 41)}+A` }],
    [
      "nonce in a non-canonical form",
      { ...ws, nonce: `${NONCE.slice(0, 42)}B` },
    ],
    ["uppercase device ID", { ...ws, deviceId: DEVICE_ID.toUpperCase() }],
    [
      "UUIDv4 device ID",
      { ...ws, deviceId: "0192f2a0-7c3e-4a1b-8c4d-5e6f708192a3" },
    ],
    ["empty device ID for ws", { ...ws, deviceId: "" }],
    ["null device ID for ws", { ...ws, deviceId: null }],
    [
      "connection ID with a line feed",
      { ...ws, connectionId: `${OTHER_ID}\n` },
    ],
    ["missing connection ID", { ...ws, connectionId: undefined }],
    ["http without a challenge ID", { ...ws, purpose: "http" }],
    [
      "sign-in code without its prefix",
      { ...signIn, signInCode: SIGN_IN_CODE.slice(5) },
    ],
    [
      "access token as the sign-in code",
      { ...signIn, signInCode: `mmda_${SIGN_IN_CODE.slice(5)}` },
    ],
    ["nonce as the sign-in code", { ...signIn, signInCode: NONCE }],
    ["empty string device ID for sign-in", { ...signIn, deviceId: "" }],
    [
      "uppercase public key",
      { ...signIn, newPublicKey: RFC8032_PUBLIC.toUpperCase() },
    ],
    [
      "SPKI public key",
      { ...signIn, newPublicKey: SPKI_ED25519_PREFIX + RFC8032_PUBLIC },
    ],
    [
      "public key in base64url",
      {
        ...signIn,
        newPublicKey: Buffer.from(RFC8032_PUBLIC, "hex").toString("base64url"),
      },
    ],
    ["number instead of a string", { ...ws, nonce: 42 }],
    ["string object", { ...ws, nonce: Object(NONCE) }],
  ];
  for (const [label, input] of rejected) {
    assert.throws(
      () => deviceAuthInput(input as DeviceAuthInput),
      (error: unknown) =>
        error instanceof TypeError &&
        !error.message.includes(secret) &&
        !error.message.includes(NONCE) &&
        !error.message.includes(SIGN_IN_CODE),
      label,
    );
  }
});

test("the pairing code has fixed vectors, keeps leading zeros, and reads the bytes unsigned", () => {
  // RFC 7636, appendix B.
  assert.equal(
    pairingCode("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"),
    "603030",
  );
  assert.equal(pairingCode("A".repeat(43)), "000000");
  assert.equal(
    pairingCode("HewCstjc0OlGD8xDzWmgyQf1H66vKulZ_KOsaGpZQJE"),
    "006450",
  );
  // 0xffffffff is 4294967295, which a signed 32-bit read would turn negative.
  assert.equal(pairingCode(`${"_".repeat(42)}w`), "967295");
});

test("the pairing code equals a Buffer-based computation for random challenges", () => {
  for (let index = 0; index < 500; index += 1) {
    const challenge = createHash("sha256")
      .update(randomBytes(32))
      .digest("base64url");
    const expected = String(
      Buffer.from(challenge, "base64url").readUInt32BE(0) % 1_000_000,
    ).padStart(6, "0");
    const code = pairingCode(challenge);
    assert.equal(code, expected, challenge);
    assert.match(code, /^[0-9]{6}$/u);
  }
});

test("the pairing code rejects a challenge that is not 43 canonical base64url characters", () => {
  const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
  for (const rejected of [
    "",
    challenge.slice(0, 42),
    `${challenge}=`,
    `${challenge.slice(0, 42)}N`,
    challenge.replace("-", "+"),
    `${challenge.slice(0, 42)}\n`,
  ]) {
    assert.throws(
      () => pairingCode(rejected),
      TypeError,
      JSON.stringify(rejected),
    );
  }
});

test("the code formats accept their prefix and 43 characters and nothing else", () => {
  const body = randomBytes(32).toString("base64url");
  const formats: [prefix: string, pattern: RegExp][] = [
    ["mmdc_", SIGN_IN_CODE_PATTERN],
    ["mmda_", ACCESS_TOKEN_PATTERN],
    ["mmdi_", INVITATION_CODE_PATTERN],
  ];
  for (const [prefix, pattern] of formats) {
    assert.match(prefix + body, pattern);
    assert.equal((prefix + body).length, 48);
    for (const [label, value] of [
      ["47 characters", prefix + body.slice(1)],
      ["49 characters", `${prefix + body}A`],
      ["uppercase prefix", prefix.toUpperCase() + body],
      ["no prefix", body],
      ["padding", `${prefix + body.slice(0, 42)}=`],
      ["trailing line feed", `${prefix + body}\n`],
    ] as const) {
      assert.doesNotMatch(value, pattern, `${prefix} ${label}`);
    }
    for (const [otherPrefix, otherPattern] of formats) {
      if (otherPrefix !== prefix) {
        assert.doesNotMatch(
          prefix + body,
          otherPattern,
          `${prefix} as ${otherPrefix}`,
        );
      }
    }
  }
  assert.match(body, BASE64URL_32_BYTES_PATTERN);
  for (let index = 0; index < 200; index += 1) {
    assert.match(
      randomBytes(32).toString("base64url"),
      BASE64URL_32_BYTES_PATTERN,
    );
    assert.match(
      randomBytes(64).toString("base64url"),
      DEVICE_SIGNATURE_PATTERN,
    );
  }
});

test("the audience accepts the origins that a URL parser writes", () => {
  for (const origin of [
    "https://api.mymandev.example",
    "https://mymandev.example:8443",
    "http://127.0.0.1:3000",
    "http://localhost:3000",
    "https://a.b-c.example",
  ]) {
    assert.match(origin, DEVICE_AUTH_AUDIENCE_PATTERN);
    assert.equal(new URL(origin).origin, origin);
  }
  assert.doesNotMatch(
    `https://${"a".repeat(254)}`,
    DEVICE_AUTH_AUDIENCE_PATTERN,
  );
  assert.doesNotMatch(
    "https://-api.mymandev.example",
    DEVICE_AUTH_AUDIENCE_PATTERN,
  );
});
