# Joining a workspace

You join a workspace on the "Join" screen. This device must be signed in first (see [Account and devices](account-and-devices.md)).

There are two ways:

- If the workspace already added you by name, ask its owner or an admin for an invitation code for that person, and join with it.
- Otherwise, ask to join with the workspace's ID, as a new person.

## Join with an invitation code

1. Paste the code into "Invitation code". A code starts with `mmdi_` and has 48 characters. The application takes a code only when you paste it there, never from a link.
2. Choose "Preview". The screen shows the workspace, "You join as" with the name of your person there, "Invited by" with the inviter's name and GitHub login, and "Valid until".
3. Check the inviter's GitHub login, not only the name.
4. Choose "Join the workspace". The application tells you what joining does and asks first. Choose "Join", or "Back" to keep the code and look again.

When you join:

- you claim that person and become a member of the workspace;
- everyone in the workspace sees your GitHub login next to the name;
- the owner and the admins see your GitHub login and the creation date of your GitHub account;
- the code stops working.

The screen then says "You joined the workspace.", and offers "Open this workspace" while the workspace is not selected.

"Cancel" clears the code. If joining is refused, paste the code again to try again. A code works once, until the time under "Valid until". If it has expired, ask the person who sent it for a new one.

## Ask to join with a workspace ID

1. Get the workspace's ID from a member of the workspace.
2. Under "Ask to join with a workspace ID", paste it into "Workspace ID".
3. "Your name in the workspace" starts with your account's name. Change it if you like; it has at most 64 characters.
4. Choose "Ask to join".

The owner and the admins of the workspace see the name, your GitHub login, and the creation date of your GitHub account, and decide. Until a request is approved, you see nothing of the workspace. Once it is approved, the workspace appears in your list of workspaces.

Not yet: the application does not show a workspace's ID, so members cannot read it there to pass it on.

### Limits

- You can have one pending request for each workspace. Asking again while one is pending does not make a second one.
- You can have at most 5 pending requests in all, and make at most 10 requests in 24 hours.
- After a denial, you can ask the same workspace again after 24 hours.
- A workspace can pause new requests, or block your account. Your request is then refused.

## Your join requests

"Your join requests" lists your requests. Pending requests come first, under "Pending", and the ended ones follow under "Earlier requests".

Each request shows the name that you asked for, the workspace's ID, when you sent it, and when it expires or how it ended: "Approved", "Denied", "Withdrawn", or "Expired". A request that was blocked shows as "Denied". Once you are a member, the workspace's name shows too.

- A request expires after 7 days if nobody answers it.
- "Withdraw" ends a pending request. The application asks first. You can ask again later, but a new request counts toward your 10 requests in 24 hours.
- "Refresh your join requests" loads the list again.
