// The recorder of the permission enforcement point in memory (#55): the
// default until #37 replaces it with the local append-only recorder, which
// keeps the tool-call and audit records on the device in a file. Default
// until the Project Manager decides otherwise; nothing here is written to
// disk or sent anywhere.
//
// It keeps the most recent `MEMORY_RECORDER_LIMIT` records, oldest first,
// and drops the oldest record when a new one arrives beyond the bound. It
// takes every record, so it never throws and always returns `undefined`,
// and an allowed start of `terminal.execute` is never denied for want of a
// record (`record_failed`) while it is in use. Each record is kept frozen,
// as the enforcement point passes it. It logs nothing, so no record, and no
// ID in one, reaches a log. The records are lost when the application
// quits.
import type { EnforcementRecord, EnforcementRecorder } from "./enforcement.ts";

/**
 * How many records the recorder keeps: the most recent 1,000. A record holds
 * at most five IDs, a capability, a reason, and a time, so they stay well
 * below 1 MB, also when an executor that misbehaves is denied in a loop.
 */
export const MEMORY_RECORDER_LIMIT = 1_000;

export interface MemoryEnforcementRecorder extends EnforcementRecorder {
  /** The records kept, oldest first, as a frozen copy of the list. */
  readonly records: () => readonly EnforcementRecord[];
}

/**
 * Creates the recorder. `limit` is the number of records kept; a value that
 * is not a positive safe integer falls back to `MEMORY_RECORDER_LIMIT`.
 */
export function createMemoryEnforcementRecorder(
  limit: number = MEMORY_RECORDER_LIMIT,
): MemoryEnforcementRecorder {
  const bound =
    Number.isSafeInteger(limit) && limit > 0 ? limit : MEMORY_RECORDER_LIMIT;
  /** A ring of at most `bound` records; `next` is where the next one goes. */
  const ring: EnforcementRecord[] = [];
  let next = 0;

  return Object.freeze({
    record: (entry: EnforcementRecord): undefined => {
      try {
        Object.freeze(entry);
      } catch {
        // A record that cannot be frozen (a proxy that refuses) is still kept.
      }
      if (ring.length < bound) {
        ring.push(entry);
      } else {
        ring[next] = entry;
      }
      next = (next + 1) % bound;
      return undefined;
    },
    records: (): readonly EnforcementRecord[] =>
      Object.freeze(
        ring.length < bound
          ? [...ring]
          : [...ring.slice(next), ...ring.slice(0, next)],
      ),
  });
}
