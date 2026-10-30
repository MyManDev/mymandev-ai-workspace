const REDACTED = "[redacted]";

/**
 * A configuration value that must never be printed, such as the GitHub
 * client secret or a database URL with its password. Logging, JSON, string
 * conversion, and `util.inspect` all show "[redacted]"; only `reveal()`
 * returns the value, at the one place that uses it.
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
    Object.freeze(this);
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `Secret(${REDACTED})`;
  }
}
