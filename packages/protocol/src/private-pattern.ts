/**
 * A private copy of an exported pattern, for a schema. Changing the exported
 * pattern at runtime, for example with the legacy `RegExp.prototype.compile`,
 * then cannot change the schema. The copy is not frozen, because zod sets
 * `lastIndex` on a pattern before every check. Not exported from the package.
 */
export function privatePattern(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags);
}
