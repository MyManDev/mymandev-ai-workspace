// Sign-in timing that the main process and the renderer share. This module
// imports nothing, so the renderer may import its values.

/**
 * How long after a start that opened the browser, or offered its URL, the
 * next start is refused (`too_soon`), so that even a renderer that
 * misbehaves cannot open the browser in a loop.
 */
export const SIGN_IN_START_COOLDOWN_MS = 3_000;
