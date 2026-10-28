# Contributing

MyManDev AI Workspace uses small, issue-driven changes and explicit ownership.

Read first:

- CLAUDE.md
- docs/process/OWNERSHIP.md
- docs/process/WORKFLOW.md
- docs/process/ROADMAP.md
- CLA.md

## Branches

develop is the integration branch.
main is the release branch.

Do not implement features directly on develop or main.

Use task branches created from fresh origin/develop.

Allowed branch prefixes:

- feature/
- fix/
- docs/
- chore/
- test/

## Pull requests

One topic per pull request.

Keep changes small enough to review without reconstructing unrelated work.

A pull request should explain:

- What this does
- Why
- What this does not do
- Checks
- Related issue

## Contributor license agreement

MyManDev AI Workspace is licensed under AGPL-3.0-only.
[LEGAL ENTITY NAME] also wants to be able to offer the same code under other terms, for example a commercial license.
That is only possible with permission from everyone who contributed.
The contributor license agreement in CLA.md gives that permission.

Current version: 1.0, published in commit [COMMIT], SHA-256 [SHA-256 OF CLA.md].
Permanent link: https://github.com/MyManDev/mymandev-ai-workspace/blob/[COMMIT]/CLA.md

What the agreement means for you:

- You keep the copyright in your contribution
- You give [LEGAL ENTITY NAME] a permanent license that you cannot revoke, covering your copyright and any of your patents that the contribution uses
- [LEGAL ENTITY NAME] may license your contribution under any terms, including proprietary ones
- [LEGAL ENTITY NAME] may pass these rights on, for example to another company that takes over the project
- Your contribution also stays licensed to the public under AGPL-3.0-only, or under another open source license if the project uses one when you submit your contribution
- You confirm that you have the right to submit your contribution
- You do not have to provide support for your contribution

Who signs:

- Everyone who opens a pull request, is the author or committer of a commit in it, or is named in it as a co-author
- The core team too, on the same terms as everyone else

Only a person signs, for themselves.
Nobody signs for someone else.
A bot or another automated tool never signs and never posts the signing comment.
If a tool helped you with a change, the change is still your contribution and you are responsible for it.

If your employer or a client may own what you write, they must authorize it in writing before you sign.
They either grant the rights in CLA.md themselves, or authorize you to grant them on their behalf.
A permission only to submit is not enough.
Ask at [CONTACT EMAIL ADDRESS] for the authorization form.

If you are under the age of majority where you live, contact [CONTACT EMAIL ADDRESS] before you sign.
Your legal representatives sign a consent form first.

To sign, read CLA.md and post this comment in the conversation of your pull request, from your own GitHub account:

```text
I have read the MyManDev Individual Contributor License Agreement, version 1.0, and I agree to it.
```

Do not post it as a review comment, and do not edit it afterwards.
Instead of the comment, you can sign a copy of CLA.md by hand or with a qualified electronic signature and send it to [CONTACT EMAIL ADDRESS], with the numeric ID of your GitHub account.
Members of the core team sign this way.

You sign once for each version.
Your signature covers your earlier contributions and later ones, until you accept a newer version.
You are asked to sign again only when a new version is published.

After you sign:

1. The Project Manager checks that the comment came from your account.
2. The Project Manager records your signature.
3. The Project Manager runs the `cla` check on your pull request again.

If the check can no longer be run again, for example after 30 days, the Project Manager closes and reopens your pull request, which starts the check again.

The `cla` check fails while anyone who opened the pull request, is the author or committer of a commit in it, or is named in a `Co-authored-by` trailer has not signed.
The check identifies commit authors by the email address in each commit, and it cannot verify that address.
Commit with an email address that is linked to your GitHub account, otherwise the check cannot tell who wrote the commit.
Whoever opens a pull request confirms, under CLA.md Sections 3(e) and 3(f), where its content comes from.

A pull request with a failing `cla` check is not merged.
It stays open, so you can sign at any time.
If it stays unsigned for a long time, the Project Manager may close it.

Third-party code, meaning code that someone else wrote, is added only under [ALLOWED LICENSES, for example MIT, BSD-2-Clause, BSD-3-Clause, Apache-2.0 or ISC].
Submit and mark it as described in CLA.md Section 3(e).
Third-party code under other licenses, including copyleft licenses such as GPL, LGPL, AGPL and MPL, is not added.
Do not copy code from issues or comments of people who have not signed the agreement.

Only your numeric GitHub user ID and the agreement version are published, in `.github/cla/signatures.json`.
That entry stays in the history of the repository and cannot be removed.
Your user name, the date, a link to your comment and a copy of it are kept in a private repository.
CLA.md explains how signature records are handled.

## Commits

Use Conventional Commits.

Examples:

- feat(protocol): define agent run events
- fix(runtime): reject unauthorized repository writes
- docs(workflow): document task handoff
- chore(database): establish migration baseline

Never add AI attribution or AI co-author trailers.

## Git hooks

The hooks in `.githooks/` reject AI Git identities and AI attribution in commit messages.
Enable them once per clone:

```sh
git config core.hooksPath .githooks
```

The Identity Guard workflow runs the same checks on pull requests and on pushes to develop and main.

## Ownership

Ownership means default implementation responsibility and review authority.
It does not mean exclusive access.

The Project Manager may reassign tasks when needed.

## Verification

Every pull request must state what was actually checked.

A focused test may be used during implementation, but it must not be presented as full verification.
