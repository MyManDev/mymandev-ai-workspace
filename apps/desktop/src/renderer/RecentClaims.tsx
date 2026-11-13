import { useEffect, useMemo, useState } from "react";
import type { ClaimsBridge } from "../shared/desktop-bridge.ts";
import type { ClaimsView } from "../shared/ipc-contract.ts";
import {
  followPageAttention,
  followRowsInView,
  NO_PAGE_ATTENTION,
  pageRowObserver,
  type PageAttention,
  type RowObserverFactory,
} from "./claims-attention.ts";
import {
  CLAIM_MESSAGES,
  CLAIM_VIA_MESSAGES,
  createRecentClaims,
  followClaims,
  IDLE_RECENT_CLAIMS,
  initialClaimsScreenView,
  type ClaimRow,
  type ClaimsScreenView,
  type RecentClaims,
  type RecentClaimsModel,
  type RecentClaimsView,
  type ShownClaims,
} from "./claims-view.ts";
import {
  ActionButton,
  PersonActionButtons,
  type PeopleActionHandlers,
} from "./PeopleActions.tsx";
import {
  formatPeopleDate,
  PEOPLE_MESSAGES,
  type PeopleScreenView,
} from "./people-view.ts";

/** The ID of the paragraph with the sentence of the last refresh of the recent claims. */
export const CLAIM_ACTION_MESSAGE_ID = "claim-action-message";

/** The ID of the heading of the recent claims. */
export const RECENT_CLAIMS_HEADING_ID = "recent-claims-heading";

/** The ref callback of a claim's row, by the claim's member ID. */
export type ClaimRowRef = (
  memberId: string,
) => (element: Element | null) => void;

/** What the people screen does on its recent claims; undefined without the bridge. */
export interface RecentClaimHandlers {
  /** Asks the main process to load the claims again. */
  readonly onRefresh: () => void;
  /** Follows each claim's row, to know which rows are in view. */
  readonly rowRef: ClaimRowRef;
}

/**
 * The recent claims, for the owner and the admins: a heading, a fixed hint,
 * a status paragraph that is always rendered, empty when there is nothing
 * to say, the claims, the most recent first, and "Refresh the recent
 * claims". Each claim shows the person's display name as text with
 * `dir="auto"` ("(you)" for the account's own person, "(former member)"
 * after a removal or a leave), "New" as text while it is new, the
 * claimer's GitHub login in the monospace font, never translated, with the
 * date it was last verified, the creation date of that GitHub account, and
 * how and when the person joined; dates are in `dateFormat`, times in
 * `timeFormat`, the people screen's shared formats. "Remove" is the people
 * actions' own button, described by the name, whose element ID is the
 * claim's place in the list, never an ID. Each row's element goes to
 * `rowRef`, which follows which rows are in view.
 */
export function RecentClaimsPart({
  model,
  dateFormat,
  timeFormat,
  inert,
  onStart,
  onRefresh,
  rowRef,
}: {
  readonly model: RecentClaimsModel;
  readonly dateFormat: Intl.DateTimeFormat;
  readonly timeFormat: Intl.DateTimeFormat;
  readonly inert: boolean;
  /** The people actions' start, for "Remove"; undefined without them. */
  readonly onStart: PeopleActionHandlers["onStart"] | undefined;
  readonly onRefresh: () => void;
  /** Follows each row's element; undefined follows none, so none is in view. */
  readonly rowRef?: ClaimRowRef | undefined;
}) {
  return (
    <section
      className="recent-claims"
      aria-labelledby={RECENT_CLAIMS_HEADING_ID}
    >
      <h3 className="people-heading" id={RECENT_CLAIMS_HEADING_ID}>
        {CLAIM_MESSAGES.heading}
      </h3>
      <p className="person-meta">{CLAIM_MESSAGES.hint}</p>
      <p className="people-status" role="status">
        {model.status}
      </p>
      {model.rows.length === 0 ? null : (
        <ul className="people-list" aria-labelledby={RECENT_CLAIMS_HEADING_ID}>
          {model.rows.map((row, index) => (
            <ClaimItem
              key={row.memberId}
              row={row}
              nameId={`${RECENT_CLAIMS_HEADING_ID}-claim-${String(index)}`}
              dateFormat={dateFormat}
              timeFormat={timeFormat}
              inert={inert}
              onStart={onStart}
              rowRef={rowRef?.(row.memberId)}
            />
          ))}
        </ul>
      )}
      <div className="account-actions">
        <ActionButton
          label={CLAIM_MESSAGES.refresh}
          describedBy={undefined}
          inert={inert}
          onClick={() => onRefresh()}
        />
      </div>
    </section>
  );
}

function ClaimItem({
  row,
  nameId,
  dateFormat,
  timeFormat,
  inert,
  onStart,
  rowRef,
}: {
  readonly row: ClaimRow;
  /** The ID of the name, by the claim's place in the list, for "Remove". */
  readonly nameId: string;
  readonly dateFormat: Intl.DateTimeFormat;
  readonly timeFormat: Intl.DateTimeFormat;
  readonly inert: boolean;
  readonly onStart: PeopleActionHandlers["onStart"] | undefined;
  /** The row's ref callback, the same function on every render. */
  readonly rowRef: ((element: Element | null) => void) | undefined;
}) {
  const remove = onStart === undefined ? null : row.remove;
  return (
    <li className="person" ref={rowRef}>
      <p className="person-name">
        {row.name === null ? (
          <span>{CLAIM_MESSAGES.unlisted}</span>
        ) : (
          <span dir="auto" id={remove === null ? undefined : nameId}>
            {row.name}
          </span>
        )}
        {row.you ? (
          <span className="person-you">{` ${PEOPLE_MESSAGES.you}`}</span>
        ) : null}
        {row.former ? (
          <span className="person-you">{` ${CLAIM_MESSAGES.former}`}</span>
        ) : null}
        {row.marked ? (
          <>
            {" "}
            <strong className="claim-new">{CLAIM_MESSAGES.new}</strong>
          </>
        ) : null}
      </p>
      {row.login === null ? (
        <p className="person-meta">{CLAIM_MESSAGES.noLogin}</p>
      ) : (
        <p className="person-meta">
          {CLAIM_MESSAGES.github}
          <span className="person-login" translate="no">
            {row.login}
          </span>
          {row.verifiedAt === null ? null : (
            <>
              {CLAIM_MESSAGES.verified}
              <time dateTime={row.verifiedAt}>
                {formatPeopleDate(row.verifiedAt, dateFormat)}
              </time>
            </>
          )}
        </p>
      )}
      {row.accountCreatedAt === null ? null : (
        <p className="person-meta">
          {CLAIM_MESSAGES.accountCreated}
          <time dateTime={row.accountCreatedAt}>
            {formatPeopleDate(row.accountCreatedAt, dateFormat)}
          </time>
        </p>
      )}
      <p className="person-meta">
        {`${CLAIM_VIA_MESSAGES[row.via]}${CLAIM_MESSAGES.on}`}
        <time dateTime={row.claimedAt}>
          {formatPeopleDate(row.claimedAt, timeFormat)}
        </time>
      </p>
      {remove === null || onStart === undefined ? null : (
        <PersonActionButtons
          requests={[remove]}
          describedBy={nameId}
          inert={inert}
          onStart={onStart}
        />
      )}
    </li>
  );
}

/**
 * Follows the recent claims while the component that uses it is shown,
 * starting with `initialState` when there is one, for tests and previews.
 */
export function useClaimsScreen(
  bridge: ClaimsBridge | undefined,
  initialState?: ClaimsView | undefined,
): ClaimsScreenView {
  const [view, setView] = useState((): ClaimsScreenView =>
    initialState === undefined
      ? initialClaimsScreenView(bridge !== undefined)
      : { kind: "known", state: initialState },
  );
  useEffect(
    () => (bridge === undefined ? undefined : followClaims(bridge, setView)),
    [bridge],
  );
  return view;
}

/**
 * Whether the window shows the page and has the focus
 * (`followPageAttention`), read again on every change of the document's
 * visibility and every focus and blur of the window. Neither until the
 * first reading after the render (`NO_PAGE_ATTENTION`), so that nothing
 * counts as seen before it.
 */
export function usePageAttention(): PageAttention {
  const [attention, setAttention] = useState(NO_PAGE_ATTENTION);
  useEffect(() => followPageAttention(window, document, setAttention), []);
  return attention;
}

/**
 * The recent claims of the screen (`createRecentClaims`) while it is
 * shown, with the rows in view (`followRowsInView`, with the observer from
 * `createObserver`) and the page's attention (`usePageAttention`);
 * undefined handlers and controller without the bridge, with no section.
 * The screen passes these into `claimsReport` and the result into
 * `useClaimsRendered`.
 */
export function useRecentClaims(
  bridge: ClaimsBridge | undefined,
  createObserver: RowObserverFactory = pageRowObserver,
): {
  readonly view: RecentClaimsView;
  readonly handlers: RecentClaimHandlers | undefined;
  readonly controller: RecentClaims | undefined;
  readonly attention: PageAttention;
  readonly rowsInView: ReadonlySet<string>;
} {
  const [view, setView] = useState(IDLE_RECENT_CLAIMS);
  const [rowsInView, setRowsInView] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const controller = useMemo(
    () =>
      bridge === undefined ? undefined : createRecentClaims(bridge, setView),
    [bridge],
  );
  // The observer is made at the first row, in the commit, never here.
  const rows = useMemo(
    () => followRowsInView(createObserver, setRowsInView),
    [createObserver],
  );
  useEffect(() => () => rows.stop(), [rows]);
  const attention = usePageAttention();
  const handlers = useMemo(
    (): RecentClaimHandlers | undefined =>
      controller === undefined
        ? undefined
        : {
            onRefresh: () => {
              void controller.refresh();
            },
            rowRef: rows.refFor,
          },
    [controller, rows],
  );
  return { view, handlers, controller, attention, rowsInView };
}

/**
 * After each render of the screen, one effect passes the views and the
 * render's report (`claimsReport`) to the controller (`rendered`), which
 * follows the views first and reports only a report whose key changed.
 */
export function useClaimsRendered(
  controller: RecentClaims | undefined,
  people: PeopleScreenView,
  claims: ClaimsScreenView,
  result: { readonly report: ShownClaims | null; readonly key: string },
): void {
  const { report, key } = result;
  useEffect(
    () => controller?.rendered(people, claims, report),
    // The report counts by its key; the controller compares it again.
    [controller, people, claims, key],
  );
}
