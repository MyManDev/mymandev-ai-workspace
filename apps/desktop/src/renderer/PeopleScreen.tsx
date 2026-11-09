import { useEffect, useState } from "react";
import type { PeopleBridge } from "../shared/desktop-bridge.ts";
import {
  describeMorePeople,
  describePeopleScreen,
  followPeople,
  formatPeopleDate,
  initialPeopleScreenView,
  PEOPLE_MESSAGES,
  peopleDateFormat,
  type PeopleScreenView,
  type PersonRow,
} from "./people-view.ts";

/**
 * The people of the selected workspace, read-only (#95, decision D3): the
 * active people with their roles and GitHub logins, the account's own
 * person marked, and the former members apart. The main process keeps them
 * current with the membership events. The actions follow in later work.
 */
export function PeopleScreen({
  people,
}: {
  /** The people functions from the preload script; undefined outside Electron. */
  readonly people: PeopleBridge | undefined;
}) {
  return <PeopleScreenContent view={usePeopleScreen(people)} />;
}

export interface PeopleScreenContentProps {
  readonly view: PeopleScreenView;
  /**
   * The format of the dates, for tests. By default, a new
   * `peopleDateFormat` for each render, in the person's locale and the
   * system's time zone.
   */
  readonly dateFormat?: Intl.DateTimeFormat | undefined;
}

/**
 * The screen for a view, without state. The status paragraph is always
 * rendered, empty when there is nothing to say, so that a screen reader
 * announces a new text. Display names are text that people entered, so
 * each one takes its direction from its own content (`dir="auto"`); a
 * GitHub login is shown in a monospace font, so that a display name cannot
 * pass for it (ADR 0014, "People and roles").
 */
export function PeopleScreenContent({
  view,
  dateFormat,
}: PeopleScreenContentProps) {
  const { status, lists, adminHint } = describePeopleScreen(view);
  const format = dateFormat ?? peopleDateFormat();
  return (
    <section aria-labelledby="people-title">
      <h2 id="people-title">People</h2>
      <p className="people-status" role="status">
        {status}
      </p>
      {adminHint ? (
        <p className="people-hint">{PEOPLE_MESSAGES.adminHint}</p>
      ) : null}
      {lists === null ? null : (
        <>
          <PersonList
            people={lists.active}
            labelledBy="people-title"
            format={format}
          />
          {lists.morePeople === 0 ? null : (
            <p className="people-note">
              {describeMorePeople(lists.morePeople)}
            </p>
          )}
          {lists.former.length === 0 ? null : (
            <>
              <h3 className="people-heading" id="former-people-heading">
                Former members
              </h3>
              <PersonList
                people={lists.former}
                labelledBy="former-people-heading"
                format={format}
              />
            </>
          )}
        </>
      )}
      <p className="placeholder-note">{PEOPLE_MESSAGES.actionsLater}</p>
    </section>
  );
}

function PersonList({
  people,
  labelledBy,
  format,
}: {
  readonly people: readonly PersonRow[];
  readonly labelledBy: string;
  readonly format: Intl.DateTimeFormat;
}) {
  if (people.length === 0) {
    return null;
  }
  return (
    <ul className="people-list" aria-labelledby={labelledBy}>
      {people.map((person) => (
        <PersonItem key={person.memberId} person={person} format={format} />
      ))}
    </ul>
  );
}

function PersonItem({
  person,
  format,
}: {
  readonly person: PersonRow;
  readonly format: Intl.DateTimeFormat;
}) {
  const { github } = person;
  return (
    <li className="person">
      <p className="person-name">
        <span dir="auto">{person.displayName}</span>
        {person.you ? (
          <span className="person-you">{` ${PEOPLE_MESSAGES.you}`}</span>
        ) : null}
      </p>
      {person.role === null ? null : (
        <p className="person-meta">{person.role}</p>
      )}
      {github === null ? (
        <p className="person-meta">{person.note}</p>
      ) : (
        <p className="person-meta">
          {"GitHub "}
          <span className="person-login" translate="no">
            {github.login}
          </span>
          {", last verified "}
          <time dateTime={github.verifiedAt}>
            {formatPeopleDate(github.verifiedAt, format)}
          </time>
        </p>
      )}
    </li>
  );
}

/** Follows the people while the screen is shown. */
function usePeopleScreen(bridge: PeopleBridge | undefined): PeopleScreenView {
  const [view, setView] = useState(() =>
    initialPeopleScreenView(bridge !== undefined),
  );
  useEffect(
    () => (bridge === undefined ? undefined : followPeople(bridge, setView)),
    [bridge],
  );
  return view;
}
