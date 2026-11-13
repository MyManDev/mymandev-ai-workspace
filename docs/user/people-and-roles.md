# People and roles

The "People" screen shows the people of the selected workspace.

## The list of people

- The owner comes first, then the admins, the members, and the people who have not joined yet.
- Each person shows their name in this workspace, their role ("Owner", "Admin", or "Member"), and their GitHub login with the date it was last checked. Look at the GitHub login, not only the name: anyone can choose a name.
- A person who has not joined yet shows "Not claimed yet" instead of a login.
- Your own person has "(you)" after the name.
- People who were removed or left are listed under "Former members".

## People who have not joined yet

The owner and the admins can add a person by name before that person joins. Choose "Add person" and enter a name of at most 64 characters. The person shows as "Not claimed yet" until someone joins as that person with an invitation code (see [Inviting people](inviting-people.md)). Joining as a person is called claiming it.

On such a person, the owner and the admins have "Rename" and "Remove".

## Roles

Each workspace has exactly one owner. Everyone else is an admin or a member.

| What                                                       | Owner | Admin             | Member            |
| ---------------------------------------------------------- | ----- | ----------------- | ----------------- |
| See the workspace and its people                           | yes   | yes               | yes               |
| Create a project                                           | yes   | yes               | yes               |
| Leave the workspace                                        | no    | yes               | yes               |
| Add, rename, and remove people who have not joined yet     | yes   | yes               | no                |
| Invite people, and see and revoke the open invitations     | yes   | yes               | no                |
| Approve, deny, and block join requests, and pause new ones | yes   | yes               | no                |
| See the recent claims                                      | yes   | yes               | no                |
| Remove a person who has joined                             | yes   | only members      | no                |
| Make a member an admin, make an admin a member             | yes   | no                | no                |
| Offer the ownership to someone                             | yes   | no                | no                |
| Accept an ownership offer                                  | no    | if it is for them | if it is for them |

The screen offers only the actions that your role allows.

If you are the owner and no one else is an admin, the screen suggests making someone you trust an admin, so that they can also invite people and answer join requests.

"Make admin" and "Offer ownership" work only from a device that was registered at least 72 hours ago.

## Hand over the ownership

1. The owner chooses "Offer ownership" on a person who has joined, and confirms.
2. The person sees "You are offered the ownership of this workspace until" a date, with "Accept the ownership".
3. If they accept within 7 days, they become the owner, and the former owner becomes an admin.

Until then, the owner can choose "Withdraw the offer". Only one offer can be open at a time.

## Remove a person

Choose "Remove" on the person, then confirm.

- A person who has joined loses access to the workspace at once. Their agents in its projects are disabled, the permissions on them are revoked, their unfinished runs are cancelled, and the invitations that they created and that are still open are revoked.
- A person who has not joined yet can no longer be claimed, and their invitation stops working.

Removed people are listed under "Former members". Nothing they wrote is deleted. To come back, they join again as a new person.

## Leave a workspace

Admins and members can choose "Leave this workspace", then confirm. You lose access to the workspace and its projects at once. The owner cannot leave; hand over the ownership first.

## Not available yet

Changing your own name in a workspace.
