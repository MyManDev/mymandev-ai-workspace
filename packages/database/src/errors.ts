/** A database failure that carries no SQL text, parameters or row details. */
export class DatabaseError extends Error {
  override readonly name = "DatabaseError";
  /** SQLSTATE such as 23505, or a driver code such as ECONNREFUSED. */
  readonly code: string | undefined;
  /** The name of the violated constraint, if the server reported one. */
  readonly constraint: string | undefined;

  constructor(code: string | undefined, constraint: string | undefined) {
    super(
      `Database operation failed (code ${code ?? "unknown"}${constraint === undefined ? "" : `, constraint ${constraint}`})`,
    );
    this.code = code;
    this.constraint = constraint;
  }
}

/** Reads a code or constraint name, and only if it looks like an identifier. */
function readCode(
  value: unknown,
  key: "code" | "constraint",
): string | undefined {
  if (typeof value !== "object" || value === null || !(key in value)) {
    return undefined;
  }
  const field: unknown = (value as Record<string, unknown>)[key];
  return typeof field === "string" && /^[0-9A-Za-z_]{1,63}$/.test(field)
    ? field
    : undefined;
}

/**
 * Replaces a driver or Drizzle error, whose message, stack and details contain
 * the SQL text and every parameter value, with a DatabaseError.
 */
export function toDatabaseError(error: unknown): DatabaseError {
  if (error instanceof DatabaseError) {
    return error;
  }
  const source =
    error instanceof Error && error.cause !== undefined ? error.cause : error;
  return new DatabaseError(
    readCode(source, "code"),
    readCode(source, "constraint"),
  );
}

/** Every query function in this package runs its statements through this wrapper. */
export async function withDatabaseErrors<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw toDatabaseError(error);
  }
}
