import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { GitHubIdentity } from "./github-api.ts";

/** 32 random bytes as 43 base64url characters (ADR 0004). */
export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

/** The SHA-256 hash of a secret, as 64 lowercase hexadecimal characters. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** The PKCE S256 challenge of a verifier. */
export function s256(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/** Compares two hashes of the same length in constant time. */
export function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/** What the desktop asked for, from `GET /auth/github/authorize`. */
export type DesktopRequest = Readonly<{
  codeChallenge: string;
  state: string;
  redirectUri: string;
}>;

/**
 * One sign-in attempt, kept only in API memory (ADR 0014, step 2). `phase`
 * moves forward only: `started` until GitHub's callback arrives, `callback`
 * while the callback runs, `identified` when the confirmation page is shown.
 */
export type SignInAttempt = {
  readonly apiState: string;
  readonly cookieHash: string;
  /** The API's own PKCE verifier for GitHub; readable, in memory only (ADR 0014). */
  readonly apiVerifier: string;
  readonly desktop: DesktopRequest;
  readonly expiresAt: number;
  phase: "started" | "callback" | "identified";
  identity: GitHubIdentity | null;
};

export type AttemptStoreOptions = Readonly<{
  max: number;
  lifetimeMs: number;
  now: () => number;
}>;

/** Open sign-in attempts by the API's state, with a global cap. */
export class SignInAttempts {
  readonly #byState = new Map<string, SignInAttempt>();
  readonly #options: AttemptStoreOptions;

  constructor(options: AttemptStoreOptions) {
    this.#options = options;
  }

  get size(): number {
    this.sweep();
    return this.#byState.size;
  }

  /** Starts an attempt; null when the cap is reached. The cookie value is returned once and kept only as a hash. */
  create(
    desktop: DesktopRequest,
  ): { attempt: SignInAttempt; cookieValue: string } | null {
    this.sweep();
    if (this.#byState.size >= this.#options.max) {
      return null;
    }
    const cookieValue = randomToken();
    const attempt: SignInAttempt = {
      apiState: randomToken(),
      cookieHash: sha256Hex(cookieValue),
      apiVerifier: randomToken(),
      desktop,
      expiresAt: this.#options.now() + this.#options.lifetimeMs,
      phase: "started",
      identity: null,
    };
    this.#byState.set(attempt.apiState, attempt);
    return { attempt, cookieValue };
  }

  /**
   * The live attempt for this state, only when the cookie belongs to it. A
   * request that names a live attempt without its cookie ends the attempt:
   * only GitHub and the browser that started it see the state, so such a
   * request is another browser carrying GitHub's code, as in the phishing
   * scenario of ADR 0014 ("Threats"), and the code must never be exchanged.
   */
  find(
    apiState: string,
    cookieValue: string | undefined,
  ): SignInAttempt | null {
    const attempt = this.#byState.get(apiState);
    if (attempt === undefined) {
      return null;
    }
    if (
      attempt.expiresAt <= this.#options.now() ||
      cookieValue === undefined ||
      !sameHash(attempt.cookieHash, sha256Hex(cookieValue))
    ) {
      this.#byState.delete(apiState);
      return null;
    }
    return attempt;
  }

  delete(attempt: SignInAttempt): void {
    this.#byState.delete(attempt.apiState);
  }

  /** Drops expired entries; the API also runs it on a timer, so nothing outlives its lifetime by much. */
  sweep(): void {
    const now = this.#options.now();
    for (const [state, attempt] of this.#byState) {
      if (attempt.expiresAt <= now) {
        this.#byState.delete(state);
      }
    }
  }
}

/** What a sign-in code is bound to (ADR 0014, step 5). */
export type SignInCodeRecord = Readonly<{
  identity: GitHubIdentity;
  desktopCodeChallenge: string;
  redirectUri: string;
  expiresAt: number;
}>;

export const SIGN_IN_CODE_PREFIX = "mmdc_";

/** Single-use sign-in codes, kept only as hashes, with a cap. */
export class SignInCodes {
  readonly #byHash = new Map<string, SignInCodeRecord>();
  readonly #options: AttemptStoreOptions;

  constructor(options: AttemptStoreOptions) {
    this.#options = options;
  }

  /** Issues a code bound to the record; null when the cap is reached. */
  issue(binding: Omit<SignInCodeRecord, "expiresAt">): string | null {
    this.sweep();
    if (this.#byHash.size >= this.#options.max) {
      return null;
    }
    const code = `${SIGN_IN_CODE_PREFIX}${randomToken()}`;
    this.#byHash.set(
      sha256Hex(code),
      Object.freeze({
        ...binding,
        expiresAt: this.#options.now() + this.#options.lifetimeMs,
      }),
    );
    return code;
  }

  /** Takes the record of a code once; null when it is unknown, used, or expired. */
  take(code: string): SignInCodeRecord | null {
    const hash = sha256Hex(code);
    const record = this.#byHash.get(hash);
    this.#byHash.delete(hash);
    if (record === undefined || record.expiresAt <= this.#options.now()) {
      return null;
    }
    return record;
  }

  /** Drops expired entries; the API also runs it on a timer, so nothing outlives its lifetime by much. */
  sweep(): void {
    const now = this.#options.now();
    for (const [hash, record] of this.#byHash) {
      if (record.expiresAt <= now) {
        this.#byHash.delete(hash);
      }
    }
  }
}
