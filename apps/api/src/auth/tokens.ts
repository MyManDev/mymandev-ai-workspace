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
  expiresAt: number;
}>;

export const ACCESS_TOKEN_PREFIX = "mmda_";

/** Access tokens, kept only as hashes in API memory and never extended. */
export class AccessTokens {
  readonly #byHash = new Map<string, AccessTokenRecord>();
  readonly #options: StoreOptions;

  constructor(options: StoreOptions) {
    this.#options = options;
  }

  /** Issues a token; null when the cap is reached. */
  issue(
    owner: Readonly<{ userId: UserId; deviceId: DeviceId }>,
  ): { accessToken: string; expiresAt: number } | null {
    this.sweep();
    if (this.#byHash.size >= this.#options.max) {
      return null;
    }
    const accessToken = `${ACCESS_TOKEN_PREFIX}${randomToken()}`;
    const expiresAt = this.#options.now() + this.#options.lifetimeMs;
    this.#byHash.set(
      sha256Hex(accessToken),
      Object.freeze({ ...owner, expiresAt }),
    );
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
    for (const [hash, record] of this.#byHash) {
      if (record.deviceId === deviceId) {
        this.#byHash.delete(hash);
      }
    }
  }

  sweep(): void {
    const now = this.#options.now();
    for (const [hash, record] of this.#byHash) {
      if (record.expiresAt <= now) {
        this.#byHash.delete(hash);
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
