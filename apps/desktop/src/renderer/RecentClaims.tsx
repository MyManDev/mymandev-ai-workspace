import { useEffect, useMemo, useState } from "react";
import type { ClaimsBridge } from "../shared/desktop-bridge.ts";
import type { ClaimsView } from "../shared/ipc-contract.ts";
import {
  CLAIM_MESSAGES,
  CLAIM_VIA_MESSAGES,
  createRecentClaims,
  describeRecentClaims,
  followClaims,
  IDLE_RECENT_CLAIMS,
  initialClaimsScreenView,
  shownClaims,
  type ClaimRow,
  type ClaimsScreenView,
  type RecentClaimsModel,
  type RecentClaimsView,
} from "./claims-view.ts";
import {
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

/** What the people screen does on its recent claims; undefined without the bridge. */
export interface RecentClaimHandlers {
  /** Asks the main process to load the claims again. */
  readonly onRefresh: () => void;
}

/**
 * A button of the recent claims. While an action runs it stays focusable
 * and does nothing (`aria-disabled`), like the people actions' buttons.
 */
function ActionButton({
  label,
  inert,
  onClick,
}: {
  readonly label: string;
  readonly inert: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="panel-action"
      aria-disabled={inert ? "true" : undefined}
      onClick={inert ? undefined : () => onClick()}
    >
      {label}
    </button>
  );
}

/** A time of the claims in `format`. A timestamp that is not a date stays as it is. */
function formatTime(timestamp: string, format: Intl.DateTimeFormat): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? timestamp : format.format(date);
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
 * claim's place in the list, never an ID.
 */
export function RecentClaimsPart({
  model,
  dateFormat,
  timeFormat,
  inert,
  onStart,
  onRefresh,
}: {
  readonly model: RecentClaimsModel;
  readonly dateFormat: Intl.DateTimeFormat;
  readonly timeFormat: Intl.DateTimeFormat;
  readonly inert: boolean;
  /** The people actions' start, for "Remove"; undefined without them. */
  readonly onStart: PeopleActionHandlers["onStart"] | undefined;
  readonly onRefresh: () => void;
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
            />
          ))}
        </ul>
      )}
      <div className="account-actions">
        <ActionButton
          label={CLAIM_MESSAGES.refresh}
          inert={inert}
          onClick={onRefresh}
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
}: {
  readonly row: ClaimRow;
  /** The ID of the name, by the claim's place in the list, for "Remove". */
  readonly nameId: string;
  readonly dateFormat: Intl.DateTimeFormat;
  readonly timeFormat: Intl.DateTimeFormat;
  readonly inert: boolean;
  readonly onStart: PeopleActionHandlers["onStart"] | undefined;
}) {
  const remove = onStart === undefined ? null : row.remove;
  return (
    <li className="person">
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
          {formatTime(row.claimedAt, timeFormat)}
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

/** What `isDocumentShown` reads of the document. */
export interface DocumentVisibility {
  readonly visibilityState: string;
}

/**
 * Whether the window shows the page: not while it is minimized or hidden
 * (`document.visibilityState` is "hidden"), so that a claim that arrives
 * meanwhile is not reported as shown.
 */
export function isDocumentShown(doc: DocumentVisibility): boolean {
  return doc.visibilityState !== "hidden";
}

/**
 * Whether the window shows the page, read again whenever its visibility
 * changes. False until the first reading after the render, so that nothing
 * counts as shown before it.
 */
function useDocumentShown(): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const read = () => setShown(isDocumentShown(document));
    read();
    document.addEventListener("visibilitychange", read);
    return () => document.removeEventListener("visibilitychange", read);
  }, []);
  return shown;
}

/**
 * The recent claims of the screen (`createRecentClaims`) while it is shown,
 * which follow every view of the people and the claims; undefined handlers
 * without the bridge, with no section.
 *
 * After each render, the claims that the section rendered and the latest
 * state marks unseen are reported as shown (`shownClaims`), only while the
 * section is visible: the people screen is open, the section is rendered
 * with its rows, `covered` (a modal dialog of the screen or the shell is
 * open) does not hold, and the window is not hidden. The rows are the same
 * as the section's, from the same views (`describeRecentClaims`).
 */
export function useRecentClaims(
  bridge: ClaimsBridge | undefined,
  people: PeopleScreenView,
  claims: ClaimsScreenView,
  covered: boolean,
): {
  readonly view: RecentClaimsView;
  readonly handlers: RecentClaimHandlers | undefined;
} {
  const [view, setView] = useState(IDLE_RECENT_CLAIMS);
  const controller = useMemo(
    () =>
      bridge === undefined ? undefined : createRecentClaims(bridge, setView),
    [bridge],
  );
  useEffect(
    () => controller?.listChanged(people, claims),
    [controller, people, claims],
  );
  const documentShown = useDocumentShown();
  const report =
    controller === undefined
      ? null
      : shownClaims(
          describeRecentClaims(people, claims, view.marked),
          documentShown && !covered,
        );
  // A report changes only with its scope and its claims: the effect runs
  // with the render's report whenever either changes.
  const key =
    report === null ? "" : `${report.scope} ${report.memberIds.join(" ")}`;
  useEffect(() => controller?.shown(report), [controller, key]);
  const handlers = useMemo(
    (): RecentClaimHandlers | undefined =>
      controller === undefined
        ? undefined
        : {
            onRefresh: () => {
              void controller.refresh();
            },
          },
    [controller],
  );
  return { view, handlers };
}
