import { expect, test, vi } from "vitest";
import {
  createResyncGate,
  MAX_BUFFERED_EVENT_BYTES,
  MAX_BUFFERED_EVENTS,
  type ResyncGate,
} from "./resync.ts";

interface TestEvent {
  readonly id: string;
  readonly size: number;
}

function event(id: string, size = 100): TestEvent {
  return { id, size };
}

function gate(): ResyncGate<TestEvent> {
  return createResyncGate<TestEvent>({ sizeOf: (pushed) => pushed.size });
}

function ids(events: readonly TestEvent[] | null): string[] | null {
  return events === null ? null : events.map((pushed) => pushed.id);
}

test("before any subscription, events are ignored and no reload is open", () => {
  const resync = gate();
  expect(resync.state()).toBe("inactive");
  expect(resync.push(event("a"))).toBe("ignored");
  expect(resync.reloaded(resync.generation())).toBeNull();
  expect(resync.reloadFailed(resync.generation())).toBe(false);
  expect(resync.state()).toBe("inactive");
});

test("after subscribed, events wait for the reload and come back in order", () => {
  const resync = gate();
  const generation = resync.subscribed();
  expect(resync.state()).toBe("reloading");
  expect(resync.generation()).toBe(generation);
  for (const id of ["a", "b", "c"]) {
    expect(resync.push(event(id))).toBe("buffered");
  }

  expect(ids(resync.reloaded(generation))).toEqual(["a", "b", "c"]);
  expect(resync.state()).toBe("live");
  expect(resync.push(event("d"))).toBe("apply");
  // A generation answers once.
  expect(resync.reloaded(generation)).toBeNull();
  expect(resync.reloadFailed(generation)).toBe(false);
  expect(resync.state()).toBe("live");
});

test("a reload without waiting events answers with none", () => {
  const resync = gate();
  const generation = resync.subscribed();
  expect(resync.reloaded(generation)).toEqual([]);
  expect(resync.state()).toBe("live");
});

test("the returned events are frozen, and later events do not change them", () => {
  const resync = gate();
  const generation = resync.subscribed();
  resync.push(event("a"));
  const events = resync.reloaded(generation);
  expect(Object.isFrozen(events)).toBe(true);

  const next = resync.begin("all").generation;
  resync.push(event("b"));
  expect(ids(events)).toEqual(["a"]);
  expect(ids(resync.reloaded(next))).toEqual(["b"]);
});

test("a second subscribed during a reload makes the first answer stale", () => {
  const resync = gate();
  const first = resync.subscribed();
  resync.push(event("a"));
  const second = resync.subscribed();
  expect(second).not.toBe(first);
  resync.push(event("b"));

  expect(resync.reloaded(first)).toBeNull();
  expect(resync.reloadFailed(first)).toBe(false);
  expect(resync.state()).toBe("reloading");
  expect(ids(resync.reloaded(second))).toEqual(["a", "b"]);
  expect(resync.state()).toBe("live");
});

test("a fresh subscribed while live starts an empty buffer", () => {
  const resync = gate();
  resync.reloaded(resync.subscribed());
  expect(resync.push(event("a"))).toBe("apply");

  const generation = resync.subscribed();
  expect(resync.state()).toBe("reloading");
  resync.push(event("b"));
  expect(ids(resync.reloaded(generation))).toEqual(["b"]);
});

test("begin while live starts an empty buffer; begin during a reload keeps the waiting events", () => {
  const resync = gate();
  resync.reloaded(resync.subscribed());
  expect(resync.push(event("live"))).toBe("apply");

  const projectChange = resync.begin("all");
  expect(projectChange.scope).toBe("all");
  expect(resync.state()).toBe("reloading");
  resync.push(event("a"));
  const debounced = resync.begin("all");
  resync.push(event("b"));

  // The answer for the previous project is dropped.
  expect(resync.reloaded(projectChange.generation)).toBeNull();
  expect(ids(resync.reloaded(debounced.generation))).toEqual(["a", "b"]);
  expect(resync.state()).toBe("live");
});

test("a part reload while live or settled reads the part", () => {
  const resync = gate();
  // Without a subscription and without an earlier reload.
  const offline = resync.begin("part");
  expect(offline.scope).toBe("part");
  resync.reloaded(offline.generation);

  resync.reloaded(resync.subscribed());
  const agents = resync.begin("part");
  expect(agents.scope).toBe("part");
  expect(resync.state()).toBe("reloading");
  resync.push(event("a"));
  expect(ids(resync.reloaded(agents.generation))).toEqual(["a"]);
  expect(resync.state()).toBe("live");
  // The next part reload follows an answered one.
  expect(resync.begin("part").scope).toBe("part");
});

test("a part reload that replaces an open one reads everything", () => {
  // The agent list goes stale while the reload after subscribed is open.
  const resync = gate();
  const full = resync.subscribed();
  resync.push(event("a"));
  const agents = resync.begin("part");
  expect(agents.scope).toBe("all");
  resync.push(event("b"));
  expect(resync.reloaded(full)).toBeNull();
  expect(resync.state()).toBe("reloading");
  expect(ids(resync.reloaded(agents.generation))).toEqual(["a", "b"]);
  expect(resync.state()).toBe("live");

  // A second part during a first one reads everything, because the answer
  // for the first part is dropped.
  const runs = resync.begin("part");
  expect(runs.scope).toBe("part");
  expect(resync.begin("part").scope).toBe("all");
});

test("a part reload after a failure, an overflow, or end reads everything", () => {
  const failed = gate();
  failed.reloadFailed(failed.subscribed());
  expect(failed.begin("part").scope).toBe("all");

  const overflowed = gate();
  overflowed.subscribed();
  overflowed.push(event("a", MAX_BUFFERED_EVENT_BYTES + 1));
  expect(overflowed.begin("part").scope).toBe("all");

  const ended = gate();
  ended.subscribed();
  ended.end();
  expect(ended.begin("part").scope).toBe("all");

  // Without a subscription, a failed reload is owed too.
  const offline = gate();
  offline.reloadFailed(offline.begin("all").generation);
  const retry = offline.begin("part");
  expect(retry.scope).toBe("all");
  expect(offline.reloaded(retry.generation)).toEqual([]);
  expect(offline.begin("part").scope).toBe("part");
});

test("a failed reload keeps the waiting events until the retry answers", () => {
  const resync = gate();
  const first = resync.subscribed();
  resync.push(event("a"));
  expect(resync.reloadFailed(first)).toBe(true);
  expect(resync.state()).toBe("failed");
  expect(resync.push(event("b"))).toBe("buffered");
  // The failed generation answered; its late answer is dropped.
  expect(resync.reloaded(first)).toBeNull();
  expect(resync.reloadFailed(first)).toBe(false);
  expect(resync.state()).toBe("failed");

  const retry = resync.begin("all").generation;
  expect(resync.state()).toBe("reloading");
  resync.push(event("c"));
  expect(ids(resync.reloaded(retry))).toEqual(["a", "b", "c"]);
  expect(resync.state()).toBe("live");
});

test("a stale failure changes nothing", () => {
  const resync = gate();
  const first = resync.subscribed();
  const second = resync.begin("all").generation;
  resync.push(event("a"));
  expect(resync.reloadFailed(first)).toBe(false);
  expect(resync.state()).toBe("reloading");
  expect(ids(resync.reloaded(second))).toEqual(["a"]);
});

test("the 1,001st waiting event overflows, clears the buffer, and makes the reload stale", () => {
  const resync = gate();
  const generation = resync.subscribed();
  for (let index = 0; index < MAX_BUFFERED_EVENTS; index += 1) {
    expect(resync.push(event(`e${index}`, 1))).toBe("buffered");
  }
  expect(resync.state()).toBe("reloading");

  expect(resync.push(event("over", 1))).toBe("overflowed");
  expect(resync.state()).toBe("overflowed");
  expect(resync.generation()).not.toBe(generation);
  expect(resync.reloaded(generation)).toBeNull();
  expect(resync.reloadFailed(generation)).toBe(false);
  // No reload starts by itself: events are dropped until `begin`.
  expect(resync.push(event("later"))).toBe("dropped");
  expect(resync.state()).toBe("overflowed");
  expect(resync.reloaded(resync.generation())).toBeNull();

  const recovery = resync.begin("all").generation;
  expect(resync.state()).toBe("reloading");
  expect(resync.push(event("after"))).toBe("buffered");
  expect(ids(resync.reloaded(recovery))).toEqual(["after"]);
  expect(resync.state()).toBe("live");
});

test("waiting events overflow above the byte budget, and an event at the budget fits", () => {
  const resync = gate();
  const generation = resync.subscribed();
  expect(resync.push(event("a", MAX_BUFFERED_EVENT_BYTES - 10))).toBe(
    "buffered",
  );
  expect(resync.push(event("b", 10))).toBe("buffered");
  expect(resync.push(event("c", 0))).toBe("buffered");
  expect(resync.push(event("d", 1))).toBe("overflowed");
  expect(resync.reloaded(generation)).toBeNull();

  // The budget starts again with the next reload.
  const recovery = resync.begin("all").generation;
  expect(resync.push(event("e", MAX_BUFFERED_EVENT_BYTES))).toBe("buffered");
  expect(ids(resync.reloaded(recovery))).toEqual(["e"]);
});

test("a single event above the byte budget overflows at once", () => {
  const resync = gate();
  resync.subscribed();
  expect(resync.push(event("a", MAX_BUFFERED_EVENT_BYTES + 1))).toBe(
    "overflowed",
  );
  expect(resync.state()).toBe("overflowed");
});

test("a size that is not a finite number of at least zero overflows", () => {
  for (const size of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
    const resync = gate();
    resync.subscribed();
    expect(resync.push(event("a", size))).toBe("overflowed");
    expect(resync.state()).toBe("overflowed");
  }
});

test("the buffer also overflows after a failed reload", () => {
  const resync = gate();
  const generation = resync.subscribed();
  resync.reloadFailed(generation);
  expect(resync.push(event("a", MAX_BUFFERED_EVENT_BYTES))).toBe("buffered");
  expect(resync.push(event("b", 1))).toBe("overflowed");
  expect(resync.state()).toBe("overflowed");

  const recovery = resync.begin("all").generation;
  expect(ids(resync.reloaded(recovery))).toEqual([]);
});

test("the size is measured only for events that wait", () => {
  const sizeOf = vi.fn((pushed: TestEvent) => pushed.size);
  const resync = createResyncGate<TestEvent>({ sizeOf });
  resync.push(event("ignored"));
  const generation = resync.subscribed();
  resync.push(event("buffered"));
  expect(sizeOf).toHaveBeenCalledTimes(1);
  resync.reloaded(generation);
  resync.push(event("applied"));
  expect(sizeOf).toHaveBeenCalledTimes(1);
});

test("ending the subscription drops the waiting events and makes the reload stale", () => {
  const resync = gate();
  const generation = resync.subscribed();
  resync.push(event("a"));
  resync.end();
  expect(resync.state()).toBe("inactive");
  expect(resync.generation()).not.toBe(generation);
  expect(resync.reloaded(generation)).toBeNull();
  expect(resync.reloadFailed(generation)).toBe(false);
  expect(resync.push(event("b"))).toBe("ignored");

  const next = resync.subscribed();
  resync.push(event("c"));
  expect(ids(resync.reloaded(next))).toEqual(["c"]);
});

test("ending a live, a failed, or an overflowed subscription leaves the gate inactive", () => {
  const live = gate();
  const liveGeneration = live.subscribed();
  live.reloaded(liveGeneration);
  live.end();
  expect(live.state()).toBe("inactive");
  expect(live.generation()).not.toBe(liveGeneration);
  expect(live.push(event("a"))).toBe("ignored");

  const failed = gate();
  const failedGeneration = failed.subscribed();
  failed.push(event("a"));
  failed.reloadFailed(failedGeneration);
  failed.end();
  expect(failed.state()).toBe("inactive");
  expect(failed.generation()).not.toBe(failedGeneration);
  expect(failed.reloaded(failedGeneration)).toBeNull();
  expect(failed.push(event("b"))).toBe("ignored");
  // The events of the ended subscription do not come back.
  const next = failed.begin("all").generation;
  expect(ids(failed.reloaded(next))).toEqual([]);

  const overflowed = gate();
  overflowed.subscribed();
  overflowed.push(event("a", MAX_BUFFERED_EVENT_BYTES + 1));
  overflowed.end();
  expect(overflowed.state()).toBe("inactive");
  expect(overflowed.push(event("b"))).toBe("ignored");
});

test("a reload without a subscription stays inactive, and end makes it stale", () => {
  const resync = gate();
  const generation = resync.begin("all").generation;
  expect(resync.state()).toBe("inactive");
  expect(resync.push(event("a"))).toBe("ignored");
  expect(resync.reloaded(generation)).toEqual([]);
  expect(resync.state()).toBe("inactive");
  expect(resync.push(event("b"))).toBe("ignored");

  const failing = resync.begin("all").generation;
  expect(resync.reloadFailed(failing)).toBe(true);
  expect(resync.state()).toBe("inactive");

  // A change of the workspace while a reload for the previous one is open.
  const previous = resync.begin("all").generation;
  resync.end();
  expect(resync.state()).toBe("inactive");
  expect(resync.generation()).not.toBe(previous);
  expect(resync.reloaded(previous)).toBeNull();
  expect(resync.reloadFailed(previous)).toBe(false);
  // Without an open reload, end still changes the generation.
  const settled = resync.generation();
  resync.end();
  expect(resync.generation()).not.toBe(settled);
});

test("subscribed makes a reload without a subscription stale", () => {
  const resync = gate();
  const offline = resync.begin("all").generation;
  const generation = resync.subscribed();
  resync.push(event("a"));
  expect(resync.reloaded(offline)).toBeNull();
  expect(ids(resync.reloaded(generation))).toEqual(["a"]);
});

test("the gates of two services are independent", () => {
  const chat = gate();
  const agents = gate();
  const chatGeneration = chat.subscribed();
  const agentsGeneration = agents.subscribed();
  chat.push(event("message"));
  agents.push(event("run"));
  agents.push(event("big", MAX_BUFFERED_EVENT_BYTES + 1));

  expect(agents.state()).toBe("overflowed");
  expect(chat.state()).toBe("reloading");
  expect(agents.reloaded(agentsGeneration)).toBeNull();
  expect(ids(chat.reloaded(chatGeneration))).toEqual(["message"]);
});
