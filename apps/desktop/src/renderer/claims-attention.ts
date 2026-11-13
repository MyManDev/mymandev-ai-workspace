// What the person can see of the recent claims (#95, D8, and the Project
// Manager's decision of 2026-11-13 on #273): whether the window shows the
// page, whether it has the focus, and which claims' rows are in view. The
// screen reports a claim as seen only while all of it holds; when in doubt,
// a claim stays new. Each function takes the window, the document, or the
// observer's factory as an argument, so that the tests pass fakes.

/** Whether the window shows the page and has the focus. */
export interface PageAttention {
  /** The document is not hidden: the window is not minimized or hidden. */
  readonly documentShown: boolean;
  /** The application's window has the focus. */
  readonly windowFocused: boolean;
}

/**
 * The attention before the first reading after the render: neither, so
 * that nothing counts as seen before the screen read them.
 */
export const NO_PAGE_ATTENTION: PageAttention = Object.freeze({
  documentShown: false,
  windowFocused: false,
});

/** What `followDocumentVisibility` uses of the document. */
export interface VisibilityDocument {
  readonly visibilityState: string;
  readonly addEventListener: (
    type: "visibilitychange",
    listener: () => void,
  ) => void;
  readonly removeEventListener: (
    type: "visibilitychange",
    listener: () => void,
  ) => void;
}

/**
 * Calls `onShown` at once and on every change of the document's visibility
 * with whether the window shows the page: false only while
 * `visibilityState` is "hidden", which on Windows and Linux means a
 * minimized or hidden window, not one behind other windows (the focus
 * covers that). Returns the function that stops it.
 */
export function followDocumentVisibility(
  doc: VisibilityDocument,
  onShown: (shown: boolean) => void,
): () => void {
  const read = () => onShown(doc.visibilityState !== "hidden");
  read();
  doc.addEventListener("visibilitychange", read);
  return () => doc.removeEventListener("visibilitychange", read);
}

/** What `followWindowFocus` uses of the window. */
export interface FocusWindow {
  readonly addEventListener: (
    type: "focus" | "blur",
    listener: () => void,
  ) => void;
  readonly removeEventListener: (
    type: "focus" | "blur",
    listener: () => void,
  ) => void;
}

/** What `followWindowFocus` uses of the document. */
export interface FocusDocument {
  readonly hasFocus: () => boolean;
}

/**
 * Calls `onFocused` at once with `document.hasFocus()`, and then on every
 * focus and blur of the window: true when the window gets the focus, false
 * when it loses it, for example to another application. A blur or a focus
 * of an element inside the page does not reach the window's own listeners,
 * because neither event bubbles. Returns the function that stops it.
 */
export function followWindowFocus(
  win: FocusWindow,
  doc: FocusDocument,
  onFocused: (focused: boolean) => void,
): () => void {
  const focus = () => onFocused(true);
  const blur = () => onFocused(false);
  onFocused(doc.hasFocus());
  win.addEventListener("focus", focus);
  win.addEventListener("blur", blur);
  return () => {
    win.removeEventListener("focus", focus);
    win.removeEventListener("blur", blur);
  };
}

/**
 * Calls `onAttention` once with both first readings, the document's
 * visibility (`followDocumentVisibility`) and the window's focus
 * (`followWindowFocus`), and then with the whole attention on every change
 * of either: a change of the visibility keeps the focus as it was last
 * read, and a focus or a blur keeps the visibility. Returns the function
 * that stops both.
 */
export function followPageAttention(
  win: FocusWindow,
  doc: VisibilityDocument & FocusDocument,
  onAttention: (attention: PageAttention) => void,
): () => void {
  let attention = NO_PAGE_ATTENTION;
  let started = false;
  const change = (next: PageAttention) => {
    attention = Object.freeze(next);
    if (started) {
      onAttention(attention);
    }
  };
  const stopVisibility = followDocumentVisibility(doc, (documentShown) =>
    change({ ...attention, documentShown }),
  );
  const stopFocus = followWindowFocus(win, doc, (windowFocused) =>
    change({ ...attention, windowFocused }),
  );
  started = true;
  onAttention(attention);
  return () => {
    stopVisibility();
    stopFocus();
  };
}

/**
 * The part of a row that must be in view for the row to count as shown:
 * three quarters, so that a row cut off at the edge of the screen does not
 * count. A row taller than the visible area can never reach it, for example
 * at a high page zoom; such a row counts instead while its visible part
 * fills three quarters of the visible area's height and three quarters of
 * the row's own width (`isRowInView`, #276).
 */
export const ROW_IN_VIEW_RATIO = 0.75;

/**
 * The thresholds of the rows' observer: every twentieth from 0 to 1, 21 in
 * all, with `ROW_IN_VIEW_RATIO` among them, so that a row that is not taller
 * than the visible area is reported exactly when it crosses three quarters.
 * A row taller than the visible area counts at a part of itself that
 * depends on its height, which no fixed threshold matches; the observer
 * reports such a row at each twentieth of it in view. A row up to five
 * times the visible area's height that comes to fill the visible area is
 * then reported at least once on its way while it fills three quarters of
 * it, and a row that stops filling it leaves the view at the latest once
 * another twentieth of it has left the view. A taller row, or one that
 * stops before it fills the visible area, may stay new until a later
 * report. A finer list would report more often during a scroll for little
 * gain; the observer reports at most once per frame.
 */
export const ROW_THRESHOLDS: readonly number[] = Object.freeze(
  Array.from({ length: 21 }, (_, index) => index / 20),
);

/** The size of a box, as a `DOMRectReadOnly` gives it. */
export interface RowBox {
  readonly width: number;
  readonly height: number;
}

/** What the row observer reports of one row, as `IntersectionObserverEntry` does. */
export interface RowEntry {
  readonly target: Element;
  readonly isIntersecting: boolean;
  readonly intersectionRatio: number;
  /** The row's whole box. */
  readonly boundingClientRect: RowBox;
  /** The row's visible part, clipped by the visible area and every scrolling ancestor. */
  readonly intersectionRect: RowBox;
  /** The visible area, or null when the page may not know it, for example across origins. */
  readonly rootBounds: RowBox | null;
}

/**
 * Whether the row of an observer's entry is in view. Any row is while it
 * intersects the visible area by at least `ROW_IN_VIEW_RATIO` of itself. A
 * row taller than the visible area also is while its visible part is at
 * least `ROW_IN_VIEW_RATIO` of the visible area's height and of the row's
 * own width, also when it runs past both the top and the bottom edge, so
 * that a row cut off at a side does not count. Without the visible area's
 * bounds, or with a visible area of no height, only the first rule applies.
 */
export function isRowInView(entry: RowEntry): boolean {
  if (!entry.isIntersecting) {
    return false;
  }
  if (entry.intersectionRatio >= ROW_IN_VIEW_RATIO) {
    return true;
  }
  const root = entry.rootBounds;
  const row = entry.boundingClientRect;
  const visible = entry.intersectionRect;
  return (
    root !== null &&
    root.height > 0 &&
    row.height > root.height &&
    visible.height >= ROW_IN_VIEW_RATIO * root.height &&
    row.width > 0 &&
    visible.width >= ROW_IN_VIEW_RATIO * row.width
  );
}

/** What `followRowsInView` uses of an observer, as `IntersectionObserver` offers it. */
export interface RowObserver {
  readonly observe: (target: Element) => void;
  readonly unobserve: (target: Element) => void;
  readonly disconnect: () => void;
}

/**
 * Makes the observer of the rows with its callback and its thresholds, or
 * returns undefined when the page has none, so that no row is ever in view.
 */
export type RowObserverFactory = (
  callback: (entries: readonly RowEntry[]) => void,
  options: { readonly threshold: readonly number[] },
) => RowObserver | undefined;

/**
 * The page's own `IntersectionObserver`, against the viewport, which also
 * clips by every scrolling ancestor; undefined without one.
 */
export const pageRowObserver: RowObserverFactory = (callback, options) =>
  typeof IntersectionObserver === "undefined"
    ? undefined
    : new IntersectionObserver((entries) => callback(entries), {
        threshold: [...options.threshold],
      });

/** The rows that `followRowsInView` follows. */
export interface RowsInView {
  /**
   * The ref callback of the row of the claim with `memberId`: the same
   * function for the same claim on every render, so that React attaches it
   * once. It observes the row's element, and a null element, when the row
   * leaves the page, ends it and takes the row out of view.
   */
  readonly refFor: (memberId: string) => (element: Element | null) => void;
  /**
   * Stops observing every row and takes them all out of view. A later
   * ref call observes again with a new observer.
   */
  readonly stop: () => void;
}

/**
 * Follows the claims' rows with one observer from `create`, and calls
 * `onInView` with the member IDs of the rows in view whenever they change,
 * as `isRowInView` reads each entry, with the thresholds `ROW_THRESHOLDS`.
 * The observer is made at the first row, so nothing observes before a row
 * is on the page; a row that leaves the page leaves the view at once.
 * Without an observer, no row is ever in view.
 */
export function followRowsInView(
  create: RowObserverFactory,
  onInView: (memberIds: ReadonlySet<string>) => void,
): RowsInView {
  let observer: RowObserver | undefined;
  let made = false;
  const elements = new Map<string, Element>();
  const owners = new Map<Element, string>();
  const refs = new Map<string, (element: Element | null) => void>();
  let inView: ReadonlySet<string> = new Set<string>();

  function publish(next: Set<string>): void {
    const same =
      next.size === inView.size &&
      [...next].every((memberId) => inView.has(memberId));
    if (!same) {
      inView = next;
      onInView(next);
    }
  }

  function observed(entries: readonly RowEntry[]): void {
    const next = new Set(inView);
    for (const entry of entries) {
      const memberId = owners.get(entry.target);
      if (memberId === undefined) {
        continue;
      }
      if (isRowInView(entry)) {
        next.add(memberId);
      } else {
        next.delete(memberId);
      }
    }
    publish(next);
  }

  function release(memberId: string): void {
    const element = elements.get(memberId);
    if (element !== undefined) {
      observer?.unobserve(element);
      owners.delete(element);
      elements.delete(memberId);
    }
  }

  function attach(memberId: string, element: Element | null): void {
    release(memberId);
    if (element === null) {
      const next = new Set(inView);
      next.delete(memberId);
      publish(next);
      return;
    }
    if (!made) {
      made = true;
      observer = create(observed, { threshold: ROW_THRESHOLDS });
    }
    if (observer === undefined) {
      return;
    }
    elements.set(memberId, element);
    owners.set(element, memberId);
    observer.observe(element);
  }

  return Object.freeze({
    refFor: (memberId: string) => {
      let ref = refs.get(memberId);
      if (ref === undefined) {
        ref = (element: Element | null) => attach(memberId, element);
        refs.set(memberId, ref);
      }
      return ref;
    },
    stop: () => {
      observer?.disconnect();
      observer = undefined;
      made = false;
      elements.clear();
      owners.clear();
      publish(new Set());
    },
  });
}
