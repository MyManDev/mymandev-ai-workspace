// Protocol v0 vocabulary: plain constants and functions without a zod import,
// so that other packages (for example the database CHECK constraints) can use
// them directly.

/**
 * The protocol version of this package. Version 0 is pre-stable: peers must
 * run the same version, and any other version is rejected as unsupported.
 */
export const PROTOCOL_VERSION = 0;

/**
 * The closed capability vocabulary. Exact match only: no wildcard, no
 * hierarchy and no implication between capabilities. This package defines
 * the names only; every grant check lives in the permissions package (M1-06).
 */
export const CAPABILITIES = [
  "repo.read",
  "repo.write",
  "terminal.execute",
  "git.commit",
  "git.push",
  "provider.use",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** The six agent run states. */
export const RUN_STATES = [
  "queued",
  "running",
  "awaiting_input",
  "completed",
  "failed",
  "cancelled",
] as const;
export type RunState = (typeof RUN_STATES)[number];

/** The state of a newly created run. Only the server creates runs. */
export const INITIAL_RUN_STATE = "queued" satisfies RunState;

/** States without an outgoing transition. A retry is a new run. */
export const TERMINAL_RUN_STATES = [
  "completed",
  "failed",
  "cancelled",
] as const satisfies readonly RunState[];
export type TerminalRunState = (typeof TERMINAL_RUN_STATES)[number];

/** Allowed next states for every run state. */
export const RUN_TRANSITIONS = {
  queued: ["running", "failed", "cancelled"],
  running: ["awaiting_input", "completed", "failed", "cancelled"],
  awaiting_input: ["running", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
} as const satisfies Record<RunState, readonly RunState[]>;

/** Whether a run may move from `from` to `to`. `from` is null when the run is created. */
export function canTransition(from: RunState | null, to: RunState): boolean {
  if (from === null) {
    return to === INITIAL_RUN_STATE;
  }
  const allowed: readonly RunState[] = RUN_TRANSITIONS[from];
  return allowed.includes(to);
}

/** Whether a run in this state is finished and can never change again. */
export function isTerminalRunState(state: RunState): state is TerminalRunState {
  const terminal: readonly RunState[] = TERMINAL_RUN_STATES;
  return terminal.includes(state);
}

/** Operating systems of a desktop device. */
export const DEVICE_PLATFORMS = ["windows", "macos", "linux"] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

/** A UUIDv7 in canonical lowercase form. Uppercase is rejected on purpose. */
export const UUIDV7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** An event type: lowercase snake_case `<domain>.<entity>.<past_tense>`. */
export const EVENT_TYPE_PATTERN =
  /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u;

/**
 * Human-entered text: rejects control, format (including bidirectional and tag
 * characters), surrogate, private-use, line and paragraph separator, and
 * default-ignorable characters. ZWNJ, ZWJ and the two emoji variation
 * selectors stay allowed for Persian, Indic scripts and emoji sequences.
 * They are alternatives, not a character class, because a joiner or a
 * variation selector inside a class is misleading (ESLint
 * no-misleading-character-class).
 * The `u` flag (not `v`) keeps z.toJSONSchema patterns valid.
 * Every invisible character in this source is written as an escape.
 */
export const SAFE_TEXT_PATTERN =
  /^(?:[^\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}\p{DI}]|\u200C|\u200D|\uFE0E|\uFE0F)*$/u;

/** At least one character that is not white space. */
export const NOT_BLANK_PATTERN = /\S/u;

/** Maximum lengths, in UTF-16 code units, of strings on the wire. */
export const LIMITS = {
  /** User display name. */
  displayName: 64,
  /** Device label. */
  deviceLabel: 64,
  /** Workspace, project and repository names. */
  name: 100,
  /** Agent name. */
  agentName: 64,
  /** Reason given with a run state change. */
  runReason: 500,
  /** Event type name. */
  eventType: 100,
} as const;
