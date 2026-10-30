import { type DeviceId, newUuidV7, type UserId } from "@mymandev/protocol";
import { randomToken, sha256Hex } from "./attempts.ts";

export type StoreOptions = Readonly<{
  max: number;
  lifetimeMs: number;
  now: () => number;
}>;

/** Single-use challenges for access tokens (ADR 0014, "Device key and authentication", HTTP). */
export class Challenges {
  readonly #byId = new Map<string, { nonce: string; expiresAt: number }>();
  readonly #options: StoreOptions;

  constructor(options: StoreOptions) {
    this.#options = options;
  }

  /** A new challenge; null when the global cap of open challenges is reached. */
  issue(): { challengeId: string; nonce: string } | null {
    this.sweep();
    if (this.#byId.size >= this.#options.max) {
      return null;
    }
    const challengeId = newUuidV7();
    const nonce = randomToken();
    this.#byId.set(challengeId, {
      nonce,
      expiresAt: this.#options.now() + this.#options.lifetimeMs,
    });
    return { challengeId, nonce };
  }

  /** The nonce of a live challenge, once; null when it is unknown, used, or expired. */
  take(challengeId: string): string | null {
    const challenge = this.#byId.get(challengeId);
    this.#byId.delete(challengeId);
    if (challenge === undefined || challenge.expiresAt <= this.#options.now()) {
      return null;
    }
    return challenge.nonce;
  }

  sweep(): void {
    const now = this.#options.now();
    for (const [id, challenge] of this.#byId) {
      if (challenge.expiresAt <= now) {
        this.#byId.delete(id);
      }
    }
  }
}

export type AccessTokenRecord = Readonly<{
  userId: UserId;
  deviceId: DeviceId;
  /** The device's last sign-in when the token was minted; a newer sign-in ends the token. */
  signedInAt: number;
  expiresAt: number;
}>;

export const ACCESS_TOKEN_PREFIX = "mmda_";

/** A device needs one token at a time; a few cover overlapping requests. */
const MAX_TOKENS_PER_DEVICE = 3;

/**
 * Access tokens, kept only as hashes in API memory and never extended. A
 * device keeps at most three live tokens: minting a fourth drops the oldest.
 */
export class AccessTokens {
  readonly #byHash = new Map<string, AccessTokenRecord>();
  readonly #byDevice = new Map<DeviceId, string[]>();
  readonly #options: StoreOptions;

  constructor(options: StoreOptions) {
    this.#options = options;
  }

  /** Issues a token; null when the global cap is reached. */
  issue(
    owner: Omit<AccessTokenRecord, "expiresAt">,
  ): { accessToken: string; expiresAt: number } | null {
    const hashes = (this.#byDevice.get(owner.deviceId) ?? []).filter((hash) =>
      this.#byHash.has(hash),
    );
    while (hashes.length >= MAX_TOKENS_PER_DEVICE) {
      const oldest = hashes.shift();
      if (oldest !== undefined) {
        this.#byHash.delete(oldest);
      }
    }
    if (this.#byHash.size >= this.#options.max) {
      this.#byDevice.set(owner.deviceId, hashes);
      return null;
    }
    const accessToken = `${ACCESS_TOKEN_PREFIX}${randomToken()}`;
    const expiresAt = this.#options.now() + this.#options.lifetimeMs;
    const hash = sha256Hex(accessToken);
    this.#byHash.set(hash, Object.freeze({ ...owner, expiresAt }));
    hashes.push(hash);
    this.#byDevice.set(owner.deviceId, hashes);
    return { accessToken, expiresAt };
  }

  /** The record of a live token; null when it is unknown or expired. */
  find(accessToken: string): AccessTokenRecord | null {
    const hash = sha256Hex(accessToken);
    const record = this.#byHash.get(hash);
    if (record === undefined) {
      return null;
    }
    if (record.expiresAt <= this.#options.now()) {
      this.#byHash.delete(hash);
      return null;
    }
    return record;
  }

  /** Drops every token of a device, after a sign-out or a revocation. */
  dropDevice(deviceId: DeviceId): void {
    for (const hash of this.#byDevice.get(deviceId) ?? []) {
      this.#byHash.delete(hash);
    }
    this.#byDevice.delete(deviceId);
  }

  /** Drops expired tokens; the API runs it on a timer, never on the request path. */
  sweep(): void {
    const now = this.#options.now();
    for (const [hash, record] of this.#byHash) {
      if (record.expiresAt <= now) {
        this.#byHash.delete(hash);
      }
    }
    for (const [deviceId, hashes] of this.#byDevice) {
      const live = hashes.filter((hash) => this.#byHash.has(hash));
      if (live.length === 0) {
        this.#byDevice.delete(deviceId);
      } else {
        this.#byDevice.set(deviceId, live);
      }
    }
  }
}

/** A fixed-window counter per key, for limits that need the authenticated device or user. */
export class WindowLimiter {
  readonly #windows = new Map<string, { start: number; count: number }>();
  readonly #max: number;
  readonly #windowMs: number;
  readonly #now: () => number;

  constructor(max: number, windowMs: number, now: () => number) {
    this.#max = max;
    this.#windowMs = windowMs;
    this.#now = now;
  }

  /** Counts one request; returns the seconds to wait when the key is over its limit, else 0. */
  hit(key: string): number {
    const now = this.#now();
    const window = this.#windows.get(key);
    if (window === undefined || now - window.start >= this.#windowMs) {
      this.#windows.set(key, { start: now, count: 1 });
      return 0;
    }
    window.count += 1;
    return window.count > this.#max
      ? Math.max(1, Math.ceil((window.start + this.#windowMs - now) / 1000))
      : 0;
  }

  sweep(): void {
    const now = this.#now();
    for (const [key, window] of this.#windows) {
      if (now - window.start >= this.#windowMs) {
        this.#windows.delete(key);
      }
    }
  }
}
