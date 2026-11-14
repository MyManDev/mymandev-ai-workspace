// The words for a wait. A module without imports, so that every view of
// the renderer can import it: `account-view.ts` cannot import
// `people-actions-view.ts`, which imports it through `device-view.ts`.

/**
 * A wait of `ms` milliseconds in words, rounded up: seconds below a
 * minute, minutes below an hour, and hours above.
 */
export function describeWait(ms: number): string {
  const count = (value: number, unit: string) =>
    `${String(value)} ${unit}${value === 1 ? "" : "s"}`;
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds < 60) {
    return count(seconds, "second");
  }
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) {
    return count(minutes, "minute");
  }
  return count(Math.ceil(minutes / 60), "hour");
}
