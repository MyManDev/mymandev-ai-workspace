// What the person can see of the recent claims: the page's visibility, the
// window's focus, and the rows in view, each followed through fakes of the
// document, the window, and the observer (the Project Manager's decision of
// 2026-11-13 on #273). No DOM is used.
import { afterEach, expect, test, vi } from "vitest";
import {
  followDocumentVisibility,
  followPageAttention,
  followRowsInView,
  followWindowFocus,
  isRowInView,
  NO_PAGE_ATTENTION,
  pageRowObserver,
  ROW_IN_VIEW_RATIO,
  ROW_THRESHOLDS,
  type PageAttention,
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

test("the page's attention is read once with both readings, and each change keeps the other reading: a blur keeps the visibility, and a hidden page keeps the focus", () => {
  const win = target();
  const doc = {
    ...target(),
    visibilityState: "visible",
    focused: true,
    hasFocus() {
      return this.focused;
    },
  };
  const seen: PageAttention[] = [];
  const stop = followPageAttention(win, doc, (attention) =>
    seen.push(attention),
  );
  expect(seen).toEqual([{ documentShown: true, windowFocused: true }]);
  win.fire("blur");
  expect(seen.at(-1)).toEqual({ documentShown: true, windowFocused: false });
  win.fire("focus");
  expect(seen.at(-1)).toEqual({ documentShown: true, windowFocused: true });
  doc.visibilityState = "hidden";
  doc.fire("visibilitychange");
  expect(seen.at(-1)).toEqual({ documentShown: false, windowFocused: true });
  win.fire("blur");
  expect(seen.at(-1)).toEqual({ documentShown: false, windowFocused: false });
  doc.visibilityState = "visible";
  doc.fire("visibilitychange");
  expect(seen.at(-1)).toEqual({ documentShown: true, windowFocused: false });
  win.fire("focus");
  expect(seen.at(-1)).toEqual({ documentShown: true, windowFocused: true });
  expect(seen).toHaveLength(7);
  stop();
  expect(win.count()).toBe(0);
  expect(doc.count()).toBe(0);
  win.fire("blur");
  doc.fire("visibilitychange");
  expect(seen).toHaveLength(7);
  // The first readings as they are: a hidden page without the focus.
  const first: PageAttention[] = [];
  followPageAttention(
    target(),
    { ...target(), visibilityState: "hidden", hasFocus: () => false },
    (attention) => first.push(attention),
  );
  expect(first).toEqual([{ documentShown: false, windowFocused: false }]);
  const focusedHidden: PageAttention[] = [];
  followPageAttention(
    target(),
    { ...target(), visibilityState: "hidden", hasFocus: () => true },
    (attention) => focusedHidden.push(attention),
  );
  expect(focusedHidden).toEqual([
    { documentShown: false, windowFocused: true },
  ]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test("the page's observer is an IntersectionObserver with the rows' thresholds that passes its entries on, and there is none without one", () => {
  const made: { callback: (entries: unknown[]) => void; options: unknown }[] =
    [];
  class PageObserver {
    constructor(callback: (entries: unknown[]) => void, options: unknown) {
      made.push({ callback, options });
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("IntersectionObserver", PageObserver);
  const received: (readonly RowEntry[])[] = [];
  const observer = pageRowObserver((entries) => received.push(entries), {
    threshold: ROW_THRESHOLDS,
  });
  expect(observer).toBeInstanceOf(PageObserver);
  expect(made).toHaveLength(1);
  expect(made[0]?.options).toEqual({ threshold: [...ROW_THRESHOLDS] });
  const entries = [entry(row("ada"), 1)];
  made[0]?.callback(entries);
  expect(received).toEqual([entries]);
  vi.stubGlobal("IntersectionObserver", undefined);
  expect(
    pageRowObserver(() => undefined, { threshold: ROW_THRESHOLDS }),
  ).toBeUndefined();
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

/** The visible area of the entries: 600 pixels high, as a small window shows it. */
const ROOT = { width: 800, height: 600 };

/**
 * An entry for a row 40 pixels high, shorter than the visible area, with
 * `intersectionRatio` of its height in view.
 */
function entry(
  element: Element,
  intersectionRatio: number,
  isIntersecting = intersectionRatio > 0,
): RowEntry {
  return {
    target: element,
    intersectionRatio,
    isIntersecting,
    boundingClientRect: { width: 500, height: 40 },
    intersectionRect: { width: 500, height: 40 * intersectionRatio },
    rootBounds: ROOT,
  };
}

/**
 * An entry for a row `height` pixels high and 500 wide, with `visible`
 * pixels of its height and `visibleWidth` of its width in view, against
 * `root`; the ratio is the visible part's share of the row's area.
 */
function tallEntry(
  element: Element,
  height: number,
  visible: number,
  {
    visibleWidth = 500,
    root = ROOT,
  }: {
    readonly visibleWidth?: number;
    readonly root?: { readonly width: number; readonly height: number } | null;
  } = {},
): RowEntry {
  return {
    target: element,
    intersectionRatio: (visible * visibleWidth) / (height * 500),
    isIntersecting: visible > 0 && visibleWidth > 0,
    boundingClientRect: { width: 500, height },
    intersectionRect: { width: visibleWidth, height: visible },
    rootBounds: root,
  };
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
  expect(made[0]?.threshold).toBe(ROW_THRESHOLDS);
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

test("the rows' observer reports every twentieth of a row, among them the three quarters", () => {
  expect(ROW_THRESHOLDS).toEqual([
    0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65,
    0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1,
  ]);
  expect(ROW_THRESHOLDS).toContain(ROW_IN_VIEW_RATIO);
  expect(Object.isFrozen(ROW_THRESHOLDS)).toBe(true);
  // A row five times the visible area's height fills three quarters of it
  // from a fifth of itself times three quarters, 0.15, up to a fifth, 0.2:
  // a threshold lies in between, so the observer reports it on its way.
  const five = { low: 0.75 / 5, high: 1 / 5 };
  expect(
    ROW_THRESHOLDS.some((value) => value >= five.low && value <= five.high),
  ).toBe(true);
});

test("a row shorter than the visible area still needs three quarters of itself in view", () => {
  const ada = row("ada");
  expect(isRowInView(entry(ada, 0.75))).toBe(true);
  expect(isRowInView(entry(ada, 1))).toBe(true);
  expect(isRowInView(entry(ada, 0.74))).toBe(false);
  expect(isRowInView(entry(ada, 0.9, false))).toBe(false);
  // A row as high as the visible area: three quarters of itself, of 600.
  expect(isRowInView(tallEntry(ada, 600, 450))).toBe(true);
  expect(isRowInView(tallEntry(ada, 600, 449))).toBe(false);
  // A row almost as high, three quarters of the visible area in view but
  // less than three quarters of itself, cut off at a side.
  expect(isRowInView(tallEntry(ada, 590, 450, { visibleWidth: 480 }))).toBe(
    false,
  );
});

test("a row taller than the visible area is in view while its visible part fills three quarters of the visible area's height", () => {
  const ada = row("ada");
  // Twice the visible area: three quarters of it in view is 450 pixels,
  // only 0.375 of the row.
  expect(isRowInView(tallEntry(ada, 1200, 450))).toBe(true);
  expect(isRowInView(tallEntry(ada, 1200, 449))).toBe(false);
  expect(isRowInView(tallEntry(ada, 1200, 300))).toBe(false);
  // Past both the top and the bottom edge, the row fills the visible area.
  expect(isRowInView(tallEntry(ada, 1200, 600))).toBe(true);
  expect(isRowInView(tallEntry(ada, 6000, 600))).toBe(true);
  // A fraction of a pixel above the visible area's height is taller.
  expect(isRowInView(tallEntry(ada, 600.5, 450))).toBe(true);
  // Cut off at a side, the row needs three quarters of its width in view.
  expect(isRowInView(tallEntry(ada, 1200, 600, { visibleWidth: 375 }))).toBe(
    true,
  );
  expect(isRowInView(tallEntry(ada, 1200, 600, { visibleWidth: 374 }))).toBe(
    false,
  );
  // Not intersecting, it never counts.
  expect(
    isRowInView({ ...tallEntry(ada, 1200, 600), isIntersecting: false }),
  ).toBe(false);
});

test("without the visible area's bounds, or with a visible area of no height, a tall row never fills it", () => {
  const ada = row("ada");
  expect(isRowInView(tallEntry(ada, 1200, 600, { root: null }))).toBe(false);
  expect(isRowInView(tallEntry(ada, 1200, 1000, { root: null }))).toBe(true);
  expect(
    isRowInView(tallEntry(ada, 1200, 0.5, { root: { width: 800, height: 0 } })),
  ).toBe(false);
  expect(
    isRowInView({
      ...tallEntry(ada, 1200, 0, { root: { width: 800, height: 0 } }),
      isIntersecting: true,
    }),
  ).toBe(false);
  // A row of no width is never wide enough.
  expect(
    isRowInView({
      ...tallEntry(ada, 1200, 600),
      boundingClientRect: { width: 0, height: 1200 },
      intersectionRect: { width: 0, height: 600 },
    }),
  ).toBe(false);
});

test("the rows' observer follows a tall row into and out of view as it fills the visible area", () => {
  const { made, create } = observers();
  const views: string[][] = [];
  const rows = followRowsInView(create, (ids) => views.push([...ids].sort()));
  const ada = row("ada");
  const linus = row("linus");
  rows.refFor(ADA)(ada);
  rows.refFor(LINUS)(linus);
  const report = made[0]!.callback;
  report([tallEntry(ada, 1800, 300), entry(linus, 0.5)]);
  expect(views).toEqual([]);
  report([tallEntry(ada, 1800, 450)]);
  expect(views).toEqual([[ADA]]);
  report([tallEntry(ada, 1800, 600), entry(linus, 1)]);
  expect(views).toEqual([[ADA], [ADA, LINUS].sort()]);
  report([tallEntry(ada, 1800, 400)]);
  expect(views.at(-1)).toEqual([LINUS]);
  report([tallEntry(ada, 1800, 600, { root: null })]);
  expect(views).toHaveLength(3);
});
