# Inviting people and answering join requests

There are two ways into a workspace:

- **An invitation code.** The owner or an admin first adds the person by name, then creates an invitation code for that person and passes it on. The new member joins with the code and claims that person.
- **A join request.** Someone asks to join with the workspace's ID, as a new person. The owner or an admin approves or denies the request.

Only the owner and the admins see the parts of the "People" screen on this page. For the other side, see [Joining a workspace](joining-a-workspace.md).

## Invite a person

1. Add the person first, if they are not listed yet: choose "Add person" and enter their name (see [People and roles](people-and-roles.md)).
2. Choose "Invite" on the person. They must show "Not claimed yet".
3. Read the question and choose "Create the invitation".
4. The code shows under "Invitation code". Choose "Select the code", and copy it (Ctrl+C, or Command+C on a Mac).
5. Pass the code on privately, only to this person, for example in a direct message. Anyone who has the code can claim this person.
6. Choose "Close".

The code is shown only once. After you close it, it cannot be shown again. If the code is lost, invite the person again: the new invitation revokes the earlier one, and the earlier code stops working.

A code works once, within 7 days. A person has at most one open invitation.

### Open invitations

"Open invitations" lists the invitations that have not been used yet, with the invited person, who created the invitation, and when it expires. "Revoke" ends an invitation at once, after the application asks; the person stays listed as not claimed, and you can invite them again. "Refresh the invitations" loads the list again.

A workspace can have at most 50 open invitations, and at most 100 new invitations in 24 hours. When an admin becomes a member, or a person is removed or leaves, the open invitations that they created are revoked.

## Answer join requests

"Join requests" lists the pending requests. Each shows the name that the person asked for, their GitHub login, when their GitHub account was created, and when the request expires. Check the login and the date of the GitHub account, not only the name.

For each request:

- "Approve" adds the person as a member. The question shows "Name in this workspace" with the name they asked for; you can change it.
- "Deny" ends the request. They can ask again after 24 hours.
- "Block" denies the request, and keeps this account from asking again until you unblock it.
- "Deny and invite instead" is offered while the workspace has people who have not joined yet (see below).

"Deny all" denies every pending request at once. "Refresh the join requests" loads the list again.

A request that nobody answers expires after 7 days.

### Deny and invite instead

Sometimes the person who asks to join is already listed, as someone who has not joined yet. Approving would add them a second time. Choose "Deny and invite instead":

1. Under "Person to invite", choose the person that this account should claim.
2. Choose "Create the invitation, then deny".
3. The invitation code shows once, as for "Invite". Pass it on privately, only to this account.

The request is denied only after the invitation was created. If the invitation cannot be created, the request stays pending. If the invitation was created but the denial failed, the code is still shown once; pass it on, then deny the request on its own. If the chosen person already has an open invitation, it is replaced, and the earlier code stops working.

### Blocked accounts

"Blocked accounts" lists the accounts that the owner or an admin blocked in this workspace. "Unblock" lets the account ask to join again at once. The application asks first.

### Pause new requests

The line above the requests says whether new requests are accepted. "Pause new requests" stops new requests; the pending ones stay open. "Accept new requests again" ends the pause.

## Recent claims

When someone joins, with an invitation code or through a join request, they claim a person. The owner and the admins see these claims under "Recent claims", near the top of the "People" screen, above the list of people, the most recent first.

Each claim shows the person's name, the GitHub login of the account that joined, when that GitHub account was created, whether it "Joined with an invitation" or "Joined through a join request", and when. A person who was removed or left since shows "(former member)".

Check each GitHub login and the creation date of its account, not only the name. If someone should not be there, choose "Remove" on the claim. It asks the same question as "Remove" in the list of people, and it is offered only where that list offers it: an admin can remove only members.

### New claims

- A claim that you have not seen yet is marked "New".
- A claim counts as seen once it was on your screen: at least three quarters of its row in view, while the application's window has the focus and no dialog covers it. It then keeps "New" until you leave the "People" screen.
- Each of your devices remembers on its own which claims it showed you. On a device that has not shown you this workspace's claims before, for example a new device or the first time after you became an admin, every recent claim is marked "New", also older ones. Your own claim is never marked "New".
- While the selected workspace has a claim that you have not seen, the "People" item in the sidebar has a dot. Screen readers read it as "People, new claims".

"Refresh the recent claims" loads the list again. The list holds at most the 50 most recent claims.

Not yet: the sidebar does not mark new claims of a workspace that is not selected.
