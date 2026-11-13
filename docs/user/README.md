# MyManDev user guide

This guide is for people who use the MyManDev desktop application. It describes what the application does today. The application is still in development, so some screens are placeholders, and this guide grows with it.

## Pages

- [Account and devices](account-and-devices.md): signing in with GitHub, renewing the sign-in, signing out, and managing the devices of your account.
- [Workspaces and projects](workspaces-and-projects.md): creating a workspace and a project, and opening them.
- [People and roles](people-and-roles.md): the owner, the admins, and the members, what each may do, handing over the ownership, removing a person, and leaving.
- [Inviting people and answering join requests](inviting-people.md): invitation codes, approving, denying, or blocking a request to join, and checking who joined recently.
- [Joining a workspace](joining-a-workspace.md): joining with an invitation code, and asking to join with a workspace ID.

## The screens

The sidebar on the left lists the screens of the selected workspace: "Home", "Account", "People", "Join", and "About". Below them it lists your workspaces, and the projects of the selected workspace.

- "Home" asks you to sign in while this device is not signed in, and offers to create your first workspace once it is.
- "Account" shows this device and its sign-in, and every device of your account.
- "People" shows the people of the selected workspace, and for the owner and the admins also the recent claims, the open invitations, and the join requests.
- "Join" lets you join a workspace with an invitation code, or ask to join one with its ID.

When you open a project, its screens appear: "Chat", "Tasks", "Decisions", and "Permissions". Only "Chat" has content today.

A project also has a side panel with two tabs. "Agents" lists the project's agents and their runs; there are none yet. "Repositories" lists Git repositories on this computer: "Add a repository" adds one, and the panel shows its branch and its changes. It only reads them, and the list is not kept after the application restarts.

## Keep your GitHub account safe

You sign in to MyManDev with your GitHub account. MyManDev has no password of its own: whoever can sign in to that GitHub account can use your MyManDev account. Turn on two-factor authentication for that GitHub account in GitHub's settings. The "Account" screen shows the same recommendation.

## Not available yet

- Showing a workspace's ID in the application, so that a member can pass it on to someone who wants to ask to join.
- Marking new claims in the sidebar for a workspace that is not selected. Today only the selected workspace's new claims mark the sidebar.
- Agents that run code on your computer.
- The content of "Tasks", "Decisions", and "Permissions".
- Renaming or archiving a workspace or a project, and removing a project.
- Choosing how long an invitation lasts: every invitation lasts 7 days.
