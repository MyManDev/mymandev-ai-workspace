// Joining a workspace. It shows placeholder content only: the invitation
// code, the join request, and the pending requests come with #95.

export function JoinScreen() {
  return (
    <section aria-labelledby="join-title">
      <h2 id="join-title">Join a workspace</h2>
      <p>Joining is not available yet.</p>
      <p className="placeholder-note">
        Here you will paste an invitation code that a workspace sent you, or ask
        to join a workspace by its ID. Your own join requests appear here while
        they wait, and you can withdraw them.
      </p>
    </section>
  );
}
