// The resync gate (#27, #28): the protocol's rule for reloading a workspace
// after `workspace.subscribed` (the protocol package's README, "Workspace
// subscriptions, presence, and chat", decision 5). Events are not replayed,
// so the device reloads its state over HTTP and buffers the workspace's
// events until the reload answers, then applies the buffered events in order
// on top of the reloaded state. The HTTP answer carries no event IDs:
// applying it over events that arrived first would lose them.
//
// The gate holds no state of the workspace itself. Each service that keeps
// workspace state (the workspace, chat, and agent services) owns one gate, so
// that their reloads stay independent; the service passes in the events of
// its subscribed workspace and applies what the gate returns. Every reload
// of the service goes through `subscribed` or `begin`, also the ones that are
// not caused by `workspace.subscribed`, so that an answer for an earlier
// request is never applied over a later one. The gate does no I/O and keeps no timers: the
// service sends the requests and decides when to retry.
//
// Why dropping an event is safe when a reload follows: the server relays an
// event only after its commit, and the device sends its request only after
// `begin`, so every event that arrived before `begin` is already part of the
// state that the request reads. Applying an event again changes nothing,
// because every event sets the state it reports and chat messages are
// deduplicated by message ID.

/**
 * At most this many events wait for a reload, the same bound as
 * `MAX_ANSWER_LIST_ITEMS` of the protocol package.
 */
export const MAX_BUFFERED_EVENTS = 1_000;

/**
 * At most this many bytes of events wait for a reload, measured with the
 * service's `sizeOf`. 4 MiB holds 64 of the largest chat messages (about
 * 64,600 bytes as JSON) and 4 of the largest messages that the connection
 * client accepts (`RECEIVE_LIMIT_BYTES`, 1 MiB), so a single event always
 * fits; without it, 1,000 of the largest chat messages would hold about
 * 64 MB for each gate. An overflow costs one more reload, nothing else.
 */
export const MAX_BUFFERED_EVENT_BYTES = 4 * 1024 * 1024;

/**
 * Names one reload. Only the latest one counts: an answer for another
 * generation is stale.
 */
export type ResyncGeneration = number;

/**
 * - `inactive`: no subscription; events are ignored. A reload may still be
 *   open, for example for a project opened while offline.
 * - `reloading`: subscribed, and the reload of the current generation has
 *   not answered; events wait in the buffer.
 * - `failed`: the current reload failed; events still wait in the buffer
 *   until the service retries with `begin`.
 * - `overflowed`: the buffer overflowed and was cleared; events are dropped
 *   until the service starts a reload with `begin`, which must then reload
 *   everything that the service holds.
 * - `live`: subscribed and reloaded; events apply at once.
 */
export type ResyncState =
  "inactive" | "reloading" | "failed" | "overflowed" | "live";

/**
 * What the service does with a pushed event: `apply` it now; after
 * `overflowed`, which cleared the buffer (the event included), begin a
 * reload of its whole state when its backoff allows. The others need
 * nothing: `buffered` waits for the reload; `dropped` arrived after an
 * overflow, so the next reload holds it; `ignored` arrived without a
 * subscription.
 */
export type ResyncPushResult =
  "apply" | "buffered" | "overflowed" | "dropped" | "ignored";

export interface ResyncGateOptions<Event> {
  /**
   * The event's size in bytes, for example the length of its JSON in UTF-8.
   * Called only for an event that would be buffered. A size that is not a
   * finite number of at least zero counts as too large.
   */
  readonly sizeOf: (event: Event) => number;
}

export interface ResyncGate<Event> {
  /** The current state. */
  readonly state: () => ResyncState;
  /**
   * The current generation. A service that sends another request, such as
   * one for an older page of the chat, notes it and drops the answer when
   * it changed meanwhile.
   */
  readonly generation: () => ResyncGeneration;
  /**
   * `workspace.subscribed` arrived, also a fresh one for an existing
   * subscription: the subscription is live, and a reload begins as with
   * `begin`. The service sends its request after this call.
   */
  readonly subscribed: () => ResyncGeneration;
  /**
   * A reload begins: after a change of the open project, a reload that the
   * service decided on, a retry after `reloadFailed`, and the reload after
   * an overflow. The previous generation becomes stale. While subscribed,
   * events wait in the buffer from now on; the events that already wait are
   * kept, because a reload of only a part of the service's state does not
   * contain them, and applying them again changes nothing. The service sends
   * its request after this call.
   */
  readonly begin: () => ResyncGeneration;
  /** An event of the subscribed workspace arrived. */
  readonly push: (event: Event) => ResyncPushResult;
  /**
   * The reload of `generation` answered. Returns the events that waited, in
   * the order they arrived, which the service applies right after the
   * reloaded state, and the gate goes live while subscribed. Returns `null`
   * for a stale generation, a generation that already answered, and after
   * an overflow; the service then drops the answer.
   */
  readonly reloaded: (generation: ResyncGeneration) => readonly Event[] | null;
  /**
   * The reload of `generation` failed. While subscribed, the events keep
   * waiting until the service retries with `begin`. Returns false, and
   * changes nothing, for a stale generation or one that already answered.
   */
  readonly reloadFailed: (generation: ResyncGeneration) => boolean;
  /**
   * The subscription ended (`workspace.unsubscribed`, a refusal, or a
   * change of the workspace) or the connection was lost: the buffered events
   * are dropped, the open reload becomes stale, and later events are ignored
   * until `subscribed`. Without a subscription it changes nothing.
   */
  readonly end: () => void;
}

/** Creates the gate of one service, inactive until `subscribed`. */
export function createResyncGate<Event>(
  options: ResyncGateOptions<Event>,
): ResyncGate<Event> {
  const { sizeOf } = options;
  let generation: ResyncGeneration = 0;
  /** Whether the reload of `generation` has not answered yet. */
  let open = false;
  /** One of the subscribed states while subscribed, else `inactive`. */
  let state: ResyncState = "inactive";
  let buffer: Event[] = [];
  let bufferedBytes = 0;

  function clearBuffer(): void {
    buffer = [];
    bufferedBytes = 0;
  }

  function begin(): ResyncGeneration {
    generation += 1;
    open = true;
    if (state === "live" || state === "overflowed") {
      clearBuffer();
    }
    if (state !== "inactive") {
      state = "reloading";
    }
    return generation;
  }

  function push(event: Event): ResyncPushResult {
    switch (state) {
      case "inactive":
        return "ignored";
      case "live":
        return "apply";
      case "overflowed":
        return "dropped";
      case "reloading":
      case "failed": {
        const size = sizeOf(event);
        if (
          !Number.isFinite(size) ||
          size < 0 ||
          buffer.length >= MAX_BUFFERED_EVENTS ||
          bufferedBytes + size > MAX_BUFFERED_EVENT_BYTES
        ) {
          // The open reload cannot be completed without the dropped events,
          // so it becomes stale; the next one starts after this event.
          clearBuffer();
          generation += 1;
          open = false;
          state = "overflowed";
          return "overflowed";
        }
        buffer.push(event);
        bufferedBytes += size;
        return "buffered";
      }
    }
  }

  return {
    state: () => state,
    generation: () => generation,
    subscribed: () => {
      if (state === "inactive") {
        clearBuffer();
        state = "reloading";
      }
      return begin();
    },
    begin,
    push,
    reloaded: (answered) => {
      if (answered !== generation || !open) {
        return null;
      }
      open = false;
      const events = Object.freeze(buffer);
      clearBuffer();
      if (state !== "inactive") {
        state = "live";
      }
      return events;
    },
    reloadFailed: (answered) => {
      if (answered !== generation || !open) {
        return false;
      }
      open = false;
      if (state !== "inactive") {
        state = "failed";
      }
      return true;
    },
    end: () => {
      if (state === "inactive") {
        return;
      }
      clearBuffer();
      generation += 1;
      open = false;
      state = "inactive";
    },
  };
}
