# Contributing

MyManDev AI Workspace uses small, issue-driven changes and explicit ownership.

Read first:

- CLAUDE.md
- docs/process/OWNERSHIP.md
- docs/process/WORKFLOW.md
- docs/process/ROADMAP.md
- CLA.md
- CLA-ENTITY.md

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
[LEGAL ENTITY NAME] also wants to be able to offer the same code under other terms, for example a commercial or proprietary license.
That is only possible with permission from everyone who contributed.
The contributor license agreement in CLA.md gives that permission.

CLA.md is the Harmony Individual Contributor License Agreement (HA-CLA-I) v1.0 with outbound license Option Five.
CLA-ENTITY.md, the entity version for employers and other organizations, is the Harmony Entity Contributor License Agreement (HA-CLA-E) v1.0 with outbound license Option Five.
In both, only the fill-ins and options of the template are completed; the rest of the text is unchanged.
Both link to the headings "Contributor license agreement" and "Third-party work" in this file, so do not rename them.

The agreement is not in effect yet, and nobody can sign it yet.
It takes effect only when all of these are done:

- [LEGAL ENTITY NAME], the company that will offer the commercial licenses, has been founded
- Every placeholder in square brackets, in CLA.md, in CLA-ENTITY.md and in this section, is filled in, including the version details below
- The links in CLA.md and CLA-ENTITY.md point to the commit of the version instead of `develop`, so that the instructions a contributor agrees to cannot change afterwards
- The draft notices at the top of CLA.md and CLA-ENTITY.md are removed

Text in square brackets, such as [LEGAL ENTITY NAME], is a placeholder.

Current version: 1.0, in effect from [DATE THIS VERSION TAKES EFFECT], published in commit [COMMIT], SHA-256 [SHA-256 OF CLA.md] for CLA.md and [SHA-256 OF CLA-ENTITY.md] for CLA-ENTITY.md.
Permanent links: https://github.com/MyManDev/mymandev-ai-workspace/blob/[COMMIT]/CLA.md and https://github.com/MyManDev/mymandev-ai-workspace/blob/[COMMIT]/CLA-ENTITY.md
The version number counts the versions of CLA.md and CLA-ENTITY.md in this repository, not the versions of the Harmony templates.

What the agreement means for you:

- You keep the copyright in your contribution
- You give [LEGAL ENTITY NAME] a permanent license that you cannot revoke, covering your copyright and any of your patents that the contribution uses
- [LEGAL ENTITY NAME] may license your contribution under any terms, including proprietary ones
- [LEGAL ENTITY NAME] may pass these rights on, for example to another company that takes over the project
- When [LEGAL ENTITY NAME] licenses your contribution under other terms, it must also license it under the license or licenses it uses for the project on the date you submit your contribution. Today the project is licensed under AGPL-3.0-only
- You confirm that you have the right to submit your contribution
- As far as the law allows, you waive your moral rights in the contribution and do not assert them against [LEGAL ENTITY NAME] or its licensees
- You give your contribution as is: apart from the confirmations in Section 3, you give no warranty, and you are not liable for indirect or consequential damages

Who signs:

- Everyone who opens a pull request, is the author or committer of a commit in it, or is named in it as a co-author
- The core team too, on the same terms as everyone else

Each contributor signs personally.
Nobody signs in a contributor's place; parents or a guardian of a contributor under eighteen sign together with the contributor, not instead of them.
A bot or another automated tool never signs and never posts the signing comment.
If a tool helped you with a change, the change is still your contribution and you are responsible for it.

Your contribution must not conflict with rights you have granted to anyone else, including your employer or a client.
If you are an employee, your employer must approve the agreement before you sign, or sign the entity version of the agreement.
Your employer does this by signing CLA-ENTITY.md, as described in [How to sign](#how-to-sign).
You still sign CLA.md yourself.

If you are under eighteen, your parents or guardian must sign the agreement too.
Sign a copy of CLA.md together with them, as described in [How to sign](#how-to-sign), instead of posting the comment.

### How to sign

CLA.md asks you to sign the agreement and send it to [LEGAL ENTITY NAME] following these instructions.
Read CLA.md first, then sign it in one of two ways.

By comment: post this comment in the conversation of your pull request, from your own GitHub account, the one you use to submit contributions:

```text
I have read the Harmony Individual Contributor License Agreement in CLA.md, MyManDev version 1.0, and I agree to it.
```

Post the sentence unchanged.
Do not post it as a review comment, and do not edit it afterwards.

By signed document: sign a copy of the current version of CLA.md by hand or with a qualified electronic signature, with your name and address under "You".
If you are under eighteen, your parents or guardian add their names, addresses and signatures below yours.
Send it to [CONTACT EMAIL ADDRESS], with the numeric ID of your GitHub account.
Members of the core team sign this way.

An employer or another organization signs the entity version only by signed document: a person who may sign for it signs a copy of the current version of CLA-ENTITY.md by hand or with a qualified electronic signature, with their name, title and address under "You".
The organization sends it to [CONTACT EMAIL ADDRESS], with the numeric GitHub IDs of the people who contribute on its behalf, and tells [CONTACT EMAIL ADDRESS] when that list changes.

Your signature is recorded with your numeric GitHub user ID, your GitHub user name at that time, the version you signed, the date and time, and a link to your comment or a copy of your signed document.
[Signature records](#signature-records) says which parts of the record are public.

You sign once for each version.
You are asked to sign again only when a new version is published.

After you sign:

1. The Project Manager checks that the comment came from your account.
2. The Project Manager records your signature.
3. The Project Manager runs the `cla` check on your pull request again.

If the check can no longer be run again, for example after 30 days, the Project Manager closes and reopens your pull request, which starts the check again.

The `cla` check fails while anyone who opened the pull request, is the author or committer of a commit in it, or is named in a `Co-authored-by` trailer has not signed.
The check identifies commit authors by the email address in each commit, and it cannot verify that address.
Commit with an email address that is linked to your GitHub account, otherwise the check cannot tell who wrote the commit.
Everyone who signs confirms, in CLA.md Section 3, that they have the rights needed for what they submit, and that they followed [Third-party work](#third-party-work) for anything they do not own.

A pull request with a failing `cla` check is not merged.
It stays open, so you can sign at any time.
If it stays unsigned for a long time, the Project Manager may close it.

### Third-party work

CLA.md links here for anything you submit that you do not fully own, such as code, documentation or images that someone else created.
The agreement grants no rights in such work; it stays under its own license.

- Submit it separately from your own work, for example in its own commit
- Name its source, its license, and any other restriction you know of
- Mark it clearly, for example with "Submitted on behalf of a third party:" followed by the name of the owner

Third-party code, meaning code that someone else wrote, is added only under [ALLOWED LICENSES, for example MIT, BSD-2-Clause, BSD-3-Clause, Apache-2.0 or ISC].
Third-party code under other licenses, including copyleft licenses such as GPL, LGPL, AGPL and MPL, is not added.
Do not copy code from issues or comments of people who have not signed the agreement.

### Signature records

Only your numeric GitHub user ID and the version you signed are published; everything else is kept private.

The following is information under data protection law.
It is not part of the agreement.

- Controller: [LEGAL ENTITY NAME], [REGISTERED ADDRESS], [CONTACT EMAIL ADDRESS]
- Data: your numeric GitHub user ID, your GitHub user name at the time you signed, the version you signed, the date and time, and either a link to your comment with a copy of its text, timestamps and author fields, or your signed document with the names, addresses and signatures in it, including those of your parents or guardian if you are under eighteen, and your employer's approval or entity agreement if there is one
- Purpose: to document which rights [LEGAL ENTITY NAME] holds in each contribution, and to check pull requests before they are merged
- Legal basis: [TO BE SET WHEN THE COMPANY EXISTS, for example Article 6(1)(b) GDPR for the private records, and Article 6(1)(f) GDPR, with a documented balancing of interests, for the public register]
- Required: you must sign the agreement before your pull request can be merged. Without a record of your signature, it cannot be merged
- Public register: only your numeric GitHub user ID and the version you signed are published, in `.github/cla/signatures.json` in this repository. Entries in the public register stay in the history of this repository and in every copy of it, and cannot be removed from them. That is why the register contains nothing else
- Private records: all other data is kept in a private repository that only [AUTHORIZED PERSONS, BY ROLE] can access
- Recipients: GitHub, Inc. hosts the public register and the private records. Anyone can read the public register
- Transfer to a third country: GitHub, Inc. may process the data in the United States. Safeguard: [EU-US DATA PRIVACY FRAMEWORK ADEQUACY DECISION OR STANDARD CONTRACTUAL CLAUSES, TO BE SET WHEN THE COMPANY EXISTS]
- Retention: as long as [LEGAL ENTITY NAME] distributes material that contains your contributions, and afterwards as long as legal claims about them are possible
- Your rights: you may ask for access, correction, restriction, or erasure, and [RIGHT TO OBJECT UNDER ARTICLE 21 GDPR OR RIGHT TO DATA PORTABILITY UNDER ARTICLE 20 GDPR, DEPENDING ON THE LEGAL BASIS]. You may complain to a data protection supervisory authority. [LEGAL ENTITY NAME] may keep records that are needed to establish, exercise, or defend legal claims (Article 17(3)(e) GDPR). Entries in the public register cannot be erased from the history of this repository

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
