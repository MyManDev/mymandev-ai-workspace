import type { Statement } from "./permission-view.ts";

// A fixed statement of the permission screen (`permission-view.ts`), shared
// by the reference part and the grant section.

/** A fixed statement, with capability names and commands as code. */
export function StatementText({
  statement,
}: {
  readonly statement: Statement;
}) {
  return statement.map((part, index) =>
    typeof part === "string" ? (
      part
    ) : (
      <code key={index}>
        {"capability" in part ? part.capability : part.command}
      </code>
    ),
  );
}
