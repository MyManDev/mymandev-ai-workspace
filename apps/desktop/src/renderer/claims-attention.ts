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
 * The part of a row that must be in view for the row to count as shown:
 * three quarters, so that a row cut off at the edge of the screen does not
 * count. A row taller than the visible area never reaches it and stays new.
 */
export const ROW_IN_VIEW_RATIO = 0.75;

/** What the row observer reports of one row, as `IntersectionObserverEntry` does. */
export interface RowEntry {
  readonly target: Element;
  readonly isIntersecting: boolean;
  readonly intersectionRatio: number;
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
 * `onInView` with the member IDs of the rows in view whenever they change:
 * a row is in view while it intersects the visible area by at least
 * `ROW_IN_VIEW_RATIO`. The observer is made at the first row, so nothing
 * observes before a row is on the page; a row that leaves the page leaves
 * the view at once. Without an observer, no row is ever in view.
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
      if (
        entry.isIntersecting &&
        entry.intersectionRatio >= ROW_IN_VIEW_RATIO
      ) {
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
      observer = create(observed, { threshold: [ROW_IN_VIEW_RATIO] });
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
