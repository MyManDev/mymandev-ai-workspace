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
  /**
   * When GitHub's callback started the code exchange that read the identity,
   * in milliseconds since the epoch: a GitHub revocation recorded later
   * refuses the sign-in.
   */
  identityReadAt: number | null;
};

export type AttemptStoreOptions = Readonly<{
  max: number;
  lifetimeMs: number;
  now: () => number;
}>;

/**
 * Why an attempt could not start: the store is full, or the desktop's
 * `code_challenge` or `state` already started an attempt (#149).
 */
export type AttemptRefusal = "full" | "reused";

/** Open sign-in attempts by the API's state, with a global cap. */
export class SignInAttempts {
  readonly #byState = new Map<string, SignInAttempt>();
  /**
   * The desktop values that started an attempt, as hashes, until that
   * attempt's lifetime ends, also after the attempt itself ended.
   */
  readonly #seenDesktop = new Map<string, number>();
  readonly #options: AttemptStoreOptions;

  constructor(options: AttemptStoreOptions) {
    this.#options = options;
  }

  get size(): number {
    this.sweep();
    return this.#byState.size;
  }

  /**
   * Starts an attempt; the cookie value is returned once and kept only as a
   * hash. Refuses `"full"` when the cap is reached, and `"reused"` when the
   * desktop's `code_challenge` or `state` started an attempt within the
   * attempt lifetime, ended or not. The authorize URL carries both, so a
   * second start with them could let another GitHub account produce a code
   * that the desktop's listener accepts and its verifier redeems (#149).
   */
  create(
    desktop: DesktopRequest,
  ): { attempt: SignInAttempt; cookieValue: string } | AttemptRefusal {
    this.sweep();
    const keys = [
      `challenge:${sha256Hex(desktop.codeChallenge)}`,
      `state:${sha256Hex(desktop.state)}`,
    ];
    if (keys.some((key) => this.#seenDesktop.has(key))) {
      return "reused";
    }
    // Two keys per attempt, and attempts that ended early keep theirs.
    if (
      this.#byState.size >= this.#options.max ||
      this.#seenDesktop.size + keys.length > this.#options.max * 4
    ) {
      return "full";
    }
    const cookieValue = randomToken();
    const expiresAt = this.#options.now() + this.#options.lifetimeMs;
    const attempt: SignInAttempt = {
      apiState: randomToken(),
      cookieHash: sha256Hex(cookieValue),
      apiVerifier: randomToken(),
      desktop,
      expiresAt,
      phase: "started",
      identity: null,
      identityReadAt: null,
    };
    this.#byState.set(attempt.apiState, attempt);
    for (const key of keys) {
      this.#seenDesktop.set(key, expiresAt);
    }
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
    for (const [key, expiresAt] of this.#seenDesktop) {
      if (expiresAt <= now) {
        this.#seenDesktop.delete(key);
      }
    }
  }
}

/** What a sign-in code is bound to (ADR 0014, step 5). */
export type SignInCodeRecord = Readonly<{
  identity: GitHubIdentity;
  /** The attempt's `identityReadAt`. */
  identityReadAt: number;
  desktopCodeChallenge: string;
  redirectUri: string;
  expiresAt: number;
}>;

/**
 * What a sign-in code that a request of its own attempt took was bound to,
 * so that a repeated request can prove it belongs to the same attempt (#152).
 */
export type UsedSignInCode = Readonly<{
  desktopCodeChallenge: string;
  redirectUri: string;
  expiresAt: number;
}>;

export const SIGN_IN_CODE_PREFIX = "mmdc_";

/** Single-use sign-in codes, kept only as hashes, with a cap. */
export class SignInCodes {
  readonly #byHash = new Map<string, SignInCodeRecord>();
  /**
   * The codes that a request of their own attempt took (`markUsed`), by the
   * same hash, until one code lifetime after that request ended: a copy of a
   * request that committed can arrive after the first copy took the code
   * (#152). Memory only, like the codes: a restart drops them.
   */
  readonly #usedByHash = new Map<string, UsedSignInCode>();
  readonly #options: AttemptStoreOptions;

  constructor(options: AttemptStoreOptions) {
    this.#options = options;
  }

  /**
   * Issues a code bound to the record; null when the cap is reached. A code
   * recorded as used keeps a place until its record expires, so live codes
   * and records together stay within twice the cap.
   */
  issue(binding: Omit<SignInCodeRecord, "expiresAt">): string | null {
    this.sweep();
    if (
      this.#byHash.size >= this.#options.max ||
      this.#byHash.size + this.#usedByHash.size >= this.#options.max * 2
    ) {
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

  /**
   * Records a code that `take` returned as used by a request of its own
   * attempt, until one code lifetime from now; another call moves that end.
   * Right after the take it always fits, because the take freed a place; a
   * record that expired and left meanwhile comes back only within the cap.
   */
  markUsed(
    code: string,
    binding: Pick<SignInCodeRecord, "desktopCodeChallenge" | "redirectUri">,
  ): void {
    const hash = sha256Hex(code);
    if (
      !this.#usedByHash.has(hash) &&
      this.#byHash.size + this.#usedByHash.size >= this.#options.max * 2
    ) {
      return;
    }
    this.#usedByHash.set(
      hash,
      Object.freeze({
        desktopCodeChallenge: binding.desktopCodeChallenge,
        redirectUri: binding.redirectUri,
        expiresAt: this.#options.now() + this.#options.lifetimeMs,
      }),
    );
  }

  /** What a code that `markUsed` recorded was bound to; null when there is no record or it expired. */
  used(code: string): UsedSignInCode | null {
    const record = this.#usedByHash.get(sha256Hex(code));
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
    for (const [hash, record] of this.#usedByHash) {
      if (record.expiresAt <= now) {
        this.#usedByHash.delete(hash);
      }
    }
  }
}

/**
 * GitHub revocations of the last minutes, by GitHub's numeric ID, kept only
 * in API memory (#115). The webhook records every verified revocation here
 * before its transaction, also of a sender without an account, so that a
 * sign-in whose identity the API read earlier is refused even when it
 * creates the account. The lifetime covers an attempt and its sign-in code,
 * with a margin; at the cap the oldest entry leaves, and a restart drops
 * them all, like the attempts themselves.
 */
export class RecentRevocations {
  readonly #bySubject = new Map<string, number>();
  readonly #options: AttemptStoreOptions;

  constructor(options: AttemptStoreOptions) {
    this.#options = options;
  }

  get size(): number {
    this.sweep();
    return this.#bySubject.size;
  }

  /** Records a revocation at `at`, in milliseconds since the epoch; a later one of the same ID replaces it. */
  record(subject: string, at: number): void {
    this.sweep();
    const previous = this.#bySubject.get(subject);
    this.#bySubject.delete(subject);
    for (const oldest of this.#bySubject.keys()) {
      if (this.#bySubject.size < this.#options.max) {
        break;
      }
      this.#bySubject.delete(oldest);
    }
    this.#bySubject.set(subject, Math.max(previous ?? at, at));
  }

  /** The time of the latest recorded revocation of this GitHub ID; null when there is none or it expired. */
  latest(subject: string): number | null {
    const at = this.#bySubject.get(subject);
    if (
      at === undefined ||
      at + this.#options.lifetimeMs <= this.#options.now()
    ) {
      return null;
    }
    return at;
  }

  /** Drops expired entries; the API also runs it on a timer, so nothing outlives its lifetime by much. */
  sweep(): void {
    const now = this.#options.now();
    for (const [subject, at] of this.#bySubject) {
      if (at + this.#options.lifetimeMs <= now) {
        this.#bySubject.delete(subject);
      }
    }
  }
}
