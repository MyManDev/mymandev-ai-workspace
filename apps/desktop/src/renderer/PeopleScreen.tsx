// The people of the selected workspace. It shows placeholder content only:
// the people, their roles, invitations, and join requests come with #95.

export function PeopleScreen() {
  return (
    <section aria-labelledby="people-title">
      <h2 id="people-title">People</h2>
      <p>No people are shown yet.</p>
      <p className="placeholder-note">
        The people of the selected workspace will appear here, with their roles
        and their GitHub logins, also former members. The owner and the admins
        will invite people, answer join requests, and remove people here.
      </p>
    </section>
  );
}
