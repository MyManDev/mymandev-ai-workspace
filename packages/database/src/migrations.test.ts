import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { migrationsFolder } from "./migrate.ts";

type Journal = { entries: { idx: number; when: number; tag: string }[] };

// The drizzle-orm 0.45 migrator silently skips a migration whose `when` is older
// than the last applied one. Regenerate a migration after merging develop if this fails.
test("migration journal timestamps strictly increase", () => {
  const journal = JSON.parse(
    readFileSync(join(migrationsFolder, "meta", "_journal.json"), "utf8"),
  ) as Journal;
  assert.ok(journal.entries.length > 0);
  journal.entries.forEach((entry, index) => {
    assert.equal(entry.idx, index);
    const previous = journal.entries[index - 1];
    if (previous) {
      assert.ok(
        entry.when > previous.when,
        `${entry.tag} is not newer than ${previous.tag}`,
      );
    }
  });
});
