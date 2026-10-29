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
  ED25519_WEAK_PUBLIC_KEYS,
  deviceAuthInput,
  type DeviceAuthInput,
  INVITATION_CODE_PATTERN,
  isDeviceAuthAudience,
  isDevicePublicKey,
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

// Edwards25519 arithmetic with BigInt, only to compute the small-order points.
const P = 2n ** 255n - 19n;
const modP = (value: bigint) => ((value % P) + P) % P;
const powP = (base: bigint, exponent: bigint) => {
  let result = 1n;
  let factor = modP(base);
  for (let rest = exponent; rest > 0n; rest >>= 1n) {
    if (rest & 1n) result = modP(result * factor);
    factor = modP(factor * factor);
  }
  return result;
};
const invP = (value: bigint) => powP(value, P - 2n);
const D = modP(-121665n * invP(121666n));
type Point = readonly [x: bigint, y: bigint];
const addPoints = ([x1, y1]: Point, [x2, y2]: Point): Point => {
  const t = modP(D * x1 * x2 * y1 * y2);
  return [
    modP((x1 * y2 + x2 * y1) * invP(1n + t)),
    modP((y1 * y2 + x1 * x2) * invP(1n - t)),
  ];
};
const encodePoint = ([x, y]: Point): string => {
  const bytes = Buffer.from(y.toString(16).padStart(64, "0"), "hex").reverse();
  if (x & 1n) bytes[31] = (bytes[31] ?? 0) | 0x80;
  return bytes.toString("hex");
};
const decodePoint = (hex: string): Point => {
  const bytes = Buffer.from(hex, "hex");
  const sign = (bytes[31] ?? 0) >> 7;
  bytes[31] = (bytes[31] ?? 0) & 0x7f;
  const y = BigInt(`0x${Buffer.from(bytes).reverse().toString("hex")}`);
  const u = modP(y * y - 1n);
  const v = modP(D * y * y + 1n);
  let x = modP(u * powP(v, 3n) * powP(u * powP(v, 7n), (P - 5n) / 8n));
  if (modP(v * x * x) !== u) x = modP(x * powP(2n, (P - 1n) / 4n));
  assert.equal(modP(v * x * x), u, "on the curve");
  if (Number(x & 1n) !== sign) x = modP(-x);
  return [x, y];
};

test("the weak key list is exactly the small-order points and their negative-zero encodings", () => {
  // Any point of order 8 generates the torsion subgroup.
  const generator = decodePoint(
    "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
  );
  const torsion = new Set<string>();
  let point: Point = [0n, 1n];
  for (let index = 0; index < 8; index += 1) {
    torsion.add(encodePoint(point));
    point = addPoints(point, generator);
  }
  assert.equal(encodePoint(point), encodePoint([0n, 1n]), "order 8");
  assert.equal(torsion.size, 8);
  // x = 0 with the sign bit set: the identity and the point of order 2.
  const negativeZero = [
    "0100000000000000000000000000000000000000000000000000000000000080",
    "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
  ];
  assert.deepEqual(
    [...ED25519_WEAK_PUBLIC_KEYS].sort(),
    [...torsion, ...negativeZero].sort(),
  );
  assert.equal(Object.isFrozen(ED25519_WEAK_PUBLIC_KEYS), true);
  for (const key of ED25519_WEAK_PUBLIC_KEYS) {
    assert.equal(isDevicePublicKey(key), false, key);
  }
});

test("the identity key is refused although its format matches", () => {
  // Node.js 24.15 (OpenSSL 3.5.5) accepts the signature R = identity, S = 0
  // for this key on any message; later builds refuse it. The check must not
  // depend on the library, so it refuses the key itself.
  const identity = "01" + "00".repeat(31);
  assert.match(
    identity,
    DEVICE_PUBLIC_KEY_PATTERN,
    "the format alone accepts it",
  );
  assert.equal(isDevicePublicKey(identity), false);
  assert.throws(
    () =>
      deviceAuthInput({
        purpose: "sign-in",
        audience: AUDIENCE,
        signInCode: SIGN_IN_CODE,
        deviceId: null,
        newPublicKey: identity,
      }),
    TypeError,
  );
});

test("a public key needs a canonical encoding, and generated keys are accepted", () => {
  const ones = "ff".repeat(30);
  for (const nonCanonical of [
    `ed${ones}7f`,
    `ee${ones}7f`,
    `ff${ones}7f`,
    `ed${ones}ff`,
    `f0${ones}ff`,
  ]) {
    assert.equal(isDevicePublicKey(nonCanonical), false, nonCanonical);
  }
  // The largest canonical y, p - 1, is the point of order 2 and is weak; p - 2 is not on the list.
  assert.equal(isDevicePublicKey(`eb${ones}7f`), true);
  assert.equal(isDevicePublicKey(RFC8032_PUBLIC), true);
  for (let index = 0; index < 200; index += 1) {
    const { privateKey } = generateKeyPairSync("ed25519");
    assert.equal(isDevicePublicKey(rawPublicKey(privateKey)), true);
  }
  for (const value of [
    42,
    null,
    RFC8032_PUBLIC.toUpperCase(),
    Object(RFC8032_PUBLIC),
  ]) {
    assert.equal(isDevicePublicKey(value), false, String(value));
  }
});

test("the audience writes an IPv4 host as a URL parser does", () => {
  for (const origin of [
    "http://127.0.0.1:3000",
    "https://10.0.0.1",
    "https://255.255.255.255:8443",
  ]) {
    assert.equal(isDeviceAuthAudience(origin), true, origin);
    assert.equal(new URL(origin).origin, origin);
  }
  for (const origin of [
    "http://127.1:3000",
    "http://0x7f.0.0.1:3000",
    "http://0177.0.0.1:3000",
    "http://2130706433:3000",
    "https://0",
    "http://999.0.0.1:3000",
    "https://example.123",
    "http://127.0.0.01:3000",
  ]) {
    assert.equal(isDeviceAuthAudience(origin), false, origin);
    assert.throws(
      () =>
        deviceAuthInput({
          purpose: "ws",
          audience: origin,
          nonce: NONCE,
          deviceId: DEVICE_ID,
          connectionId: OTHER_ID,
        }),
      TypeError,
      origin,
    );
  }
});

test("the audience host is at most 253 characters", () => {
  const label = "a".repeat(63);
  const host253 = [label, label, label, "a".repeat(61)].join(".");
  assert.equal(host253.length, 253);
  assert.equal(isDeviceAuthAudience(`https://${host253}`), true);
  assert.equal(isDeviceAuthAudience(`https://${host253}:8443`), true);
  assert.equal(isDeviceAuthAudience(`https://a${host253}`), false);
});
