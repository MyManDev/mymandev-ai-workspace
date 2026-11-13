// What the person can see of the recent claims: the page's visibility, the
// window's focus, and the rows in view, each followed through fakes of the
// document, the window, and the observer (the Project Manager's decision of
// 2026-11-13 on #273). No DOM is used.
import { expect, test } from "vitest";
import {
  followDocumentVisibility,
  followRowsInView,
  followWindowFocus,
  NO_PAGE_ATTENTION,
  ROW_IN_VIEW_RATIO,
  type RowEntry,
  type RowObserver,
  type RowObserverFactory,
} from "./claims-attention.ts";

const ADA = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c1";
const LINUS = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c3";

/** An event target that records its listeners by type. */
function target() {
  const listeners = new Map<string, Set<() => void>>();
  return {
    listeners,
    addEventListener: (type: string, listener: () => void) => {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener: (type: string, listener: () => void) => {
      listeners.get(type)?.delete(listener);
    },
    fire: (type: string) => {
      for (const listener of listeners.get(type) ?? []) {
        listener();
      }
    },
    count: () =>
      [...listeners.values()].reduce((total, set) => total + set.size, 0),
  };
}

test("nothing counts as seen before the first reading: the page starts hidden and without the focus", () => {
  expect(NO_PAGE_ATTENTION).toEqual({
    documentShown: false,
    windowFocused: false,
  });
});

test("the document's visibility is read at once and on every change, and only hidden hides it", () => {
  const doc = { ...target(), visibilityState: "visible" };
  const shown: boolean[] = [];
  const stop = followDocumentVisibility(doc, (value) => shown.push(value));
  expect(shown).toEqual([true]);
  doc.visibilityState = "hidden";
  doc.fire("visibilitychange");
  doc.visibilityState = "visible";
  doc.fire("visibilitychange");
  expect(shown).toEqual([true, false, true]);
  expect(doc.count()).toBe(1);
  stop();
  expect(doc.count()).toBe(0);
  doc.visibilityState = "hidden";
  doc.fire("visibilitychange");
  expect(shown).toEqual([true, false, true]);
  // A hidden page at the start reads hidden.
  const hidden: boolean[] = [];
  followDocumentVisibility(
    { ...target(), visibilityState: "hidden" },
    (value) => hidden.push(value),
  );
  expect(hidden).toEqual([false]);
});

test("the window's focus is read at once with hasFocus, and follows every focus and blur of the window", () => {
  const win = target();
  let focused = false;
  const doc = { hasFocus: () => focused };
  const seen: boolean[] = [];
  const stop = followWindowFocus(win, doc, (value) => seen.push(value));
  expect(seen).toEqual([false]);
  win.fire("focus");
  win.fire("blur");
  win.fire("focus");
  expect(seen).toEqual([false, true, false, true]);
  expect([...win.listeners.keys()].sort()).toEqual(["blur", "focus"]);
  stop();
  expect(win.count()).toBe(0);
  win.fire("blur");
  expect(seen).toEqual([false, true, false, true]);
  focused = true;
  const again: boolean[] = [];
  followWindowFocus(target(), doc, (value) => again.push(value));
  expect(again).toEqual([true]);
});

/** A fake observer factory that records what it was asked to do. */
function observers() {
  const made: {
    readonly callback: (entries: readonly RowEntry[]) => void;
    readonly threshold: readonly number[];
    readonly calls: string[];
  }[] = [];
  const create: RowObserverFactory = (callback, options) => {
    const calls: string[] = [];
    made.push({ callback, threshold: options.threshold, calls });
    const observer: RowObserver = {
      observe: (element) => calls.push(`observe ${String(element)}`),
      unobserve: (element) => calls.push(`unobserve ${String(element)}`),
      disconnect: () => calls.push("disconnect"),
    };
    return observer;
  };
  return { made, create };
}

/** A fake row element, named for the observer's records. */
function row(name: string): Element {
  return { toString: () => name } as unknown as Element;
}

function entry(
  element: Element,
  intersectionRatio: number,
  isIntersecting = intersectionRatio > 0,
): RowEntry {
  return { target: element, intersectionRatio, isIntersecting };
}

test("a row is in view only while most of it is: three quarters of it intersect the visible area", () => {
  const { made, create } = observers();
  const views: string[][] = [];
  const rows = followRowsInView(create, (ids) => views.push([...ids].sort()));
  // No observer before the first row.
  expect(made).toHaveLength(0);
  const ada = row("ada");
  const linus = row("linus");
  rows.refFor(ADA)(ada);
  rows.refFor(LINUS)(linus);
  expect(made).toHaveLength(1);
  expect(made[0]?.threshold).toEqual([ROW_IN_VIEW_RATIO]);
  expect(ROW_IN_VIEW_RATIO).toBe(0.75);
  expect(made[0]?.calls).toEqual(["observe ada", "observe linus"]);
  const report = made[0]!.callback;
  report([entry(ada, 0.5), entry(linus, 0.74)]);
  expect(views).toEqual([]);
  report([entry(ada, 0.75)]);
  expect(views).toEqual([[ADA]]);
  report([entry(linus, 1)]);
  expect(views).toEqual([[ADA], [ADA, LINUS].sort()]);
  // A row that scrolls partly or wholly out of view leaves it.
  report([entry(ada, 0.6)]);
  report([entry(linus, 0.9, false)]);
  expect(views.slice(2)).toEqual([[LINUS], []]);
  // A report without a change, or about an element that is not a row, says nothing.
  report([entry(ada, 0.1), entry(row("other"), 1)]);
  expect(views).toHaveLength(4);
});

test("a row's ref callback is the same for the same claim, and a row that leaves the page leaves the view at once", () => {
  const { made, create } = observers();
  const views: string[][] = [];
  const rows = followRowsInView(create, (ids) => views.push([...ids]));
  expect(rows.refFor(ADA)).toBe(rows.refFor(ADA));
  expect(rows.refFor(ADA)).not.toBe(rows.refFor(LINUS));
  const ada = row("ada");
  rows.refFor(ADA)(ada);
  made[0]!.callback([entry(ada, 1)]);
  expect(views).toEqual([[ADA]]);
  rows.refFor(ADA)(null);
  expect(views).toEqual([[ADA], []]);
  expect(made[0]?.calls).toEqual(["observe ada", "unobserve ada"]);
  // A late report about the element that left counts no more.
  made[0]!.callback([entry(ada, 1)]);
  expect(views).toHaveLength(2);
  // Another element for the same claim replaces the first.
  const first = row("first");
  const second = row("second");
  rows.refFor(ADA)(first);
  rows.refFor(ADA)(second);
  expect(made[0]?.calls.slice(2)).toEqual([
    "observe first",
    "unobserve first",
    "observe second",
  ]);
});

test("stopping disconnects the observer and takes every row out of view; a later row gets a new observer", () => {
  const { made, create } = observers();
  const views: string[][] = [];
  const rows = followRowsInView(create, (ids) => views.push([...ids]));
  const ada = row("ada");
  rows.refFor(ADA)(ada);
  made[0]!.callback([entry(ada, 1)]);
  rows.stop();
  expect(made[0]?.calls).toEqual(["observe ada", "disconnect"]);
  expect(views).toEqual([[ADA], []]);
  // The stopped observer's late report counts no more.
  made[0]!.callback([entry(ada, 1)]);
  expect(views).toHaveLength(2);
  rows.refFor(ADA)(ada);
  expect(made).toHaveLength(2);
  expect(made[1]?.calls).toEqual(["observe ada"]);
});

test("without an observer, no row is ever in view", () => {
  const views: string[][] = [];
  let asked = 0;
  const rows = followRowsInView(
    () => {
      asked += 1;
      return undefined;
    },
    (ids) => views.push([...ids]),
  );
  rows.refFor(ADA)(row("ada"));
  rows.refFor(LINUS)(row("linus"));
  rows.refFor(ADA)(null);
  expect(asked).toBe(1);
  expect(views).toEqual([]);
});
